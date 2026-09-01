import { Buffer } from "node:buffer";

import {
  auth,
  discoverOAuthServerInfo,
  selectClientAuthMethod,
  type AuthResult,
  type OAuthClientProvider,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OutboundMcpConnection, OutboundMcpConnectionStatus } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  McpConnectionService,
  McpConnectionServiceError,
  type McpAuthorizationCompletion,
  type McpConnectionEvent,
  type McpConnectionServiceShape,
} from "../Services/McpConnectionService.ts";
import {
  McpToolClient,
  McpToolClientError,
  type McpToolClientShape,
} from "../Services/McpToolClient.ts";
import {
  OutboundMcpCredentials,
  type OutboundMcpCredentialRecord,
  type OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";
import {
  OutboundMcpRepository,
  type OutboundMcpConnectionRecord,
  type OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";
import {
  MAX_AUTHORIZATION_ATTEMPT_TTL_MS,
  makeAuthorizationAttemptRegistry,
  type AuthorizationAttempt,
  type AuthorizationAttemptRegistry,
} from "../authorizationAttempts.ts";
import type { McpConsumerBinding } from "../consumerBinding.ts";
import {
  makeBoundedMcpFetch,
  OutboundMcpNetworkPolicyError,
  validateOutboundMcpUrl,
} from "../networkPolicy.ts";
import { makeOAuthClientProvider } from "../oauthProvider.ts";
import {
  OUTBOUND_MCP_PRESETS,
  type OutboundMcpPreset,
  type OutboundMcpPresetRegistry,
} from "../presets/index.ts";

export class McpConnectionOAuthError extends Schema.TaggedErrorClass<McpConnectionOAuthError>()(
  "McpConnectionOAuthError",
  { category: Schema.String },
) {
  override get message(): string {
    return `Outbound MCP OAuth operation failed (${this.category}).`;
  }
}

type OAuthLifecycleInput = {
  readonly preset: OutboundMcpPreset;
  readonly credentials: OutboundMcpCredentialsShape;
};

export type McpConnectionOAuthLifecycle = {
  readonly begin: (
    input: OAuthLifecycleInput & { readonly attempt: AuthorizationAttempt },
  ) => Effect.Effect<URL, McpConnectionOAuthError>;
  readonly finish: (
    input: OAuthLifecycleInput & {
      readonly attempt: AuthorizationAttempt;
      readonly code: string;
    },
  ) => Effect.Effect<void, McpConnectionOAuthError>;
  readonly revoke: (input: OAuthLifecycleInput) => Effect.Effect<void, McpConnectionOAuthError>;
};

type Authorize = (
  provider: OAuthClientProvider,
  options: Parameters<typeof auth>[1],
) => Promise<AuthResult>;

export type McpConnectionOAuthDependencies = {
  readonly discoverServerInfo?: typeof discoverOAuthServerInfo;
  readonly authorize?: Authorize;
  readonly fetch?: FetchLike;
};

function oauthError(cause: unknown): McpConnectionOAuthError {
  if (cause instanceof McpConnectionOAuthError) return cause;
  if (cause instanceof OutboundMcpNetworkPolicyError) {
    return new McpConnectionOAuthError({ category: "temporarily-unavailable" });
  }
  const name = cause instanceof Error ? cause.constructor.name : "";
  if (
    name === "InvalidGrantError" ||
    name === "InvalidClientError" ||
    name === "UnauthorizedClientError"
  ) {
    return new McpConnectionOAuthError({ category: "credential-revoked" });
  }
  if (
    cause instanceof Error &&
    cause.message.toLowerCase().includes("dynamic client registration")
  ) {
    return new McpConnectionOAuthError({ category: "incompatible-client" });
  }
  return new McpConnectionOAuthError({ category: "temporarily-unavailable" });
}

function withoutTokens(credentials: OutboundMcpCredentialRecord): OutboundMcpCredentialRecord {
  const { tokens: _tokens, ...rest } = credentials;
  return rest;
}

function clientSupportsAuthorization(
  preset: OutboundMcpPreset,
  current: OutboundMcpCredentialRecord,
  serverInfo: OAuthServerInfo,
): boolean {
  const authMethods = serverInfo.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
  const acceptsPublicClients =
    authMethods === undefined || authMethods.length === 0 || authMethods.includes("none");
  if (current.clientInformation !== undefined) {
    return current.clientInformation.client_secret !== undefined || acceptsPublicClients;
  }
  if (preset.publicClientId !== undefined) return acceptsPublicClients;
  return serverInfo.authorizationServerMetadata?.registration_endpoint !== undefined;
}

type ProviderState = {
  readonly provider: OAuthClientProvider;
  readonly authorizationUrl: () => URL | null;
  readonly credentials: () => OutboundMcpCredentialRecord;
};

async function makeAttemptProvider(input: {
  readonly preset: OutboundMcpPreset;
  readonly attempt: AuthorizationAttempt;
  readonly credentialStore: OutboundMcpCredentialsShape;
  readonly initial: OutboundMcpCredentialRecord;
  readonly serverInfo: OAuthServerInfo;
}): Promise<ProviderState> {
  let current = input.initial;
  let capturedAuthorizationUrl: URL | null = null;

  const persist = async (next: OutboundMcpCredentialRecord): Promise<void> => {
    await Effect.runPromise(input.credentialStore.write(input.preset.id, next));
    current = next;
  };

  if (current.clientInformation === undefined && input.preset.publicClientId !== undefined) {
    await persist({
      ...current,
      clientInformation: { client_id: input.preset.publicClientId },
    });
  }
  if (current.authorizationServerUrl !== input.serverInfo.authorizationServerUrl) {
    await persist({
      ...current,
      authorizationServerUrl: input.serverInfo.authorizationServerUrl,
    });
  }

  const providerBase = makeOAuthClientProvider({
    redirectUrl: input.attempt.redirectUrl,
    clientMetadata: {
      ...input.preset.clientMetadata,
      redirect_uris: [input.attempt.redirectUrl.href],
    },
    state: input.attempt.state,
    credentials: {
      clientInformation: () => current.clientInformation,
      saveClientInformation: (clientInformation) => persist({ ...current, clientInformation }),
      tokens: () => current.tokens,
      saveTokens: (tokens) => persist({ ...current, tokens }),
      invalidate: async (scope) => {
        if (scope === "all") {
          await Effect.runPromise(input.credentialStore.delete(input.preset.id));
          current = {};
          return;
        }
        if (scope === "tokens") {
          await persist(withoutTokens(current));
          return;
        }
        if (scope === "client") {
          const { clientInformation: _clientInformation, ...rest } = current;
          await persist(rest);
          return;
        }
        if (scope === "discovery") {
          const { authorizationServerUrl: _authorizationServerUrl, ...rest } = current;
          await persist(rest);
        }
      },
    },
    attempt: {
      saveCodeVerifier: (value) => {
        input.attempt.codeVerifier = value;
      },
      codeVerifier: () => {
        if (input.attempt.codeVerifier === null) {
          throw new McpConnectionOAuthError({ category: "invalid-authorization-attempt" });
        }
        return input.attempt.codeVerifier;
      },
    },
    captureAuthorizationUrl: (url) => {
      capturedAuthorizationUrl = new URL(url);
    },
    validateResource: async (serverUrl, resource) => {
      const configured = validateOutboundMcpUrl(new URL(input.preset.endpoint), "resource");
      const server = validateOutboundMcpUrl(new URL(serverUrl), "resource");
      const selected = validateOutboundMcpUrl(
        resource === undefined ? configured : new URL(resource),
        "resource",
      );
      if (server.origin !== configured.origin || selected.origin !== configured.origin) {
        throw new McpConnectionOAuthError({ category: "invalid-resource" });
      }
      return selected;
    },
  });

  const provider: OAuthClientProvider = {
    ...providerBase,
    discoveryState: () => input.serverInfo,
    saveDiscoveryState: async (state) => {
      validateOutboundMcpUrl(new URL(state.authorizationServerUrl), "authorization");
      await persist({ ...current, authorizationServerUrl: state.authorizationServerUrl });
    },
  };
  return {
    provider,
    authorizationUrl: () => capturedAuthorizationUrl,
    credentials: () => current,
  };
}

function discoveryFor(
  preset: OutboundMcpPreset,
  dependencies: Required<Pick<McpConnectionOAuthDependencies, "discoverServerInfo">> & {
    readonly fetch: FetchLike;
  },
): Promise<OAuthServerInfo> {
  return dependencies.discoverServerInfo(preset.endpoint, {
    fetchFn: makeBoundedMcpFetch({ resourceUrl: preset.endpoint, fetch: dependencies.fetch }),
  });
}

function applyRevocationClientAuthentication(input: {
  readonly client: OAuthClientInformationMixed;
  readonly supportedMethods: ReadonlyArray<string>;
  readonly headers: Headers;
  readonly params: URLSearchParams;
}): void {
  const method = selectClientAuthMethod(input.client, [...input.supportedMethods]);
  if (method === "client_secret_basic" && input.client.client_secret !== undefined) {
    const encoded = Buffer.from(
      `${encodeURIComponent(input.client.client_id)}:${encodeURIComponent(input.client.client_secret)}`,
      "utf8",
    ).toString("base64");
    input.headers.set("authorization", `Basic ${encoded}`);
    return;
  }
  input.params.set("client_id", input.client.client_id);
  if (method === "client_secret_post" && input.client.client_secret !== undefined) {
    input.params.set("client_secret", input.client.client_secret);
  }
}

export function makeSdkMcpConnectionOAuthLifecycle(
  dependencies: McpConnectionOAuthDependencies = {},
): McpConnectionOAuthLifecycle {
  const discoverServerInfo = dependencies.discoverServerInfo ?? discoverOAuthServerInfo;
  const authorize = dependencies.authorize ?? auth;
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const discoveryDependencies = { discoverServerInfo, fetch: fetchFn };

  const begin: McpConnectionOAuthLifecycle["begin"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const stored = (await Effect.runPromise(input.credentials.read(input.preset.id))) ?? {};
        const initial = withoutTokens(stored);
        if (stored.tokens !== undefined) {
          await Effect.runPromise(input.credentials.write(input.preset.id, initial));
        }
        const serverInfo = await discoveryFor(input.preset, discoveryDependencies);
        if (!clientSupportsAuthorization(input.preset, initial, serverInfo)) {
          throw new McpConnectionOAuthError({ category: "incompatible-client" });
        }
        const state = await makeAttemptProvider({
          preset: input.preset,
          attempt: input.attempt,
          credentialStore: input.credentials,
          initial,
          serverInfo,
        });
        const result = await authorize(state.provider, {
          serverUrl: input.preset.endpoint,
          fetchFn: makeBoundedMcpFetch({
            resourceUrl: input.preset.endpoint,
            fetch: fetchFn,
          }),
        });
        const authorizationUrl = state.authorizationUrl();
        if (result !== "REDIRECT" || authorizationUrl === null) {
          throw new McpConnectionOAuthError({ category: "authorization-not-started" });
        }
        return authorizationUrl;
      },
      catch: oauthError,
    });

  const finish: McpConnectionOAuthLifecycle["finish"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (input.attempt.codeVerifier === null) {
          throw new McpConnectionOAuthError({ category: "invalid-authorization-attempt" });
        }
        const initial = (await Effect.runPromise(input.credentials.read(input.preset.id))) ?? {};
        const serverInfo = await discoveryFor(input.preset, discoveryDependencies);
        if (!clientSupportsAuthorization(input.preset, initial, serverInfo)) {
          throw new McpConnectionOAuthError({ category: "incompatible-client" });
        }
        const state = await makeAttemptProvider({
          preset: input.preset,
          attempt: input.attempt,
          credentialStore: input.credentials,
          initial,
          serverInfo,
        });
        const result = await authorize(state.provider, {
          serverUrl: input.preset.endpoint,
          authorizationCode: input.code,
          fetchFn: makeBoundedMcpFetch({
            resourceUrl: input.preset.endpoint,
            fetch: fetchFn,
          }),
        });
        if (result !== "AUTHORIZED" || state.credentials().tokens === undefined) {
          throw new McpConnectionOAuthError({ category: "authorization-incomplete" });
        }
      },
      catch: oauthError,
    });

  const revoke: McpConnectionOAuthLifecycle["revoke"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const stored = await Effect.runPromise(input.credentials.read(input.preset.id));
        const token = stored?.tokens?.refresh_token ?? stored?.tokens?.access_token;
        const client = stored?.clientInformation;
        if (stored === null || token === undefined || client === undefined) return;

        const serverInfo = await discoveryFor(input.preset, discoveryDependencies);
        const metadata = serverInfo.authorizationServerMetadata;
        if (metadata?.revocation_endpoint === undefined) return;

        const revocationUrl = validateOutboundMcpUrl(
          new URL(metadata.revocation_endpoint),
          "authorization",
        );
        const params = new URLSearchParams({
          token,
          token_type_hint:
            stored.tokens?.refresh_token === undefined ? "access_token" : "refresh_token",
        });
        const headers = new Headers({
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        });
        applyRevocationClientAuthentication({
          client,
          supportedMethods: metadata.revocation_endpoint_auth_methods_supported ?? [],
          headers,
          params,
        });
        const response = await makeBoundedMcpFetch({
          resourceUrl: input.preset.endpoint,
          fetch: fetchFn,
        })(revocationUrl, { method: "POST", headers, body: params });
        await response.arrayBuffer();
        if (!response.ok) {
          throw new McpConnectionOAuthError({ category: "revocation-failed" });
        }
      },
      catch: (cause) =>
        cause instanceof McpConnectionOAuthError
          ? cause
          : new McpConnectionOAuthError({ category: "revocation-failed" }),
    });

  return { begin, finish, revoke };
}

