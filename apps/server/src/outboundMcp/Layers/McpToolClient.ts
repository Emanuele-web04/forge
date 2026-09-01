import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthDiscoveryState,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../../package.json" with { type: "json" };
import type { OutboundMcpCredentialRecord } from "../Services/OutboundMcpCredentials.ts";
import {
  OutboundMcpCredentials,
  type OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";
import {
  McpToolClient,
  McpToolClientError,
  type McpToolClientShape,
} from "../Services/McpToolClient.ts";
import {
  OutboundMcpRepository,
  type OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";
import type { McpConsumerBinding, McpConsumerOperation } from "../consumerBinding.ts";
import {
  validateOutboundMcpAuthorizationServerUrl,
  validateOutboundMcpAuthorizationUrl,
  validateOutboundMcpOAuthDiscoveryState,
} from "../oauthMetadataPolicy.ts";
import {
  OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
  type OutboundMcpAddressResolver,
  isOAuthRefreshRequest,
  makeBoundedMcpFetch,
  makeSingleFlightRefreshFetch,
  validateOutboundMcpUrl,
} from "../networkPolicy.ts";
import { makeOAuthClientProvider } from "../oauthProvider.ts";

const OUTBOUND_MCP_CALL_PERMITS = 6;
const OUTBOUND_MCP_MAX_CATALOG_PAGES = 20;
const OUTBOUND_MCP_MAX_CATALOG_TOOLS = 1_024;

export type McpResolvedConnection = {
  readonly connectionId: string;
  readonly presetId: string;
  readonly endpoint: URL;
};

export type McpToolDescriptor = {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
};

export interface McpToolSession {
  readonly listTools: (signal: AbortSignal) => Promise<ReadonlyArray<McpToolDescriptor>>;
  readonly callTool: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export type McpToolSessionHooks = {
  readonly onAuthInvalidated: () => Promise<void>;
  readonly onDisconnect: () => void;
};

export type McpToolClientOptions<Connection extends McpResolvedConnection> = {
  readonly resolveConnection: <Operation extends string>(
    binding: McpConsumerBinding<Operation>,
  ) => Promise<Connection>;
  readonly createSession: (
    connection: Connection,
    signal: AbortSignal,
    hooks: McpToolSessionHooks,
  ) => Promise<McpToolSession>;
};

type SessionEntry = {
  readonly token: symbol;
  readonly session: McpToolSession;
};

type ConnectionFlight = {
  readonly token: symbol;
  readonly controller: AbortController;
  readonly promise: Promise<McpToolSession>;
};

class McpSessionAuthInvalidatedError extends Error {}

function abortedError(): DOMException {
  return new DOMException("Outbound MCP operation aborted.", "AbortError");
}

function clientError(input: {
  readonly category: string;
  readonly consumerId: string;
  readonly connectionId?: string;
}): McpToolClientError {
  return new McpToolClientError(input);
}

function validateBinding<Operation extends string>(binding: McpConsumerBinding<Operation>): void {
  if (binding.id.trim() === "" || binding.presetIds.size === 0) {
    throw clientError({ category: "invalid-binding", consumerId: binding.id });
  }
  const allowed = new Set(binding.requiredTools);
  for (const tool of binding.optionalTools) {
    if (allowed.has(tool)) {
      throw clientError({ category: "invalid-binding", consumerId: binding.id });
    }
    allowed.add(tool);
  }

  const operationTools = new Set<string>();
  for (const operation of Object.values<McpConsumerOperation>(binding.operations)) {
    if (
      operation.tool.trim() === "" ||
      typeof operation.encode !== "function" ||
      typeof operation.decode !== "function" ||
      !allowed.has(operation.tool) ||
      operationTools.has(operation.tool)
    ) {
      throw clientError({ category: "invalid-binding", consumerId: binding.id });
    }
    operationTools.add(operation.tool);
  }
}

function operationForTool<Operation extends string>(
  binding: McpConsumerBinding<Operation>,
  tool: string,
): readonly [Operation, McpConsumerOperation] | null {
  for (const [operation, descriptor] of Object.entries<McpConsumerOperation>(binding.operations)) {
    if (descriptor.tool === tool) return [operation as Operation, descriptor] as const;
  }
  return null;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStable(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function catalogFingerprint(tools: ReadonlyArray<McpToolDescriptor>): string {
  const stableCatalog = [...tools]
    .sort((left, right) => compareStable(left.name, right.name))
    .map((tool) => ({
      name: tool.name,
      inputSchema: canonicalize(tool.inputSchema),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: canonicalize(tool.outputSchema) }),
    }));
  return createHash("sha256").update(JSON.stringify(stableCatalog)).digest("hex");
}

function awaitWithSignal<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function makeMcpToolClient<Connection extends McpResolvedConnection>(
  options: McpToolClientOptions<Connection>,
): McpToolClientShape {
  const sessions = new Map<string, SessionEntry>();
  const connectionFlights = new Map<string, ConnectionFlight>();
  const callPermits = new Map<string, Semaphore.Semaphore>();

  const removeDisconnected = (connectionId: string, token: symbol): void => {
    if (sessions.get(connectionId)?.token === token) {
      sessions.delete(connectionId);
      callPermits.delete(connectionId);
    }
  };

  const disposeConnection = async (
    connectionId: string,
    options?: { readonly waitForConnectingSession?: boolean },
  ): Promise<void> => {
    const flight = connectionFlights.get(connectionId);
    if (flight !== undefined) {
      connectionFlights.delete(connectionId);
      flight.controller.abort(
        new DOMException("Outbound MCP connection invalidated.", "AbortError"),
      );
    }
    const entry = sessions.get(connectionId);
    sessions.delete(connectionId);
    callPermits.delete(connectionId);
    if (entry !== undefined) await entry.session.close().catch(() => undefined);
    if (options?.waitForConnectingSession !== false && flight !== undefined) {
      await flight.promise.catch(() => undefined);
    }
  };

  const getSession = async (
    connection: Connection,
    callerSignal: AbortSignal,
  ): Promise<McpToolSession> => {
    const current = sessions.get(connection.connectionId);
    if (current !== undefined) return current.session;

    let flight = connectionFlights.get(connection.connectionId);
    if (flight === undefined) {
      const token = Symbol(connection.connectionId);
      const controller = new AbortController();
      const promise = options
        .createSession(connection, controller.signal, {
          onAuthInvalidated: () =>
            disposeConnection(connection.connectionId, {
              waitForConnectingSession: false,
            }),
          onDisconnect: () => removeDisconnected(connection.connectionId, token),
        })
        .then(async (session) => {
          if (
            controller.signal.aborted ||
            connectionFlights.get(connection.connectionId)?.token !== token
          ) {
            await session.close().catch(() => undefined);
            throw abortedError();
          }
          sessions.set(connection.connectionId, { token, session });
          return session;
        })
        .finally(() => {
          if (connectionFlights.get(connection.connectionId)?.token === token) {
            connectionFlights.delete(connection.connectionId);
          }
        });
      flight = { token, controller, promise };
      connectionFlights.set(connection.connectionId, flight);
    }
    return awaitWithSignal(flight.promise, callerSignal);
  };

  const resolve = <Operation extends string>(binding: McpConsumerBinding<Operation>) =>
    Effect.tryPromise({
      try: () => options.resolveConnection(binding),
      catch: (error) =>
        error instanceof McpToolClientError
          ? error
          : clientError({ category: "connection", consumerId: binding.id }),
    });

  const validate: McpToolClientShape["validate"] = (binding, signal) => {
    const ownedController = signal === undefined ? new AbortController() : null;
    const validationSignal = signal ?? ownedController!.signal;
    const validation = Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateBinding(binding),
        catch: (error) =>
          error instanceof McpToolClientError
            ? error
            : clientError({ category: "invalid-binding", consumerId: binding.id }),
      });
      const connection = yield* resolve(binding);
      const session = yield* Effect.tryPromise({
        try: () => getSession(connection, validationSignal),
        catch: (error) =>
          clientError({
            category:
              error instanceof McpSessionAuthInvalidatedError ? "authentication" : "connection",
            consumerId: binding.id,
            connectionId: connection.connectionId,
          }),
      });
      const tools = yield* Effect.tryPromise({
        try: () => session.listTools(validationSignal),
        catch: (error) =>
          clientError({
            category:
              error instanceof McpSessionAuthInvalidatedError ? "authentication" : "catalog",
            consumerId: binding.id,
            connectionId: connection.connectionId,
          }),
      });
      const names = new Set<string>();
      for (const tool of tools) {
        if (names.has(tool.name)) {
          return yield* Effect.fail(
            clientError({
              category: "invalid-catalog",
              consumerId: binding.id,
              connectionId: connection.connectionId,
            }),
          );
        }
        names.add(tool.name);
      }
      for (const requiredTool of binding.requiredTools) {
        if (!names.has(requiredTool)) {
          return yield* Effect.fail(
            clientError({
              category: "missing-required-tool",
              consumerId: binding.id,
              connectionId: connection.connectionId,
            }),
          );
        }
      }
      return catalogFingerprint(tools);
    });
    return ownedController === null
      ? validation
      : validation.pipe(Effect.onInterrupt(() => Effect.sync(() => ownedController.abort())));
  };

  const call: McpToolClientShape["call"] = (binding, tool, args, signal) => {
    const operation = operationForTool(binding, tool);
    if (operation === null) {
      return Effect.fail(clientError({ category: "tool-not-allowed", consumerId: binding.id }));
    }

    return Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateBinding(binding),
        catch: (error) =>
          error instanceof McpToolClientError
            ? error
            : clientError({ category: "invalid-binding", consumerId: binding.id }),
      });
      const encodedArgs = yield* operation[1].encode(args);
      const connection = yield* resolve(binding);
      const session = yield* Effect.tryPromise({
        try: () => getSession(connection, signal),
        catch: (error) =>
          signal.aborted
            ? abortedError()
            : clientError({
                category:
                  error instanceof McpSessionAuthInvalidatedError ? "authentication" : "connection",
                consumerId: binding.id,
                connectionId: connection.connectionId,
              }),
      });
      let permits = callPermits.get(connection.connectionId);
      if (permits === undefined) {
        permits = Semaphore.makeUnsafe(OUTBOUND_MCP_CALL_PERMITS);
        callPermits.set(connection.connectionId, permits);
      }
      const result = yield* permits.withPermits(1)(
        Effect.tryPromise({
          try: () => session.callTool(tool, encodedArgs, signal),
          catch: (error) => {
            if (signal.aborted) return abortedError();
            return clientError({
              category:
                error instanceof McpSessionAuthInvalidatedError ? "authentication" : "tool-call",
              consumerId: binding.id,
              connectionId: connection.connectionId,
            });
          },
        }),
      );
      return yield* operation[1].decode(result);
    });
  };

  const invalidate: McpToolClientShape["invalidate"] = (connectionId) =>
    Effect.promise(() => disposeConnection(connectionId)).pipe(Effect.orDie);

  const closeAll: McpToolClientShape["closeAll"] = () =>
    Effect.promise(async () => {
      const connectionIds = new Set([...sessions.keys(), ...connectionFlights.keys()]);
      await Promise.all([...connectionIds].map(disposeConnection));
    }).pipe(Effect.orDie);

  return { validate, call, invalidate, closeAll };
}

