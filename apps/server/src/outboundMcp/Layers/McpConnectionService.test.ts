import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { McpConsumerBinding } from "../consumerBinding.ts";
import { McpToolClientError, type McpToolClientShape } from "../Services/McpToolClient.ts";
import type {
  OutboundMcpCredentialRecord,
  OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";
import type {
  OutboundMcpConnectionRecord,
  OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";
import { makeAuthorizationAttemptRegistry } from "../authorizationAttempts.ts";
import { PARATY_MCP_PRESET } from "../presets/paraty.ts";
import { makeOutboundMcpPresetRegistry } from "../presets/index.ts";
import {
  McpConnectionOAuthError,
  makeMcpConnectionService,
  makeSdkMcpConnectionOAuthLifecycle,
  type McpConnectionOAuthLifecycle,
} from "./McpConnectionService.ts";

const CALLBACK_URL = new URL("http://127.0.0.1:3773/api/mcp/outbound/oauth/callback");
const NOW = "2026-09-01T08:00:00.000Z";

function makeMemoryRepository(): OutboundMcpRepositoryShape & {
  readonly records: Map<string, OutboundMcpConnectionRecord>;
} {
  const records = new Map<string, OutboundMcpConnectionRecord>();
  return {
    records,
    list: () => Effect.succeed([...records.values()]),
    get: (connectionId) => Effect.succeed(records.get(connectionId) ?? null),
    upsertMetadata: (record) =>
      Effect.sync(() => {
        const current = records.get(record.connectionId);
        records.set(record.connectionId, {
          ...record,
          createdAt: current?.createdAt ?? record.createdAt,
        });
      }),
    setStatus: (input) =>
      Effect.sync(() => {
        const current = records.get(input.connectionId);
        if (current === undefined) return;
        records.set(input.connectionId, {
          ...current,
          status: input.status,
          errorCategory: input.errorCategory,
          catalogFingerprint:
            input.catalogFingerprint === undefined
              ? current.catalogFingerprint
              : input.catalogFingerprint,
          lastValidatedAt:
            input.lastValidatedAt === undefined ? current.lastValidatedAt : input.lastValidatedAt,
          updatedAt: input.updatedAt,
        });
      }),
    delete: (connectionId) => Effect.sync(() => void records.delete(connectionId)),
  };
}

function makeMemoryCredentials(): OutboundMcpCredentialsShape & {
  readonly records: Map<string, OutboundMcpCredentialRecord>;
} {
  const records = new Map<string, OutboundMcpCredentialRecord>();
  return {
    records,
    read: (connectionId) => Effect.succeed(records.get(connectionId) ?? null),
    write: (connectionId, credentials) =>
      Effect.sync(() => void records.set(connectionId, credentials)),
    delete: (connectionId) => Effect.sync(() => void records.delete(connectionId)),
    clearAttemptSecrets: () => Effect.void,
  };
}

function makeFakeOAuth(
  credentials: OutboundMcpCredentialsShape,
  overrides: Partial<McpConnectionOAuthLifecycle> = {},
): McpConnectionOAuthLifecycle & { failRevocation: boolean } {
  const oauth: McpConnectionOAuthLifecycle & { failRevocation: boolean } = {
    failRevocation: false,
    begin: ({ attempt }) =>
      Effect.gen(function* () {
        attempt.codeVerifier = "verifier-1";
        yield* credentials.write(attempt.connectionId, {
          clientInformation: { client_id: "registered-client" },
          authorizationServerUrl: "https://auth.example.test/",
        });
        return new URL(`https://auth.example.test/authorize?state=${attempt.state}`);
      }),
    finish: ({ attempt }) =>
      credentials.write(attempt.connectionId, {
        clientInformation: { client_id: "registered-client" },
        tokens: {
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          token_type: "Bearer",
        },
        authorizationServerUrl: "https://auth.example.test/",
      }),
    revoke: () =>
      oauth.failRevocation
        ? Effect.fail(new McpConnectionOAuthError({ category: "revocation-failed" }))
        : Effect.void,
    ...overrides,
  };
  return oauth;
}

function makeFakeToolClient(): McpToolClientShape & {
  readonly liveConnections: Set<string>;
  validateFailure: McpToolClientError | null;
  callFailure: McpToolClientError | null;
} {
  const liveConnections = new Set<string>();
  const client: McpToolClientShape & {
    readonly liveConnections: Set<string>;
    validateFailure: McpToolClientError | null;
    callFailure: McpToolClientError | null;
  } = {
    liveConnections,
    validateFailure: null,
    callFailure: null,
    validate: (binding) => {
      if (client.validateFailure !== null) return Effect.fail(client.validateFailure);
      liveConnections.add("paraty");
      return Effect.succeed(`catalog-${binding.id}`);
    },
    call: (binding, tool) => {
      if (client.callFailure !== null) return Effect.fail(client.callFailure);
      liveConnections.add("paraty");
      const operation = Object.values(binding.operations).find(
        (candidate) => candidate.tool === tool,
      );
      return operation === undefined
        ? Effect.fail(
            new McpToolClientError({
              category: "tool-not-allowed",
              consumerId: binding.id,
            }),
          )
        : operation.decode({ ok: true });
    },
    invalidate: (connectionId) =>
      Effect.sync(() => {
        liveConnections.delete(connectionId);
      }),
    closeAll: () =>
      Effect.sync(() => {
        liveConnections.clear();
      }),
  };
  return client;
}

const readBinding: McpConsumerBinding<"read"> = {
  id: "test-read-consumer",
  presetIds: new Set(["paraty"]),
  requiredTools: new Set(["read_item"]),
  optionalTools: new Set(),
  operations: {
    read: {
      tool: "read_item",
      decode: (result) => Effect.succeed(result),
    },
  },
};

function makeFixture(options?: {
  readonly bindings?: ReadonlyArray<McpConsumerBinding<string>>;
  readonly oauth?: (credentials: OutboundMcpCredentialsShape) => McpConnectionOAuthLifecycle;
}) {
  const repository = makeMemoryRepository();
  const credentials = makeMemoryCredentials();
  const toolClient = makeFakeToolClient();
  const oauth = options?.oauth?.(credentials) ?? makeFakeOAuth(credentials);
  const preset = {
    ...PARATY_MCP_PRESET,
    consumers: options?.bindings ?? [],
  };
  const service = makeMcpConnectionService({
    repository,
    credentials,
    toolClient,
    oauth,
    attempts: makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }),
    presets: makeOutboundMcpPresetRegistry([preset]),
    callbackUrl: CALLBACK_URL,
    now: () => NOW,
  });
  return { service, repository, credentials, toolClient, oauth };
}