export type McpConnectionServiceOptions = {
  readonly repository: OutboundMcpRepositoryShape;
  readonly credentials: OutboundMcpCredentialsShape;
  readonly toolClient: McpToolClientShape;
  readonly oauth: McpConnectionOAuthLifecycle;
  readonly attempts: AuthorizationAttemptRegistry;
  readonly presets: OutboundMcpPresetRegistry;
  readonly callbackUrl: URL;
  readonly now?: () => string;
};

function serviceError(category: string): McpConnectionServiceError {
  return new McpConnectionServiceError({ category });
}

function publicConnection(
  preset: OutboundMcpPreset,
  stored: OutboundMcpConnectionRecord | null,
): OutboundMcpConnection {
  return {
    id: preset.id,
    presetId: preset.id,
    displayName: preset.displayName,
    endpoint: preset.endpoint.href,
    status: stored?.status ?? "disconnected",
    lastValidatedAt: stored?.lastValidatedAt ?? null,
    errorCategory: stored?.errorCategory ?? null,
  };
}

function completionStatus(error: McpConnectionOAuthError): {
  readonly result: McpAuthorizationCompletion;
  readonly status: OutboundMcpConnectionStatus;
  readonly errorCategory: string;
} {
  if (error.category === "incompatible-client") {
    return {
      result: { ok: false, category: "incompatible-client" },
      status: "incompatible",
      errorCategory: "incompatible-client",
    };
  }
  if (error.category === "credential-revoked") {
    return {
      result: { ok: false, category: "reconnect-required" },
      status: "reconnect-required",
      errorCategory: "credential-revoked",
    };
  }
  return {
    result: { ok: false, category: "temporarily-unavailable" },
    status: "temporarily-unavailable",
    errorCategory: "network",
  };
}

