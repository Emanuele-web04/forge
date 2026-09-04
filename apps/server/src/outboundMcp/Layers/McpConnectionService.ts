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
import { Effect, Schema, Semaphore } from "effect";
import {
  McpConnectionServiceError,
  type McpAuthorizationCompletion,
  type McpConnectionEvent,
  type McpConnectionServiceShape,
} from "../Services/McpConnectionService.ts";
import { McpToolClientError, type McpToolClientShape } from "../Services/McpToolClient.ts";
import {
  type OutboundMcpCredentialRecord,
  type OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";
import {
  type OutboundMcpConnectionRecord,
  type OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";
import {
  type AuthorizationAttempt,
  type AuthorizationAttemptRegistry,
} from "../authorizationAttempts.ts";
import {
  makeBoundedMcpFetch,
  OutboundMcpNetworkPolicyError,
  type OutboundMcpAddressResolver,
  validateOutboundMcpUrl,
} from "../networkPolicy.ts";
import { makeOAuthClientProvider } from "../oauthProvider.ts";
import {
  OutboundMcpOAuthMetadataError,
  validateOutboundMcpAuthorizationServerUrl,
  validateOutboundMcpAuthorizationUrl,
  validateOutboundMcpOAuthDiscoveryState,
} from "../oauthMetadataPolicy.ts";
import type { OutboundMcpPreset, OutboundMcpPresetRegistry } from "../presets/index.ts";
import { OutboundMcpDecodeError, OutboundMcpInputError } from "../consumerBinding.ts";

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
  readonly resolveAddresses?: OutboundMcpAddressResolver;
};

function oauthError(cause: unknown): McpConnectionOAuthError {
  if (cause instanceof McpConnectionOAuthError) return cause;
  if (
    cause instanceof OutboundMcpOAuthMetadataError &&
    cause.category === "authorization-server-mismatch"
  ) {
    return new McpConnectionOAuthError({ category: "authorization-server-mismatch" });
  }
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
      const expected = input.attempt.oauthDiscoveryState?.authorizationServerUrl;
      if (expected === undefined) {
        throw new McpConnectionOAuthError({ category: "authorization-server-mismatch" });
      }
      const validated = validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl: expected,
        state,
      });
      input.attempt.oauthDiscoveryState = validated;
      await persist({
        ...current,
        authorizationServerUrl: validated.authorizationServerUrl,
      });
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
    readonly fetch?: FetchLike;
    readonly resolveAddresses?: OutboundMcpAddressResolver;
  },
): Promise<OAuthServerInfo> {
  return dependencies.discoverServerInfo(preset.endpoint, {
    fetchFn: makeBoundedMcpFetch({
      resourceUrl: preset.endpoint,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.resolveAddresses === undefined
        ? {}
        : { resolveAddresses: dependencies.resolveAddresses }),
    }),
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
  const networkDependencies = {
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.resolveAddresses === undefined
      ? {}
      : { resolveAddresses: dependencies.resolveAddresses }),
  };
  const discoveryDependencies = { discoverServerInfo, ...networkDependencies };

  const begin: McpConnectionOAuthLifecycle["begin"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const stored = (await Effect.runPromise(input.credentials.read(input.preset.id))) ?? {};
        const discoveredServerInfo = await discoveryFor(input.preset, discoveryDependencies);
        const serverInfo = validateOutboundMcpOAuthDiscoveryState({
          pinnedAuthorizationServerUrl: discoveredServerInfo.authorizationServerUrl,
          state: discoveredServerInfo,
        });
        const hasStoredOAuthState =
          stored.clientInformation !== undefined ||
          stored.tokens !== undefined ||
          stored.authorizationServerUrl !== undefined;
        let storedAuthorityMatches = false;
        if (stored.authorizationServerUrl !== undefined) {
          try {
            storedAuthorityMatches =
              validateOutboundMcpAuthorizationServerUrl(stored.authorizationServerUrl) ===
              validateOutboundMcpAuthorizationServerUrl(serverInfo.authorizationServerUrl);
          } catch {
            storedAuthorityMatches = false;
          }
        }
        const resetStoredOAuthState = hasStoredOAuthState && !storedAuthorityMatches;
        const initial = resetStoredOAuthState ? {} : withoutTokens(stored);
        if (resetStoredOAuthState) {
          await Effect.runPromise(input.credentials.delete(input.preset.id));
        } else if (stored.tokens !== undefined) {
          await Effect.runPromise(input.credentials.write(input.preset.id, initial));
        }
        if (!clientSupportsAuthorization(input.preset, initial, serverInfo)) {
          throw new McpConnectionOAuthError({ category: "incompatible-client" });
        }
        input.attempt.oauthDiscoveryState = serverInfo;
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
            ...networkDependencies,
          }),
        });
        const authorizationUrl = state.authorizationUrl();
        if (result !== "REDIRECT" || authorizationUrl === null) {
          throw new McpConnectionOAuthError({ category: "authorization-not-started" });
        }
        return validateOutboundMcpAuthorizationUrl({ state: serverInfo, authorizationUrl });
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
        const attemptedServerInfo = input.attempt.oauthDiscoveryState;
        if (attemptedServerInfo === null || initial.authorizationServerUrl === undefined) {
          throw new McpConnectionOAuthError({ category: "authorization-server-mismatch" });
        }
        const boundServerInfo = validateOutboundMcpOAuthDiscoveryState({
          pinnedAuthorizationServerUrl: attemptedServerInfo.authorizationServerUrl,
          state: attemptedServerInfo,
        });
        const boundAuthorizationServerUrl = validateOutboundMcpAuthorizationServerUrl(
          boundServerInfo.authorizationServerUrl,
        );
        if (
          validateOutboundMcpAuthorizationServerUrl(initial.authorizationServerUrl) !==
          boundAuthorizationServerUrl
        ) {
          throw new McpConnectionOAuthError({ category: "authorization-server-mismatch" });
        }
        const discoveredCurrentServerInfo = await discoveryFor(input.preset, discoveryDependencies);
        validateOutboundMcpOAuthDiscoveryState({
          pinnedAuthorizationServerUrl: boundAuthorizationServerUrl,
          state: discoveredCurrentServerInfo,
        });
        if (!clientSupportsAuthorization(input.preset, initial, boundServerInfo)) {
          throw new McpConnectionOAuthError({ category: "incompatible-client" });
        }
        const state = await makeAttemptProvider({
          preset: input.preset,
          attempt: input.attempt,
          credentialStore: input.credentials,
          initial,
          serverInfo: boundServerInfo,
        });
        const result = await authorize(state.provider, {
          serverUrl: input.preset.endpoint,
          authorizationCode: input.code,
          fetchFn: makeBoundedMcpFetch({
            resourceUrl: input.preset.endpoint,
            ...networkDependencies,
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
        const storedAuthorizationServerUrl = stored?.authorizationServerUrl;
        if (
          stored === null ||
          token === undefined ||
          client === undefined ||
          storedAuthorizationServerUrl === undefined
        ) {
          return;
        }

        let pinnedAuthorizationServerUrl: string;
        try {
          pinnedAuthorizationServerUrl = validateOutboundMcpAuthorizationServerUrl(
            storedAuthorizationServerUrl,
          );
        } catch {
          return;
        }
        const discoveredServerInfo = await discoveryFor(input.preset, discoveryDependencies);
        let discoveredAuthorizationServerUrl: string;
        try {
          discoveredAuthorizationServerUrl = validateOutboundMcpAuthorizationServerUrl(
            discoveredServerInfo.authorizationServerUrl,
          );
        } catch {
          return;
        }
        if (pinnedAuthorizationServerUrl !== discoveredAuthorizationServerUrl) return;
        const serverInfo = validateOutboundMcpOAuthDiscoveryState({
          pinnedAuthorizationServerUrl,
          state: discoveredServerInfo,
        });
        const metadata = serverInfo.authorizationServerMetadata;
        if (metadata?.revocation_endpoint === undefined) return;

        const revocationUrl = new URL(metadata.revocation_endpoint);
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
          ...networkDependencies,
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

function invocationUnavailableCategory(status: OutboundMcpConnectionStatus): string | null {
  if (status === "connected") return null;
  if (status === "disconnected") return "not-connected";
  return status;
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
  const pendingByState = new Map<
    string,
    { readonly attemptId: string; readonly connectionId: string; readonly fenceEpoch: number }
  >();
  const pendingStateByConnectionId = new Map<string, string>();
  const authorizationLocks = new Map<string, Semaphore.Semaphore>();
  const consumerValidationLocks = new Map<string, Semaphore.Semaphore>();
  const validatedConsumers = new Set<string>();
  const fenceEpochByConnectionId = new Map<string, number>();
  const locallyFencedConnectionIds = new Set<string>();
  const disconnectRequestedConnectionIds = new Set<string>();
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

  const fenceConnection = (connectionId: string) =>
    Effect.gen(function* () {
      const epoch = (fenceEpochByConnectionId.get(connectionId) ?? 0) + 1;
      fenceEpochByConnectionId.set(connectionId, epoch);
      locallyFencedConnectionIds.add(connectionId);
      for (const key of validatedConsumers) {
        if (key.startsWith(`${connectionId}\u0000`)) validatedConsumers.delete(key);
      }
      yield* options.toolClient.invalidate(connectionId);
      return epoch;
    });

  const clearConnectionFence = (connectionId: string, expectedEpoch: number): boolean => {
    if (
      disconnectRequestedConnectionIds.has(connectionId) ||
      fenceEpochByConnectionId.get(connectionId) !== expectedEpoch
    ) {
      return false;
    }
    locallyFencedConnectionIds.delete(connectionId);
    return true;
  };

  const authorizationLockFor = (connectionId: string): Semaphore.Semaphore => {
    let lock = authorizationLocks.get(connectionId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      authorizationLocks.set(connectionId, lock);
    }
    return lock;
  };

  const consumerValidationKey = (connectionId: string, consumerId: string): string =>
    `${connectionId}\u0000${consumerId}`;

  const consumerValidationLockFor = (key: string): Semaphore.Semaphore => {
    let lock = consumerValidationLocks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      consumerValidationLocks.set(key, lock);
    }
    return lock;
  };

  const ensureMetadata = (preset: OutboundMcpPreset) =>
    Effect.gen(function* () {
      const current = yield* options.repository.get(preset.id);
      if (current !== null) {
        const endpointChanged = current.endpoint !== preset.endpoint.href;
        const metadataChanged =
          endpointChanged ||
          current.presetId !== preset.id ||
          current.displayName !== preset.displayName;
        if (!metadataChanged) return current;
        if (endpointChanged) {
          yield* fenceConnection(preset.id);
          yield* options.credentials.delete(preset.id);
        }
        const record: OutboundMcpConnectionRecord = {
          ...current,
          presetId: preset.id,
          displayName: preset.displayName,
          endpoint: preset.endpoint.href,
          status: endpointChanged ? "reconnect-required" : current.status,
          errorCategory: endpointChanged ? "endpoint-changed" : current.errorCategory,
          catalogFingerprint: endpointChanged ? null : current.catalogFingerprint,
          lastValidatedAt: endpointChanged ? null : current.lastValidatedAt,
          updatedAt: now(),
        };
        yield* options.repository.upsertMetadata(record);
        return record;
      }
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

  const cancelPendingAuthorization = (connectionId: string): void => {
    const state = pendingStateByConnectionId.get(connectionId);
    if (state === undefined) return;
    const pending = pendingByState.get(state);
    if (pending !== undefined) options.attempts.cancel(pending.attemptId);
    pendingByState.delete(state);
    pendingStateByConnectionId.delete(connectionId);
  };

  const invalidateCredentials = (connectionId: string) =>
    Effect.gen(function* () {
      yield* fenceConnection(connectionId);
      let deleteFailed = false;
      yield* options.credentials.delete(connectionId).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            deleteFailed = true;
          }),
        ),
      );
      yield* setStatus({
        connectionId,
        status: "reconnect-required",
        errorCategory: "credential-revoked",
      });
      publish({ connectionId, type: "credentials-invalidated" });
      if (deleteFailed) return yield* Effect.fail(serviceError("credential-cleanup"));
    });

  const expirePendingAuthorizations = Effect.gen(function* () {
    for (const [state, pending] of pendingByState) {
      if (!options.attempts.expire(pending.attemptId)) continue;
      pendingByState.delete(state);
      if (pendingStateByConnectionId.get(pending.connectionId) === state) {
        pendingStateByConnectionId.delete(pending.connectionId);
      }
      yield* options.credentials
        .clearAttemptSecrets(pending.connectionId)
        .pipe(Effect.catch(() => Effect.void));
      yield* setStatus({
        connectionId: pending.connectionId,
        status: "disconnected",
        errorCategory: "authorization-expired",
      });
    }
  });

  const list: McpConnectionServiceShape["list"] = () =>
    Effect.gen(function* () {
      yield* expirePendingAuthorizations;
      return yield* Effect.forEach(options.presets.all(), (preset) =>
        ensureMetadata(preset).pipe(
          Effect.map((stored) => {
            const connection = publicConnection(preset, stored);
            return disconnectRequestedConnectionIds.has(preset.id)
              ? {
                  ...connection,
                  status: "reconnect-required" as const,
                  errorCategory: "credential-cleanup",
                }
              : connection;
          }),
        ),
      ).pipe(Effect.mapError(() => serviceError("persistence")));
    });

  const beginAuthorizationLocked = (preset: OutboundMcpPreset) =>
    Effect.gen(function* () {
      disconnectRequestedConnectionIds.delete(preset.id);
      yield* ensureMetadata(preset);
      cancelPendingAuthorization(preset.id);
      const fenceEpoch = yield* fenceConnection(preset.id);
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
      const superseded = () =>
        disconnectRequestedConnectionIds.has(preset.id) ||
        fenceEpochByConnectionId.get(preset.id) !== fenceEpoch;
      const failSuperseded = () =>
        Effect.gen(function* () {
          options.attempts.cancel(attempt.id);
          yield* options.credentials
            .clearAttemptSecrets(preset.id)
            .pipe(Effect.catch(() => Effect.void));
          yield* setStatus({
            connectionId: preset.id,
            status: "reconnect-required",
            errorCategory: "credential-cleanup",
          }).pipe(Effect.catch(() => Effect.void));
          return yield* Effect.fail(serviceError("reconnect-required"));
        });
      if (superseded()) return yield* failSuperseded();
      yield* setStatus({
        connectionId: preset.id,
        status: "authorizing",
        errorCategory: null,
      }).pipe(Effect.tapError(() => Effect.sync(() => options.attempts.cancel(attempt.id))));
      if (superseded()) return yield* failSuperseded();
      pendingByState.set(attempt.state, {
        attemptId: attempt.id,
        connectionId: preset.id,
        fenceEpoch,
      });
      pendingStateByConnectionId.set(preset.id, attempt.state);
      return { attemptId: attempt.id, authorizationUrl: authorizationUrl.href };
    });

  const beginAuthorization: McpConnectionServiceShape["beginAuthorization"] = (input) =>
    Effect.gen(function* () {
      const preset = yield* presetOrFail(input.presetId);
      return yield* authorizationLockFor(preset.id).withPermits(1)(
        beginAuthorizationLocked(preset),
      );
    });

  const completeAuthorizationLocked = (
    input: Parameters<McpConnectionServiceShape["completeAuthorization"]>[0],
    observedPending: {
      readonly attemptId: string;
      readonly connectionId: string;
      readonly fenceEpoch: number;
    },
  ) =>
    Effect.gen(function* () {
      const superseded = () =>
        disconnectRequestedConnectionIds.has(observedPending.connectionId) ||
        fenceEpochByConnectionId.get(observedPending.connectionId) !== observedPending.fenceEpoch;
      const reconnectAfterSupersession = () =>
        setStatus({
          connectionId: observedPending.connectionId,
          status: "reconnect-required",
          errorCategory: "credential-cleanup",
          catalogFingerprint: null,
          lastValidatedAt: null,
        }).pipe(Effect.catch(() => Effect.void));
      const pending = pendingByState.get(input.state);
      if (
        pending === undefined ||
        pending.attemptId !== observedPending.attemptId ||
        pendingStateByConnectionId.get(pending.connectionId) !== input.state
      ) {
        if (pending?.attemptId === observedPending.attemptId) {
          pendingByState.delete(input.state);
        }
        options.attempts.cancel(observedPending.attemptId);
        return { ok: false, category: "invalid-authorization-attempt" } as const;
      }
      pendingByState.delete(input.state);
      if (pendingStateByConnectionId.get(pending.connectionId) === input.state) {
        pendingStateByConnectionId.delete(pending.connectionId);
      }
      const attempt = options.attempts.consume(pending.attemptId, input.state);
      if (attempt === null) {
        yield* options.credentials
          .clearAttemptSecrets(pending.connectionId)
          .pipe(Effect.catch(() => Effect.void));
        yield* setStatus({
          connectionId: pending.connectionId,
          status: "disconnected",
          errorCategory: "authorization-expired",
        });
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
      if (superseded()) {
        yield* reconnectAfterSupersession();
        return { ok: false, category: "reconnect-required" } as const;
      }

      yield* setStatus({
        connectionId: preset.id,
        status: "connected",
        errorCategory: null,
        catalogFingerprint: null,
        lastValidatedAt: null,
      });
      if (superseded()) {
        yield* reconnectAfterSupersession();
        return { ok: false, category: "reconnect-required" } as const;
      }
      const fingerprints: string[] = [];
      for (const binding of preset.consumers) {
        const validation = yield* options.toolClient.validate(binding).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (fingerprint) => ({ ok: true as const, fingerprint }),
          }),
        );
        if (superseded()) {
          yield* reconnectAfterSupersession();
          return { ok: false, category: "reconnect-required" } as const;
        }
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
        validatedConsumers.add(consumerValidationKey(preset.id, binding.id));
      }

      if (superseded()) {
        yield* reconnectAfterSupersession();
        return { ok: false, category: "reconnect-required" } as const;
      }
      const validatedAt = now();
      yield* setStatus({
        connectionId: preset.id,
        status: "connected",
        errorCategory: null,
        catalogFingerprint: fingerprints[0] ?? null,
        lastValidatedAt: validatedAt,
      });
      if (!clearConnectionFence(preset.id, observedPending.fenceEpoch)) {
        yield* reconnectAfterSupersession();
        return { ok: false, category: "reconnect-required" } as const;
      }
      publish({ connectionId: preset.id, type: "connected" });
      return { ok: true } as const;
    });

  const completeAuthorization: McpConnectionServiceShape["completeAuthorization"] = (input) =>
    Effect.suspend(() => {
      const observedPending = pendingByState.get(input.state);
      if (observedPending === undefined) {
        return Effect.succeed({
          ok: false,
          category: "invalid-authorization-attempt",
        } as const);
      }
      return authorizationLockFor(observedPending.connectionId).withPermits(1)(
        completeAuthorizationLocked(input, observedPending),
      );
    });

  const disconnectLocked = (preset: OutboundMcpPreset) =>
    Effect.gen(function* () {
      yield* ensureMetadata(preset);
      cancelPendingAuthorization(preset.id);
      yield* setStatus({
        connectionId: preset.id,
        status: "reconnect-required",
        errorCategory: "credential-cleanup",
        catalogFingerprint: null,
        lastValidatedAt: null,
      }).pipe(Effect.catch(() => Effect.void));
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
      if (deleteFailed) {
        yield* setStatus({
          connectionId: preset.id,
          status: "reconnect-required",
          errorCategory: "credential-cleanup",
        }).pipe(Effect.catch(() => Effect.void));
        return yield* Effect.fail(serviceError("credential-cleanup"));
      }
      yield* setStatus({
        connectionId: preset.id,
        status: "disconnected",
        errorCategory: null,
        catalogFingerprint: null,
        lastValidatedAt: null,
      });
      disconnectRequestedConnectionIds.delete(preset.id);
      publish({ connectionId: preset.id, type: "disconnected" });
    });

  const disconnect: McpConnectionServiceShape["disconnect"] = (input) =>
    Effect.gen(function* () {
      const preset = yield* presetOrFail(input.connectionId);
      disconnectRequestedConnectionIds.add(preset.id);
      cancelPendingAuthorization(preset.id);
      yield* fenceConnection(preset.id);
      yield* setStatus({
        connectionId: preset.id,
        status: "reconnect-required",
        errorCategory: "credential-cleanup",
        catalogFingerprint: null,
        lastValidatedAt: null,
      }).pipe(Effect.catch(() => Effect.void));
      yield* authorizationLockFor(preset.id).withPermits(1)(disconnectLocked(preset));
    });

  const invoke: McpConnectionServiceShape["invoke"] = (consumerId, operation, args, signal) => {
    const registered = options.presets.getConsumer(consumerId);
    if (registered === null) return Effect.fail(serviceError("unknown-consumer"));
    const { binding, preset } = registered;
    const descriptor = binding.operations[operation];
    if (descriptor === undefined) return Effect.fail(serviceError("invalid-operation"));
    if (
      locallyFencedConnectionIds.has(preset.id) ||
      disconnectRequestedConnectionIds.has(preset.id)
    ) {
      return Effect.fail(serviceError("reconnect-required"));
    }
    const ownedController = signal === undefined ? new AbortController() : null;
    const invocationSignal = signal ?? ownedController!.signal;
    const handleInvocationError = (error: unknown) => {
      if (error instanceof OutboundMcpDecodeError) {
        return Effect.fail(serviceError("invalid-response"));
      }
      if (error instanceof OutboundMcpInputError) {
        return Effect.fail(serviceError("invalid-input"));
      }
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
            status: category === "incompatible-tools" ? "incompatible" : "temporarily-unavailable",
            errorCategory: category === "incompatible-tools" ? category : "network",
          });
          return yield* Effect.fail(serviceError(category));
        });
      }
      return Effect.fail(serviceError(category));
    };
    const call = () =>
      options.toolClient
        .call(binding, descriptor.tool, args, invocationSignal)
        .pipe(Effect.catch(handleInvocationError));
    const validationKey = consumerValidationKey(preset.id, binding.id);
    const validateBeforeFirstCall = consumerValidationLockFor(validationKey).withPermits(1)(
      Effect.suspend(() =>
        validatedConsumers.has(validationKey)
          ? Effect.void
          : options.toolClient.validate(binding, invocationSignal).pipe(
              Effect.tap(() => Effect.sync(() => validatedConsumers.add(validationKey))),
              Effect.catch(handleInvocationError),
              Effect.asVoid,
            ),
      ),
    );
    const invocation = ensureMetadata(preset).pipe(
      Effect.flatMap((record) =>
        Effect.suspend(() => {
          if (
            locallyFencedConnectionIds.has(preset.id) ||
            disconnectRequestedConnectionIds.has(preset.id)
          ) {
            return Effect.fail(serviceError("reconnect-required"));
          }
          const unavailable = invocationUnavailableCategory(record.status);
          return unavailable === null
            ? validateBeforeFirstCall.pipe(Effect.flatMap(call))
            : Effect.fail(serviceError(unavailable));
        }),
      ),
    );
    return ownedController === null
      ? invocation
      : invocation.pipe(Effect.onInterrupt(() => Effect.sync(() => ownedController.abort())));
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