async function authorize(
  fixture: ReturnType<typeof makeFixture>,
): Promise<{ readonly state: string; readonly attemptId: string }> {
  const attempt = await Effect.runPromise(
    fixture.service.beginAuthorization({ presetId: "paraty" }),
  );
  const state = new URL(attempt.authorizationUrl).searchParams.get("state");
  if (state === null) throw new Error("Fake authorization URL omitted state.");
  return { state, attemptId: attempt.attemptId };
}

describe("McpConnectionService", () => {
  it("moves the Paraty preset through one-time authorization and explicit disconnect", async () => {
    const fixture = makeFixture();
    const events: Array<{ readonly connectionId: string; readonly type: string }> = [];
    const unsubscribe = await Effect.runPromise(
      fixture.service.subscribe((event) => events.push(event)),
    );

    const initial = await Effect.runPromise(fixture.service.list());
    expect(initial).toEqual([
      {
        id: "paraty",
        presetId: "paraty",
        displayName: "Paraty MCP",
        endpoint: "https://mcp-paraty-224371693889.europe-west1.run.app/mcp",
        status: "disconnected",
        lastValidatedAt: null,
        errorCategory: null,
      },
    ]);

    const { state } = await authorize(fixture);
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("authorizing");

    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" })),
    ).resolves.toEqual({ ok: true });
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("connected");
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toMatchObject({
      tokens: { access_token: "synthetic-access-token" },
    });

    await Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" }));
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toBeNull();
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("disconnected");
    expect(events).toEqual([
      { connectionId: "paraty", type: "connected" },
      { connectionId: "paraty", type: "disconnected" },
    ]);

    unsubscribe();
  });

  it("consumes a cancelled authorization once and returns to disconnected", async () => {
    const fixture = makeFixture();
    const { state } = await authorize(fixture);

    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, error: "access_denied" })),
    ).resolves.toEqual({ ok: false, category: "authorization-cancelled" });
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "disconnected",
      errorCategory: "authorization-cancelled",
    });
    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, code: "replay" })),
    ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
  });

  it("rejects a mismatched state without disclosing or completing an attempt", async () => {
    const fixture = makeFixture();
    const { state } = await authorize(fixture);

    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: `${state}-mismatch`, code: "code-1" }),
      ),
    ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("authorizing");

    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" })),
    ).resolves.toEqual({ ok: true });
  });

  it("marks a connection incompatible when a registered consumer is missing a tool", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    fixture.toolClient.validateFailure = new McpToolClientError({
      category: "missing-required-tool",
      consumerId: readBinding.id,
      connectionId: "paraty",
    });
    const { state } = await authorize(fixture);

    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" })),
    ).resolves.toEqual({ ok: false, category: "incompatible-tools" });
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "incompatible",
      errorCategory: "incompatible-tools",
    });
  });

  it("maps a transient completion failure to temporarily-unavailable", async () => {
    const fixture = makeFixture({
      oauth: (credentials) =>
        makeFakeOAuth(credentials, {
          finish: () =>
            Effect.fail(new McpConnectionOAuthError({ category: "temporarily-unavailable" })),
        }),
    });
    const { state } = await authorize(fixture);

    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" })),
    ).resolves.toEqual({ ok: false, category: "temporarily-unavailable" });
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "temporarily-unavailable",
      errorCategory: "network",
    });
  });

  it("emits credentials-invalidated and preserves its distinction from disconnect", async () => {
    const fixture = makeFixture();
    const events: Array<{ readonly connectionId: string; readonly type: string }> = [];
    await Effect.runPromise(fixture.service.subscribe((event) => events.push(event)));
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.callFailure = new McpToolClientError({
      category: "authentication",
      consumerId: readBinding.id,
      connectionId: "paraty",
    });

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "reconnect-required" });
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toBeNull();
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "reconnect-required",
      errorCategory: "credential-revoked",
    });
    expect(events.at(-1)).toEqual({
      connectionId: "paraty",
      type: "credentials-invalidated",
    });
  });

  it("persists temporarily-unavailable when an established invocation has a transient failure", async () => {
    const fixture = makeFixture();
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.callFailure = new McpToolClientError({
      category: "connection",
      consumerId: readBinding.id,
      connectionId: "paraty",
    });

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "temporarily-unavailable" });
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "temporarily-unavailable",
      errorCategory: "network",
    });
  });

  it("always clears local credentials and live clients when remote revocation fails", async () => {
    const fixture = makeFixture();
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.liveConnections.add("paraty");
    fixture.oauth.failRevocation = true;

    await expect(
      Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" })),
    ).resolves.toBeUndefined();
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toBeNull();
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
  });
});