function validationFailure(error: unknown): {
  readonly result: McpAuthorizationCompletion;
  readonly status: OutboundMcpConnectionStatus;
  readonly errorCategory: string;
  readonly invalidated: boolean;
} {
  if (
    error instanceof McpToolClientError &&
    (error.category === "missing-required-tool" || error.category === "invalid-catalog")
  ) {
    return {
      result: { ok: false, category: "incompatible-tools" },
      status: "incompatible",
      errorCategory: "incompatible-tools",
      invalidated: false,
    };
  }
  if (error instanceof McpToolClientError && error.category === "authentication") {
    return {
      result: { ok: false, category: "reconnect-required" },
      status: "reconnect-required",
      errorCategory: "credential-revoked",
      invalidated: true,
    };
  }
  return {
    result: { ok: false, category: "temporarily-unavailable" },
    status: "temporarily-unavailable",
    errorCategory: "network",
    invalidated: false,
  };
}

export function makeMcpConnectionService(
  options: McpConnectionServiceOptions,
): McpConnectionServiceShape {
  const listeners = new Set<(event: McpConnectionEvent) => void>();
  const attemptIdByState = new Map<string, string>();
  const now = options.now ?? (() => new Date().toISOString());

  const publish = (event: McpConnectionEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A server-only observer cannot break the connection lifecycle.
      }
    }
  };

  const presetOrFail = (presetId: string) => {
    const preset = options.presets.get(presetId);
    return preset === null ? Effect.fail(serviceError("unknown-preset")) : Effect.succeed(preset);
  };

  const ensureMetadata = (preset: OutboundMcpPreset) =>
    Effect.gen(function* () {
      const current = yield* options.repository.get(preset.id);
      if (current !== null) return current;
      const timestamp = now();
      const record = {
        connectionId: preset.id,
        presetId: preset.id,
        displayName: preset.displayName,
        endpoint: preset.endpoint.href,
        status: "disconnected",
        errorCategory: null,
        catalogFingerprint: null,
        lastValidatedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      } as const;
      yield* options.repository.upsertMetadata(record);
      return record;
    }).pipe(Effect.mapError(() => serviceError("persistence")));

  const setStatus = (input: {
    readonly connectionId: string;
    readonly status: OutboundMcpConnectionStatus;
    readonly errorCategory: string | null;
    readonly catalogFingerprint?: string | null;
    readonly lastValidatedAt?: string | null;
  }) =>
    options.repository
      .setStatus({ ...input, updatedAt: now() })
      .pipe(Effect.mapError(() => serviceError("persistence")));

  const invalidateCredentials = (connectionId: string) =>
    Effect.gen(function* () {
      let deleteFailed = false;
      yield* options.credentials.delete(connectionId).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            deleteFailed = true;
          }),
        ),
      );
      yield* options.toolClient.invalidate(connectionId);
      yield* setStatus({
        connectionId,
        status: "reconnect-required",
        errorCategory: "credential-revoked",
      });
      publish({ connectionId, type: "credentials-invalidated" });
      if (deleteFailed) return yield* Effect.fail(serviceError("credential-cleanup"));
    });

  const list: McpConnectionServiceShape["list"] = () =>
    Effect.forEach(options.presets.all(), (preset) =>
      options.repository
        .get(preset.id)
        .pipe(Effect.map((stored) => publicConnection(preset, stored))),
    ).pipe(Effect.mapError(() => serviceError("persistence")));

  const beginAuthorization: McpConnectionServiceShape["beginAuthorization"] = (input) =>
    Effect.gen(function* () {
      const preset = yield* presetOrFail(input.presetId);
      yield* ensureMetadata(preset);
      const attempt = options.attempts.create(preset.id, options.callbackUrl);
      const authorizationUrl = yield* options.oauth
        .begin({ preset, attempt, credentials: options.credentials })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              options.attempts.cancel(attempt.id);
              yield* options.credentials
                .clearAttemptSecrets(preset.id)
                .pipe(Effect.catch(() => Effect.void));
              const failure = completionStatus(error);
              yield* setStatus({
                connectionId: preset.id,
                status: failure.status,
                errorCategory: failure.errorCategory,
              });
              return yield* Effect.fail(serviceError(error.category));
            }),
          ),
        );
      yield* setStatus({
        connectionId: preset.id,
        status: "authorizing",
        errorCategory: null,
      });
      attemptIdByState.set(attempt.state, attempt.id);
      return { attemptId: attempt.id, authorizationUrl: authorizationUrl.href };
    });

  const completeAuthorization: McpConnectionServiceShape["completeAuthorization"] = (input) =>
    Effect.gen(function* () {
      const attemptId = attemptIdByState.get(input.state);
      if (attemptId === undefined) {
        return { ok: false, category: "invalid-authorization-attempt" } as const;
      }
      attemptIdByState.delete(input.state);
      const attempt = options.attempts.consume(attemptId, input.state);
      if (attempt === null) {
        return { ok: false, category: "invalid-authorization-attempt" } as const;
      }
      const preset = options.presets.get(attempt.connectionId);
      if (preset === null) {
        return { ok: false, category: "invalid-authorization-attempt" } as const;
      }

      if (input.error !== undefined || input.code === undefined || input.code.trim() === "") {
        yield* options.credentials
          .clearAttemptSecrets(preset.id)
          .pipe(Effect.catch(() => Effect.void));
        if (input.error === "access_denied") {
          yield* setStatus({
            connectionId: preset.id,
            status: "disconnected",
            errorCategory: "authorization-cancelled",
          });
          return { ok: false, category: "authorization-cancelled" } as const;
        }
        yield* setStatus({
          connectionId: preset.id,
          status: "temporarily-unavailable",
          errorCategory: "authorization-failed",
        });
        return { ok: false, category: "temporarily-unavailable" } as const;
      }

      const finishResult = yield* options.oauth
        .finish({
          preset,
          attempt,
          code: input.code,
          credentials: options.credentials,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          }),
        );
      if (!finishResult.ok) {
        const failure = completionStatus(finishResult.error);
        if (failure.status === "reconnect-required") {
          yield* invalidateCredentials(preset.id);
          return failure.result;
        }
        yield* options.toolClient.invalidate(preset.id);
        yield* setStatus({
          connectionId: preset.id,
          status: failure.status,
          errorCategory: failure.errorCategory,
        });
        return failure.result;
      }

      const fingerprints: string[] = [];
      for (const binding of preset.consumers) {
        const validation = yield* options.toolClient.validate(binding).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (fingerprint) => ({ ok: true as const, fingerprint }),
          }),
        );
        if (!validation.ok) {
          const failure = validationFailure(validation.error);
          if (failure.invalidated) {
            yield* invalidateCredentials(preset.id);
            return failure.result;
          }
          yield* options.toolClient.invalidate(preset.id);
          yield* setStatus({
            connectionId: preset.id,
            status: failure.status,
            errorCategory: failure.errorCategory,
          });
          return failure.result;
        }
        fingerprints.push(validation.fingerprint);
      }

      const validatedAt = now();
      yield* setStatus({
        connectionId: preset.id,
        status: "connected",
        errorCategory: null,
        catalogFingerprint: fingerprints[0] ?? null,
        lastValidatedAt: validatedAt,
      });
      publish({ connectionId: preset.id, type: "connected" });
      return { ok: true } as const;
    });

  const disconnect: McpConnectionServiceShape["disconnect"] = (input) =>
    Effect.gen(function* () {
      const preset = yield* presetOrFail(input.connectionId);
      yield* ensureMetadata(preset);
      yield* options.oauth
        .revoke({ preset, credentials: options.credentials })
        .pipe(Effect.catch(() => Effect.void));

      let deleteFailed = false;
      yield* options.credentials.delete(preset.id).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            deleteFailed = true;
          }),
        ),
      );
      yield* options.toolClient.invalidate(preset.id);
      yield* setStatus({
        connectionId: preset.id,
        status: "disconnected",
        errorCategory: null,
        catalogFingerprint: null,
        lastValidatedAt: null,
      });
      publish({ connectionId: preset.id, type: "disconnected" });
      if (deleteFailed) return yield* Effect.fail(serviceError("credential-cleanup"));
    });

  const invoke: McpConnectionServiceShape["invoke"] = (
    binding,
    operation,
    args,
    signal = new AbortController().signal,
  ) => {
    const descriptor = binding.operations[operation];
    if (descriptor === undefined) return Effect.fail(serviceError("invalid-operation"));
    return options.toolClient.call(binding, descriptor.tool, args, signal).pipe(
      Effect.catch((error) => {
        if (error instanceof McpToolClientError && error.category === "authentication") {
          return invalidateCredentials(error.connectionId ?? "").pipe(
            Effect.flatMap(() => Effect.fail(serviceError("reconnect-required"))),
          );
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return Effect.fail(serviceError("cancelled"));
        }
        const category =
          error instanceof McpToolClientError &&
          (error.category === "missing-required-tool" || error.category === "invalid-catalog")
            ? "incompatible-tools"
            : "temporarily-unavailable";
        if (error instanceof McpToolClientError && error.connectionId !== undefined) {
          const connectionId = error.connectionId;
          return Effect.gen(function* () {
            yield* options.toolClient.invalidate(connectionId);
            yield* setStatus({
              connectionId,
              status:
                category === "incompatible-tools" ? "incompatible" : "temporarily-unavailable",
              errorCategory: category === "incompatible-tools" ? category : "network",
            });
            return yield* Effect.fail(serviceError(category));
          });
        }
        return Effect.fail(serviceError(category));
      }),
    );
  };

  const subscribe: McpConnectionServiceShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  return {
    list,
    beginAuthorization,
    completeAuthorization,
    disconnect,
    invoke,
    subscribe,
  };
}

const makeMcpConnectionServiceLive = Effect.gen(function* () {
  const repository = yield* OutboundMcpRepository;
  const credentials = yield* OutboundMcpCredentials;
  const toolClient = yield* McpToolClient;
  const config = yield* ServerConfig;
  return makeMcpConnectionService({
    repository,
    credentials,
    toolClient,
    oauth: makeSdkMcpConnectionOAuthLifecycle(),
    attempts: makeAuthorizationAttemptRegistry({
      ttlMs: MAX_AUTHORIZATION_ATTEMPT_TTL_MS,
    }),
    presets: OUTBOUND_MCP_PRESETS,
    callbackUrl: new URL("/api/mcp/outbound/oauth/callback", `http://127.0.0.1:${config.port}`),
  });
});

export const McpConnectionServiceLive = Layer.effect(
  McpConnectionService,
  makeMcpConnectionServiceLive,
);