type LiveResolvedConnection = McpResolvedConnection & {
  readonly credentials: OutboundMcpCredentialRecord;
};

const ESTABLISHED_CLIENT_METADATA: OAuthClientMetadata = {
  client_name: "Synara",
  redirect_uris: ["http://127.0.0.1/"],
};

function establishedOAuthProvider(input: {
  readonly connection: LiveResolvedConnection;
  readonly credentials: OutboundMcpCredentials["Service"];
  readonly onInvalidated: () => Promise<void>;
}): OAuthClientProvider {
  let current = input.connection.credentials;
  if (current.authorizationServerUrl === undefined) {
    throw new Error("Established OAuth session has no pinned authorization server.");
  }
  const pinnedAuthorizationServerUrl = validateOutboundMcpAuthorizationServerUrl(
    current.authorizationServerUrl,
  );
  let validatedDiscoveryState: OAuthDiscoveryState | undefined;

  const writeCurrent = async (next: OutboundMcpCredentialRecord): Promise<void> => {
    await Effect.runPromise(input.credentials.write(input.connection.connectionId, next));
    current = next;
  };

  const provider = makeOAuthClientProvider({
    redirectUrl: new URL("http://127.0.0.1/"),
    clientMetadata: ESTABLISHED_CLIENT_METADATA,
    state: "established-session",
    credentials: {
      clientInformation: () => current.clientInformation,
      saveClientInformation: (clientInformation) => writeCurrent({ ...current, clientInformation }),
      tokens: () => current.tokens,
      saveTokens: (tokens) => writeCurrent({ ...current, tokens }),
      invalidate: async (scope) => {
        if (scope === "all") {
          await Effect.runPromise(input.credentials.delete(input.connection.connectionId));
          current = {};
        } else if (scope === "tokens") {
          const { tokens: _tokens, ...withoutTokens } = current;
          await writeCurrent(withoutTokens);
        } else if (scope === "client") {
          const { clientInformation: _clientInformation, ...withoutClient } = current;
          await writeCurrent(withoutClient);
        } else if (scope === "discovery") {
          const { authorizationServerUrl: _authorizationServerUrl, ...withoutDiscovery } = current;
          await writeCurrent(withoutDiscovery);
        }
        await input.onInvalidated();
      },
    },
    attempt: {
      saveCodeVerifier: () => {
        throw new Error("Interactive authorization is unavailable for an established session.");
      },
      codeVerifier: () => {
        throw new Error("Interactive authorization is unavailable for an established session.");
      },
    },
    captureAuthorizationUrl: () => {
      throw new Error("Interactive authorization is unavailable for an established session.");
    },
    validateResource: async (serverUrl, resource) => {
      const configured = validateOutboundMcpUrl(new URL(input.connection.endpoint), "resource");
      const server = validateOutboundMcpUrl(new URL(serverUrl), "resource");
      const selected = validateOutboundMcpUrl(
        resource === undefined ? configured : new URL(resource),
        "resource",
      );
      if (server.origin !== configured.origin || selected.origin !== configured.origin) {
        throw new Error("OAuth resource origin does not match the configured MCP resource.");
      }
      return selected;
    },
  });
  return {
    ...provider,
    discoveryState: () =>
      validatedDiscoveryState ?? { authorizationServerUrl: pinnedAuthorizationServerUrl },
    saveDiscoveryState: async (state) => {
      const validated = validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl,
        state,
      });
      validatedDiscoveryState = validated;
      await writeCurrent({
        ...current,
        authorizationServerUrl: validated.authorizationServerUrl,
      });
    },
    redirectToAuthorization: (url) => {
      if (validatedDiscoveryState !== undefined) {
        validateOutboundMcpAuthorizationUrl({
          state: validatedDiscoveryState,
          authorizationUrl: url,
        });
      }
      throw new Error("Interactive authorization is unavailable for an established session.");
    },
  };
}