describe("SDK OAuth lifecycle", () => {
  it("reports incompatible before authorization when discovery advertises no DCR and no public client exists", async () => {
    const credentials = makeMemoryCredentials();
    let authorizeCalled = false;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          response_types_supported: ["code"],
        },
      }),
      authorize: async () => {
        authorizeCalled = true;
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "paraty",
      CALLBACK_URL,
    );

    await expect(
      Effect.runPromise(oauth.begin({ preset: PARATY_MCP_PRESET, attempt, credentials })),
    ).rejects.toMatchObject({ category: "incompatible-client" });
    expect(authorizeCalled).toBe(false);
  });

  it("uses a safe preset public client without compiling a client secret", async () => {
    const credentials = makeMemoryCredentials();
    let observedProvider: OAuthClientProvider | null = null;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          response_types_supported: ["code"],
        },
      }),
      authorize: async (provider) => {
        observedProvider = provider;
        await provider.saveCodeVerifier("verifier-1");
        await provider.redirectToAuthorization(
          new URL(`https://auth.example.test/authorize?state=${await provider.state?.()}`),
        );
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "public-test",
      CALLBACK_URL,
    );
    const preset = {
      ...PARATY_MCP_PRESET,
      id: "public-test",
      publicClientId: "synara-public-client",
    };

    const authorizationUrl = await Effect.runPromise(oauth.begin({ preset, attempt, credentials }));
    expect(authorizationUrl.protocol).toBe("https:");
    expect(await observedProvider!.clientInformation()).toEqual({
      client_id: "synara-public-client",
    });
    expect(await Effect.runPromise(credentials.read("public-test"))).not.toHaveProperty(
      "clientInformation.client_secret",
    );
  });

  it("rejects a preset public client when discovery requires client-secret authentication", async () => {
    const credentials = makeMemoryCredentials();
    let authorizeCalled = false;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          response_types_supported: ["code"],
        },
      }),
      authorize: async () => {
        authorizeCalled = true;
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "public-test",
      CALLBACK_URL,
    );
    const preset = {
      ...PARATY_MCP_PRESET,
      id: "public-test",
      publicClientId: "synara-public-client",
    };

    await expect(
      Effect.runPromise(oauth.begin({ preset, attempt, credentials })),
    ).rejects.toMatchObject({ category: "incompatible-client" });
    expect(authorizeCalled).toBe(false);
  });

  it("posts RFC 7009 revocation only to an advertised endpoint", async () => {
    const credentials = makeMemoryCredentials();
    await Effect.runPromise(
      credentials.write("paraty", {
        clientInformation: { client_id: "public-client" },
        tokens: {
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          token_type: "Bearer",
        },
      }),
    );
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          revocation_endpoint: "https://auth.example.test/revoke",
          revocation_endpoint_auth_methods_supported: ["none"],
          response_types_supported: ["code"],
        },
      }),
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body ?? "") });
        return new Response(null, { status: 200 });
      },
    });

    await Effect.runPromise(oauth.revoke({ preset: PARATY_MCP_PRESET, credentials }));
    expect(requests).toEqual([
      {
        url: "https://auth.example.test/revoke",
        body: "token=synthetic-refresh-token&token_type_hint=refresh_token&client_id=public-client",
      },
    ]);
  });
});