function isUnrecoverableAuthError(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
  );
}

export type McpSdkRequestFetchContext = {
  readonly fetch: FetchLike;
  readonly run: <A>(signal: AbortSignal, request: () => Promise<A>) => Promise<A>;
};

/**
 * The SDK does not pass RequestOptions.signal to Streamable HTTP fetches. Carry
 * it through async request context instead, while preserving the transport's
 * shared controller and keeping coalesced refreshes independent of one caller.
 */
export function makeMcpSdkRequestFetchContext(fetchFn: FetchLike): McpSdkRequestFetchContext {
  const signalContext = new AsyncLocalStorage<AbortSignal>();

  return {
    fetch: (url, init) => {
      const requestSignal = signalContext.getStore();
      if (requestSignal === undefined || isOAuthRefreshRequest(init)) {
        return fetchFn(url, init);
      }
      const transportSignal = init?.signal;
      const signal =
        transportSignal === undefined || transportSignal === null
          ? requestSignal
          : AbortSignal.any([transportSignal, requestSignal]);
      return fetchFn(url, { ...init, signal });
    },
    run: (requestSignal, request) => signalContext.run(requestSignal, request),
  };
}

async function createLiveSession(
  connection: LiveResolvedConnection,
  signal: AbortSignal,
  hooks: McpToolSessionHooks,
  credentials: OutboundMcpCredentialsShape,
  fetchFn?: FetchLike,
  resolveAddresses?: OutboundMcpAddressResolver,
): Promise<McpToolSession> {
  let authInvalidated = false;
  const boundedFetch = makeSingleFlightRefreshFetch(
    makeBoundedMcpFetch({
      resourceUrl: connection.endpoint,
      ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
      ...(resolveAddresses === undefined ? {} : { resolveAddresses }),
    }),
  );
  const requestFetch = makeMcpSdkRequestFetchContext(boundedFetch);
  const authProvider = establishedOAuthProvider({
    connection,
    credentials,
    onInvalidated: async () => {
      authInvalidated = true;
      await hooks.onAuthInvalidated();
    },
  });
  const transport = new StreamableHTTPClientTransport(connection.endpoint, {
    authProvider,
    fetch: requestFetch.fetch,
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 2,
    },
  });
  const client = new Client({ name: "synara", version: packageJson.version }, { capabilities: {} });
  client.onclose = hooks.onDisconnect;

  try {
    await requestFetch.run(signal, () =>
      client.connect(transport, {
        signal,
        timeout: OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
        maxTotalTimeout: OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    if (authInvalidated) throw new McpSessionAuthInvalidatedError();
    if (isUnrecoverableAuthError(error)) {
      await hooks.onAuthInvalidated();
      throw new McpSessionAuthInvalidatedError();
    }
    throw error;
  }

  return {
    listTools: async (requestSignal) => {
      const tools: McpToolDescriptor[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < OUTBOUND_MCP_MAX_CATALOG_PAGES; page += 1) {
        let result;
        try {
          result = await requestFetch.run(requestSignal, () =>
            client.listTools(cursor === undefined ? undefined : { cursor }, {
              signal: requestSignal,
              timeout: OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
              maxTotalTimeout: OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
            }),
          );
        } catch (error) {
          if (authInvalidated) throw new McpSessionAuthInvalidatedError();
          if (isUnrecoverableAuthError(error)) {
            await hooks.onAuthInvalidated();
            throw new McpSessionAuthInvalidatedError();
          }
          throw error;
        }
        tools.push(...result.tools);
        if (tools.length > OUTBOUND_MCP_MAX_CATALOG_TOOLS) {
          throw new Error("Outbound MCP tool catalog exceeds the bounded tool count.");
        }
        cursor = result.nextCursor;
        if (cursor === undefined) return tools;
      }
      throw new Error("Outbound MCP tool catalog exceeds the bounded page count.");
    },
    callTool: async (tool, args, requestSignal) => {
      try {
        return await requestFetch.run(requestSignal, () =>
          client.callTool({ name: tool, arguments: { ...args } }, undefined, {
            signal: requestSignal,
            timeout: OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
            maxTotalTimeout: OUTBOUND_MCP_REQUEST_TIMEOUT_MS,
          }),
        );
      } catch (error) {
        if (authInvalidated) throw new McpSessionAuthInvalidatedError();
        if (isUnrecoverableAuthError(error)) {
          await hooks.onAuthInvalidated();
          throw new McpSessionAuthInvalidatedError();
        }
        throw error;
      }
    },
    close: () => client.close(),
  };
}

export function makeLiveMcpToolClient(options: {
  readonly repository: OutboundMcpRepositoryShape;
  readonly credentials: OutboundMcpCredentialsShape;
  readonly fetch?: FetchLike;
  readonly resolveAddresses?: OutboundMcpAddressResolver;
}): McpToolClientShape {
  return makeMcpToolClient<LiveResolvedConnection>({
    resolveConnection: async (binding) => {
      const records = await Effect.runPromise(options.repository.list());
      const matching = records.filter((record) => binding.presetIds.has(record.presetId));
      if (matching.length !== 1) {
        throw clientError({ category: "connection-selection", consumerId: binding.id });
      }
      const record = matching[0]!;
      if (record.status !== "connected") {
        throw clientError({ category: "connection-status", consumerId: binding.id });
      }
      const credentialRecord = await Effect.runPromise(
        options.credentials.read(record.connectionId),
      );
      if (
        credentialRecord?.tokens === undefined ||
        credentialRecord.clientInformation === undefined ||
        credentialRecord.authorizationServerUrl === undefined
      ) {
        throw clientError({
          category: "credentials",
          consumerId: binding.id,
          connectionId: record.connectionId,
        });
      }
      return {
        connectionId: record.connectionId,
        presetId: record.presetId,
        endpoint: validateOutboundMcpUrl(new URL(record.endpoint), "resource"),
        credentials: {
          ...credentialRecord,
          authorizationServerUrl: validateOutboundMcpAuthorizationServerUrl(
            credentialRecord.authorizationServerUrl,
          ),
        },
      };
    },
    createSession: (connection, signal, hooks) =>
      createLiveSession(
        connection,
        signal,
        hooks,
        options.credentials,
        options.fetch,
        options.resolveAddresses,
      ),
  });
}

const makeMcpToolClientLive = Effect.gen(function* () {
  const repository = yield* OutboundMcpRepository;
  const credentials = yield* OutboundMcpCredentials;
  const client = makeLiveMcpToolClient({ repository, credentials });
  yield* Effect.addFinalizer(() => client.closeAll());
  return client;
});

export const McpToolClientLive = Layer.effect(McpToolClient, makeMcpToolClientLive);
