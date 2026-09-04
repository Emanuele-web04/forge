import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  OutboundMcpDecodeError,
  OutboundMcpInputError,
  type McpConsumerBinding,
} from "../consumerBinding.ts";
import { McpToolClientError, type McpToolClientShape } from "../Services/McpToolClient.ts";
import {
  OutboundMcpCredentialsError,
  type OutboundMcpCredentialRecord,
  type OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";
import type {
  OutboundMcpConnectionRecord,
  OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";
import {
  makeAuthorizationAttemptRegistry,
  type AuthorizationAttemptRegistry,
} from "../authorizationAttempts.ts";
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
const PUBLIC_TEST_RESOLVER = async (): Promise<ReadonlyArray<string>> => ["1.1.1.1"];

function makeMemoryRepository(): OutboundMcpRepositoryShape & {
  readonly records: Map<string, OutboundMcpConnectionRecord>;
  failUpsertMetadata: boolean;
  failSetStatus: boolean;
} {
  const records = new Map<string, OutboundMcpConnectionRecord>();
  const repository: OutboundMcpRepositoryShape & {
    readonly records: Map<string, OutboundMcpConnectionRecord>;
    failUpsertMetadata: boolean;
    failSetStatus: boolean;
  } = {
    records,
    failUpsertMetadata: false,
    failSetStatus: false,
    list: () => Effect.succeed([...records.values()]),
    get: (connectionId) => Effect.succeed(records.get(connectionId) ?? null),
    upsertMetadata: (record) =>
      repository.failUpsertMetadata
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "outbound-mcp-metadata",
              detail: "synthetic metadata failure",
            }),
          )
        : Effect.sync(() => {
            const current = records.get(record.connectionId);
            records.set(record.connectionId, {
              ...record,
              createdAt: current?.createdAt ?? record.createdAt,
            });
          }),
    setStatus: (input) =>
      repository.failSetStatus
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "outbound-mcp-status",
              detail: "synthetic status failure",
            }),
          )
        : Effect.sync(() => {
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
                input.lastValidatedAt === undefined
                  ? current.lastValidatedAt
                  : input.lastValidatedAt,
              updatedAt: input.updatedAt,
            });
          }),
    delete: (connectionId) => Effect.sync(() => void records.delete(connectionId)),
  };
  return repository;
}

function makeMemoryCredentials(): OutboundMcpCredentialsShape & {
  readonly records: Map<string, OutboundMcpCredentialRecord>;
  failDelete: boolean;
} {
  const records = new Map<string, OutboundMcpCredentialRecord>();
  const credentials: OutboundMcpCredentialsShape & {
    readonly records: Map<string, OutboundMcpCredentialRecord>;
    failDelete: boolean;
  } = {
    records,
    failDelete: false,
    read: (connectionId) => Effect.succeed(records.get(connectionId) ?? null),
    write: (connectionId, credentials) =>
      Effect.sync(() => void records.set(connectionId, credentials)),
    delete: (connectionId) =>
      credentials.failDelete
        ? Effect.fail(
            new OutboundMcpCredentialsError({
              operation: "delete",
              category: "filesystem",
            }),
          )
        : Effect.sync(() => void records.delete(connectionId)),
    clearAttemptSecrets: () => Effect.void,
  };
  return credentials;
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
  validateAttempts: number;
  callAttempts: number;
  callSignal: AbortSignal | null;
  blockCalls: boolean;
  validationSignal: AbortSignal | null;
  blockValidation: boolean;
} {
  const liveConnections = new Set<string>();
  const client: McpToolClientShape & {
    readonly liveConnections: Set<string>;
    validateFailure: McpToolClientError | null;
    callFailure: McpToolClientError | null;
    validateAttempts: number;
    callAttempts: number;
    callSignal: AbortSignal | null;
    blockCalls: boolean;
    validationSignal: AbortSignal | null;
    blockValidation: boolean;
  } = {
    liveConnections,
    validateFailure: null,
    callFailure: null,
    validateAttempts: 0,
    callAttempts: 0,
    callSignal: null,
    blockCalls: false,
    validationSignal: null,
    blockValidation: false,
    validate: (binding, signal) => {
      client.validateAttempts += 1;
      client.validationSignal = signal ?? null;
      if (client.blockValidation) return Effect.never;
      if (client.validateFailure !== null) return Effect.fail(client.validateFailure);
      liveConnections.add("paraty");
      return Effect.succeed(`catalog-${binding.id}`);
    },
    call: (binding, tool, _args, signal) => {
      client.callAttempts += 1;
      client.callSignal = signal;
      if (client.blockCalls) return Effect.never;
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
      encode: (input) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).length === 1 &&
        "id" in input &&
        typeof input.id === "number"
          ? Effect.succeed({ id: input.id })
          : Effect.fail(
              new OutboundMcpInputError({
                consumerId: "test-read-consumer",
                operation: "read",
                category: "invalid-input",
              }),
            ),
      decode: (result) => Effect.succeed(result),
    },
  },
};

function connectedRecord(
  overrides: Partial<OutboundMcpConnectionRecord> = {},
): OutboundMcpConnectionRecord {
  return {
    connectionId: "paraty",
    presetId: "paraty",
    displayName: PARATY_MCP_PRESET.displayName,
    endpoint: PARATY_MCP_PRESET.endpoint.href,
    status: "connected",
    errorCategory: null,
    catalogFingerprint: "catalog-old",
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeFixture(options?: {
  readonly bindings?: ReadonlyArray<McpConsumerBinding<string>>;
  readonly attempts?: AuthorizationAttemptRegistry;
  readonly oauth?: (
    credentials: OutboundMcpCredentialsShape,
    toolClient: ReturnType<typeof makeFakeToolClient>,
    repository: ReturnType<typeof makeMemoryRepository>,
  ) => McpConnectionOAuthLifecycle;
}) {
  const repository = makeMemoryRepository();
  const credentials = makeMemoryCredentials();
  const toolClient = makeFakeToolClient();
  const oauth = options?.oauth?.(credentials, toolClient, repository) ?? makeFakeOAuth(credentials);
  const preset = {
    ...PARATY_MCP_PRESET,
    consumers: options?.bindings ?? [],
  };
  const service = makeMcpConnectionService({
    repository,
    credentials,
    toolClient,
    oauth,
    attempts: options?.attempts ?? makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }),
    presets: makeOutboundMcpPresetRegistry([preset]),
    callbackUrl: CALLBACK_URL,
    now: () => NOW,
  });
  return { service, repository, credentials, toolClient, oauth };
}

function makeTrackedAttempts(): {
  readonly registry: AuthorizationAttemptRegistry;
  readonly active: ReadonlySet<string>;
} {
  const delegate = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 });
  const active = new Set<string>();
  return {
    active,
    registry: {
      create: (connectionId, redirectUrl) => {
        const attempt = delegate.create(connectionId, redirectUrl);
        active.add(attempt.id);
        return attempt;
      },
      saveVerifier: delegate.saveVerifier,
      consume: (attemptId, state) => {
        active.delete(attemptId);
        return delegate.consume(attemptId, state);
      },
      expire: (attemptId) => {
        const expired = delegate.expire(attemptId);
        if (expired) active.delete(attemptId);
        return expired;
      },
      cancel: (attemptId) => {
        active.delete(attemptId);
        delegate.cancel(attemptId);
      },
    },
  };
}

async function waitUntil(assertion: () => void, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
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

  it("reconciles stored display metadata without disturbing a connected session", async () => {
    const fixture = makeFixture();
    fixture.repository.records.set(
      "paraty",
      connectedRecord({ displayName: "Legacy Paraty label" }),
    );
    fixture.toolClient.liveConnections.add("paraty");

    const listed = await Effect.runPromise(fixture.service.list());

    expect(listed[0]).toMatchObject({
      displayName: PARATY_MCP_PRESET.displayName,
      endpoint: PARATY_MCP_PRESET.endpoint.href,
      status: "connected",
    });
    expect(fixture.repository.records.get("paraty")).toMatchObject({
      displayName: PARATY_MCP_PRESET.displayName,
      status: "connected",
      catalogFingerprint: "catalog-old",
    });
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(true);
  });

  it("fences an existing connection when the registered preset endpoint rotates", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    fixture.repository.records.set(
      "paraty",
      connectedRecord({ endpoint: "https://old-mcp.example.test/mcp" }),
    );
    fixture.credentials.records.set("paraty", {
      authorizationServerUrl: "https://auth.example.test/",
      tokens: { access_token: "residual-token", token_type: "Bearer" },
    });
    fixture.toolClient.liveConnections.add("paraty");

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "reconnect-required" });
    expect(fixture.toolClient.callAttempts).toBe(0);
    const listed = await Effect.runPromise(fixture.service.list());

    expect(listed[0]).toMatchObject({
      endpoint: PARATY_MCP_PRESET.endpoint.href,
      status: "reconnect-required",
      errorCategory: "endpoint-changed",
    });
    expect(fixture.repository.records.get("paraty")).toMatchObject({
      endpoint: PARATY_MCP_PRESET.endpoint.href,
      status: "reconnect-required",
      errorCategory: "endpoint-changed",
      catalogFingerprint: null,
      lastValidatedAt: null,
    });
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
  });

  it("persists a rotated endpoint and fences the old session before starting OAuth", async () => {
    let metadataDuringBegin: OutboundMcpConnectionRecord | undefined;
    let liveDuringBegin: boolean | undefined;
    const fixture = makeFixture({
      oauth: (credentials, toolClient, repository) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          begin: (input) =>
            Effect.sync(() => {
              metadataDuringBegin = repository.records.get("paraty");
              liveDuringBegin = toolClient.liveConnections.has("paraty");
            }).pipe(Effect.andThen(base.begin(input))),
        };
      },
    });
    fixture.repository.records.set(
      "paraty",
      connectedRecord({ endpoint: "https://old-mcp.example.test/mcp" }),
    );
    fixture.toolClient.liveConnections.add("paraty");

    await Effect.runPromise(fixture.service.beginAuthorization({ presetId: "paraty" }));

    expect(metadataDuringBegin).toMatchObject({
      endpoint: PARATY_MCP_PRESET.endpoint.href,
      status: "reconnect-required",
      errorCategory: "endpoint-changed",
      catalogFingerprint: null,
      lastValidatedAt: null,
    });
    expect(liveDuringBegin).toBe(false);
    expect(fixture.repository.records.get("paraty")?.status).toBe("authorizing");
  });

  it("removes an old OAuth client registration before endpoint and authority rotation", async () => {
    let observedClientInformation: unknown = "authorize-not-called";
    const fixture = makeFixture({
      oauth: () =>
        makeSdkMcpConnectionOAuthLifecycle({
          discoverServerInfo: async () => ({
            authorizationServerUrl: "https://new-auth.example.test/",
            authorizationServerMetadata: {
              issuer: "https://new-auth.example.test/",
              authorization_endpoint: "https://new-auth.example.test/authorize",
              token_endpoint: "https://new-auth.example.test/token",
              registration_endpoint: "https://new-auth.example.test/register",
              response_types_supported: ["code"],
            },
          }),
          authorize: async (provider) => {
            observedClientInformation = await provider.clientInformation();
            await provider.saveClientInformation?.({ client_id: "new-registered-client" });
            await provider.saveCodeVerifier("new-verifier");
            await provider.redirectToAuthorization(
              new URL(`https://new-auth.example.test/authorize?state=${await provider.state?.()}`),
            );
            return "REDIRECT";
          },
        }),
    });
    fixture.repository.records.set(
      "paraty",
      connectedRecord({ endpoint: "https://old-mcp.example.test/mcp" }),
    );
    fixture.credentials.records.set("paraty", {
      clientInformation: {
        client_id: "synthetic-old-confidential-client",
        client_secret: "synthetic-old-confidential-secret",
      },
      tokens: {
        access_token: "synthetic-old-access-token",
        refresh_token: "synthetic-old-refresh-token",
        token_type: "Bearer",
      },
      authorizationServerUrl: "https://old-auth.example.test/",
    });

    const result = await Effect.runPromise(
      fixture.service.beginAuthorization({ presetId: "paraty" }),
    );

    expect(observedClientInformation).toEqual({ client_id: "mcp-paraty" });
    expect(result.authorizationUrl).toContain("https://new-auth.example.test/authorize");
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toEqual({
      clientInformation: { client_id: "new-registered-client" },
      authorizationServerUrl: "https://new-auth.example.test/",
    });
    expect(JSON.stringify({ result, observedClientInformation })).not.toMatch(
      /synthetic-old-confidential-client|synthetic-old-confidential-secret/,
    );
  });

  it("does not start OAuth when rotated endpoint metadata cannot be persisted", async () => {
    let oauthBegins = 0;
    const fixture = makeFixture({
      bindings: [readBinding],
      oauth: (credentials) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          begin: (input) => {
            oauthBegins += 1;
            return base.begin(input);
          },
        };
      },
    });
    fixture.repository.records.set(
      "paraty",
      connectedRecord({ endpoint: "https://old-mcp.example.test/mcp" }),
    );
    fixture.toolClient.liveConnections.add("paraty");
    fixture.repository.failUpsertMetadata = true;

    await expect(
      Effect.runPromise(fixture.service.beginAuthorization({ presetId: "paraty" })),
    ).rejects.toMatchObject({ category: "persistence" });
    expect(oauthBegins).toBe(0);
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "reconnect-required" });
    expect(fixture.toolClient.callAttempts).toBe(0);
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

  it("keeps only the newest pending authorization attempt for a connection", async () => {
    const fixture = makeFixture();
    const first = await authorize(fixture);
    const second = await authorize(fixture);

    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: first.state, code: "stale-code" }),
      ),
    ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("authorizing");
    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: second.state, code: "current-code" }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("serializes interleaved authorization starts and leaves only the newest callback valid", async () => {
    const tracked = makeTrackedAttempts();
    const begunStates: string[] = [];
    const releases: Array<() => void> = [];
    const finishedStates: string[] = [];
    const fixture = makeFixture({
      attempts: tracked.registry,
      oauth: (credentials) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          begin: ({ attempt }) =>
            Effect.promise(
              () =>
                new Promise<URL>((resolve) => {
                  begunStates.push(attempt.state);
                  releases.push(() =>
                    resolve(new URL(`https://auth.example.test/authorize?state=${attempt.state}`)),
                  );
                }),
            ),
          finish: (input) =>
            Effect.sync(() => finishedStates.push(input.attempt.state)).pipe(
              Effect.andThen(base.finish(input)),
            ),
        };
      },
    });

    const firstPromise = Effect.runPromise(
      fixture.service.beginAuthorization({ presetId: "paraty" }),
    );
    await waitUntil(() => expect(begunStates).toHaveLength(1));
    const secondPromise = Effect.runPromise(
      fixture.service.beginAuthorization({ presetId: "paraty" }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(begunStates).toHaveLength(1);
    } finally {
      releases[0]?.();
    }
    const first = await firstPromise;
    await waitUntil(() => expect(begunStates).toHaveLength(2));
    releases[1]?.();
    const second = await secondPromise;
    const firstState = new URL(first.authorizationUrl).searchParams.get("state")!;
    const secondState = new URL(second.authorizationUrl).searchParams.get("state")!;

    expect(tracked.active.size).toBe(1);
    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: secondState, code: "current-code" }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(finishedStates).toEqual([secondState]);
    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: firstState, code: "stale-code" }),
      ),
    ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
    expect(finishedStates).toEqual([secondState]);
    expect(tracked.active.size).toBe(0);
  });

  it("lets a queued authorization recover after the older start fails without leaking attempts", async () => {
    const tracked = makeTrackedAttempts();
    let beginCalls = 0;
    let rejectFirst!: (cause: unknown) => void;
    const firstGate = new Promise<URL>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const fixture = makeFixture({
      attempts: tracked.registry,
      oauth: (credentials) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          begin: ({ attempt }) => {
            beginCalls += 1;
            if (beginCalls === 1) {
              return Effect.tryPromise({
                try: () => firstGate,
                catch: () => new McpConnectionOAuthError({ category: "temporarily-unavailable" }),
              });
            }
            return Effect.succeed(
              new URL(`https://auth.example.test/authorize?state=${attempt.state}`),
            );
          },
        };
      },
    });

    const firstPromise = Effect.runPromise(
      fixture.service.beginAuthorization({ presetId: "paraty" }),
    );
    await waitUntil(() => expect(beginCalls).toBe(1));
    const secondPromise = Effect.runPromise(
      fixture.service.beginAuthorization({ presetId: "paraty" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(beginCalls).toBe(1);
    rejectFirst(new Error("synthetic older failure"));

    await expect(firstPromise).rejects.toMatchObject({ category: "temporarily-unavailable" });
    const second = await secondPromise;
    const secondState = new URL(second.authorizationUrl).searchParams.get("state")!;
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("authorizing");
    expect(tracked.active.size).toBe(1);
    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: secondState, code: "current-code" }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(tracked.active.size).toBe(0);
  });

  it("does not return an authorization URL after disconnect supersedes a blocked begin", async () => {
    const tracked = makeTrackedAttempts();
    let beginStarted = false;
    let releaseBegin!: () => void;
    const beginGate = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    const fixture = makeFixture({
      attempts: tracked.registry,
      oauth: (credentials) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          begin: ({ attempt }) =>
            Effect.promise(async () => {
              beginStarted = true;
              await beginGate;
              return new URL(`https://auth.example.test/authorize?state=${attempt.state}`);
            }),
        };
      },
    });
    const begin = Effect.runPromise(fixture.service.beginAuthorization({ presetId: "paraty" }));
    await waitUntil(() => expect(beginStarted).toBe(true));

    const disconnection = Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" }));
    releaseBegin();

    await expect(begin).rejects.toMatchObject({ category: "reconnect-required" });
    await expect(disconnection).resolves.toBeUndefined();
    expect(tracked.active.size).toBe(0);
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("disconnected");
  });

  it("does not let a new authorization interleave with callback completion", async () => {
    const tracked = makeTrackedAttempts();
    let beginCalls = 0;
    let finishStarted = false;
    let releaseFinish!: () => void;
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const fixture = makeFixture({
      attempts: tracked.registry,
      oauth: (credentials) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          begin: (input) => {
            beginCalls += 1;
            return base.begin(input);
          },
          finish: (input) =>
            Effect.promise(async () => {
              finishStarted = true;
              await finishGate;
              await Effect.runPromise(base.finish(input));
            }),
        };
      },
    });
    const first = await authorize(fixture);
    const completion = Effect.runPromise(
      fixture.service.completeAuthorization({ state: first.state, code: "first-code" }),
    );
    await waitUntil(() => expect(finishStarted).toBe(true));

    const secondBegin = Effect.runPromise(
      fixture.service.beginAuthorization({ presetId: "paraty" }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(beginCalls).toBe(1);
    } finally {
      releaseFinish();
    }
    await expect(completion).resolves.toEqual({ ok: true });
    const second = await secondBegin;

    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("authorizing");
    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: first.state, code: "replayed-code" }),
      ),
    ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
    const secondState = new URL(second.authorizationUrl).searchParams.get("state")!;
    await expect(
      Effect.runPromise(
        fixture.service.completeAuthorization({ state: secondState, code: "second-code" }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(tracked.active.size).toBe(0);
  });

  it("moves a recognized expired attempt out of authorizing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW));
      const fixture = makeFixture();
      const { state } = await authorize(fixture);
      vi.advanceTimersByTime(60_000);

      await expect(
        Effect.runPromise(fixture.service.completeAuthorization({ state, code: "expired-code" })),
      ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
      expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
        status: "disconnected",
        errorCategory: "authorization-expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires authorizing status during ordinary connection polling", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW));
      const fixture = makeFixture();
      const { state } = await authorize(fixture);
      vi.advanceTimersByTime(60_000);

      expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
        status: "disconnected",
        errorCategory: "authorization-expired",
      });
      await expect(
        Effect.runPromise(fixture.service.completeAuthorization({ state, code: "expired-code" })),
      ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a pending callback when explicitly disconnected", async () => {
    const fixture = makeFixture();
    const { state } = await authorize(fixture);

    await Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" }));

    await expect(
      Effect.runPromise(fixture.service.completeAuthorization({ state, code: "late-code" })),
    ).resolves.toEqual({ ok: false, category: "invalid-authorization-attempt" });
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toBeNull();
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("disconnected");
  });

  it("does not let disconnect interleave with callback completion", async () => {
    let finishStarted = false;
    let releaseFinish!: () => void;
    let releaseRevocation!: () => void;
    let revocations = 0;
    let revocationStarted = false;
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const revocationGate = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    const fixture = makeFixture({
      bindings: [readBinding],
      oauth: (credentials) => {
        const base = makeFakeOAuth(credentials);
        return {
          ...base,
          finish: (input) =>
            Effect.promise(async () => {
              finishStarted = true;
              await finishGate;
              await Effect.runPromise(base.finish(input));
            }),
          revoke: () =>
            Effect.promise(async () => {
              revocations += 1;
              revocationStarted = true;
              await revocationGate;
            }),
        };
      },
    });
    const events: string[] = [];
    const connectedWindow: { invocation: Promise<unknown> | null } = { invocation: null };
    await Effect.runPromise(
      fixture.service.subscribe((event) => {
        events.push(event.type);
        if (event.type === "connected") {
          connectedWindow.invocation = Effect.runPromise(
            fixture.service.invoke(readBinding.id, "read", { id: 1 }),
          );
        }
      }),
    );
    const first = await authorize(fixture);
    const completion = Effect.runPromise(
      fixture.service.completeAuthorization({ state: first.state, code: "first-code" }),
    );
    await waitUntil(() => expect(finishStarted).toBe(true));
    fixture.toolClient.liveConnections.add("paraty");

    const disconnection = Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(revocations).toBe(0);
      expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
      expect((await Effect.runPromise(fixture.service.list()))[0]?.status).not.toBe("connected");
    } finally {
      releaseFinish();
    }
    await expect(completion).resolves.toEqual({ ok: false, category: "reconnect-required" });
    await waitUntil(() => expect(revocationStarted).toBe(true));

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "reconnect-required" });
    if (connectedWindow.invocation !== null) {
      await connectedWindow.invocation.catch(() => undefined);
    }
    expect(fixture.toolClient.callAttempts).toBe(0);
    expect(events).not.toContain("connected");
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).not.toBe("connected");

    releaseRevocation();
    await expect(disconnection).resolves.toBeUndefined();
    expect(revocations).toBe(1);
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toBeNull();
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("disconnected");
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

  it("revalidates a pre-existing connected record before its first consumer invocation", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    fixture.repository.records.set("paraty", connectedRecord());
    fixture.toolClient.validateFailure = new McpToolClientError({
      category: "missing-required-tool",
      consumerId: readBinding.id,
      connectionId: "paraty",
    });

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "incompatible-tools" });
    expect(fixture.toolClient.validateAttempts).toBe(1);
    expect(fixture.toolClient.callAttempts).toBe(0);
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "incompatible",
      errorCategory: "incompatible-tools",
    });
  });

  it.each([
    ["disconnected", "not-connected"],
    ["authorizing", "authorizing"],
    ["incompatible", "incompatible"],
    ["reconnect-required", "reconnect-required"],
    ["temporarily-unavailable", "temporarily-unavailable"],
  ] as const)(
    "preserves %s status as %s when invocation is unavailable",
    async (status, category) => {
      const fixture = makeFixture({ bindings: [readBinding] });
      fixture.repository.records.set("paraty", connectedRecord({ status }));

      await expect(
        Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
      ).rejects.toMatchObject({ category });
      expect(fixture.toolClient.validateAttempts).toBe(0);
      expect(fixture.toolClient.callAttempts).toBe(0);
    },
  );

  it("aborts the internally-owned signal when an invocation Effect is interrupted", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    fixture.repository.records.set("paraty", connectedRecord());
    fixture.toolClient.blockCalls = true;
    const fiber = Effect.runFork(fixture.service.invoke(readBinding.id, "read", { id: 1 }));
    await waitUntil(() => expect(fixture.toolClient.callSignal).not.toBeNull());
    expect(fixture.toolClient.callSignal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(fixture.toolClient.callSignal?.aborted).toBe(true);
  });

  it("passes the internally-owned signal through catalog validation and aborts it on interruption", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    fixture.repository.records.set("paraty", connectedRecord());
    fixture.toolClient.blockValidation = true;
    const fiber = Effect.runFork(fixture.service.invoke(readBinding.id, "read", { id: 1 }));
    await waitUntil(() => expect(fixture.toolClient.validationSignal).not.toBeNull());
    expect(fixture.toolClient.validationSignal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(fixture.toolClient.validationSignal?.aborted).toBe(true);
    expect(fixture.toolClient.callAttempts).toBe(0);
  });

  it("does not abort a caller-owned signal when an invocation Effect is interrupted", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    fixture.repository.records.set("paraty", connectedRecord());
    fixture.toolClient.blockCalls = true;
    const controller = new AbortController();
    const fiber = Effect.runFork(
      fixture.service.invoke(readBinding.id, "read", { id: 1 }, controller.signal),
    );
    await waitUntil(() => expect(fixture.toolClient.callSignal).toBe(controller.signal));
    expect(fixture.toolClient.validationSignal).toBe(controller.signal);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(controller.signal.aborted).toBe(false);
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
    const fixture = makeFixture({ bindings: [readBinding] });
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
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
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
    const fixture = makeFixture({ bindings: [readBinding] });
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.callFailure = new McpToolClientError({
      category: "connection",
      consumerId: readBinding.id,
      connectionId: "paraty",
    });

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "temporarily-unavailable" });
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "temporarily-unavailable",
      errorCategory: "network",
    });
  });

  it("reports consumer decode failures as invalid-response without degrading the connection", async () => {
    const invalidResponseBinding: McpConsumerBinding<"read"> = {
      ...readBinding,
      id: "invalid-response-consumer",
      operations: {
        read: {
          ...readBinding.operations.read,
          decode: () =>
            Effect.fail(
              new OutboundMcpDecodeError({
                consumerId: "invalid-response-consumer",
                operation: "read",
                category: "invalid-response",
              }),
            ),
        },
      },
    };
    const fixture = makeFixture({ bindings: [invalidResponseBinding] });
    fixture.repository.records.set("paraty", connectedRecord());

    await expect(
      Effect.runPromise(fixture.service.invoke(invalidResponseBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "invalid-response" });
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "connected",
      errorCategory: null,
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

  it("durably fences and closes the live client before remote revocation", async () => {
    let statusDuringRevocation: string | undefined;
    let liveDuringRevocation: boolean | undefined;
    const fixture = makeFixture({
      oauth: (credentials, toolClient, repository) =>
        makeFakeOAuth(credentials, {
          revoke: () =>
            Effect.sync(() => {
              statusDuringRevocation = repository.records.get("paraty")?.status;
              liveDuringRevocation = toolClient.liveConnections.has("paraty");
            }),
        }),
    });
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.liveConnections.add("paraty");

    await Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" }));

    expect(statusDuringRevocation).toBe("reconnect-required");
    expect(liveDuringRevocation).toBe(false);
    expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("disconnected");
  });

  it("fences residual credentials and withholds disconnected when credential deletion fails", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    const events: Array<{ readonly connectionId: string; readonly type: string }> = [];
    await Effect.runPromise(fixture.service.subscribe((event) => events.push(event)));
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.liveConnections.add("paraty");
    fixture.credentials.failDelete = true;

    const error = await Effect.runPromise(
      Effect.flip(fixture.service.disconnect({ connectionId: "paraty" })),
    );

    expect(error).toMatchObject({ category: "credential-cleanup" });
    expect(JSON.stringify(error)).not.toContain("synthetic");
    expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toMatchObject({
      tokens: { access_token: "synthetic-access-token" },
    });
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
    expect((await Effect.runPromise(fixture.service.list()))[0]).toMatchObject({
      status: "reconnect-required",
      errorCategory: "credential-cleanup",
    });
    expect(events.map((event) => event.type)).toEqual(["connected"]);

    const attemptsBeforeInvoke = fixture.toolClient.callAttempts;
    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "reconnect-required" });
    expect(fixture.toolClient.callAttempts).toBe(attemptsBeforeInvoke);
  });

  it("keeps an in-memory invocation fence when cleanup status persistence also fails", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    const events: Array<{ readonly connectionId: string; readonly type: string }> = [];
    await Effect.runPromise(fixture.service.subscribe((event) => events.push(event)));
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    fixture.toolClient.liveConnections.add("paraty");
    fixture.credentials.failDelete = true;
    fixture.repository.failSetStatus = true;

    const error = await Effect.runPromise(
      Effect.flip(fixture.service.disconnect({ connectionId: "paraty" })),
    );

    expect(error).toMatchObject({ category: "credential-cleanup" });
    expect(JSON.stringify(error)).not.toContain("synthetic status failure");
    expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
    expect(fixture.repository.records.get("paraty")?.status).toBe("connected");
    expect(events.map((event) => event.type)).toEqual(["connected"]);
    const attemptsBeforeInvoke = fixture.toolClient.callAttempts;
    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).rejects.toMatchObject({ category: "reconnect-required" });
    expect(fixture.toolClient.callAttempts).toBe(attemptsBeforeInvoke);
  });

  it("uses only registered consumer operations and rejects forged bindings before network access", async () => {
    const fixture = makeFixture({ bindings: [readBinding] });
    const { state } = await authorize(fixture);
    await Effect.runPromise(fixture.service.completeAuthorization({ state, code: "code-1" }));
    const attemptsBefore = fixture.toolClient.callAttempts;
    const forgedBinding = {
      ...readBinding,
      id: "forged-consumer",
      presetIds: new Set(["forged-preset"]),
      operations: {
        read: { ...readBinding.operations.read, tool: "forged_tool" },
      },
    };

    await expect(
      Effect.runPromise(
        fixture.service.invoke(forgedBinding as unknown as string, "read", { id: 1 }),
      ),
    ).rejects.toMatchObject({ category: "unknown-consumer" });
    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "forged-operation", { id: 1 })),
    ).rejects.toMatchObject({ category: "invalid-operation" });
    expect(fixture.toolClient.callAttempts).toBe(attemptsBefore);

    await expect(
      Effect.runPromise(fixture.service.invoke(readBinding.id, "read", { id: 1 })),
    ).resolves.toEqual({ ok: true });
    expect(fixture.toolClient.callAttempts).toBe(attemptsBefore + 1);
  });

  it.each([
    ["absent", undefined],
    ["different", "https://auth-a.example.test/"],
  ] as const)(
    "skips a newly discovered revocation authority when stored authority is %s and still cleans up locally",
    async (_case, storedAuthority) => {
      const requests: string[] = [];
      const fixture = makeFixture({
        oauth: () =>
          makeSdkMcpConnectionOAuthLifecycle({
            discoverServerInfo: async () => ({
              authorizationServerUrl: "https://auth-b.example.test/",
              authorizationServerMetadata: {
                issuer: "https://auth-b.example.test/",
                authorization_endpoint: "https://auth-b.example.test/authorize",
                token_endpoint: "https://auth-b.example.test/token",
                revocation_endpoint: "https://auth-b.example.test/revoke",
                revocation_endpoint_auth_methods_supported: ["none"],
                response_types_supported: ["code"],
              },
            }),
            fetch: async (input) => {
              requests.push(String(input));
              return new Response(null, { status: 200 });
            },
            resolveAddresses: PUBLIC_TEST_RESOLVER,
          }),
      });
      await Effect.runPromise(
        fixture.credentials.write("paraty", {
          clientInformation: { client_id: "public-client" },
          tokens: {
            access_token: "synthetic-access-token",
            refresh_token: "synthetic-refresh-token",
            token_type: "Bearer",
          },
          ...(storedAuthority === undefined ? {} : { authorizationServerUrl: storedAuthority }),
        }),
      );
      fixture.toolClient.liveConnections.add("paraty");

      await Effect.runPromise(fixture.service.disconnect({ connectionId: "paraty" }));

      expect(requests).toEqual([]);
      expect(await Effect.runPromise(fixture.credentials.read("paraty"))).toBeNull();
      expect(fixture.toolClient.liveConnections.has("paraty")).toBe(false);
      expect((await Effect.runPromise(fixture.service.list()))[0]?.status).toBe("disconnected");
    },
  );
});

describe("SDK OAuth lifecycle", () => {
  it("fails before token exchange when callback discovery selects a different authorization server", async () => {
    const credentials = makeMemoryCredentials();
    const discoveries = [
      {
        authorizationServerUrl: "https://auth-a.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth-a.example.test/",
          authorization_endpoint: "https://auth-a.example.test/authorize",
          token_endpoint: "https://auth-a.example.test/token",
          registration_endpoint: "https://auth-a.example.test/register",
          response_types_supported: ["code"],
        },
      },
      {
        authorizationServerUrl: "https://auth-b.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth-b.example.test/",
          authorization_endpoint: "https://auth-b.example.test/authorize",
          token_endpoint: "https://auth-b.example.test/token",
          registration_endpoint: "https://auth-b.example.test/register",
          response_types_supported: ["code"],
        },
      },
    ] as const;
    let discoveryIndex = 0;
    let tokenExchanges = 0;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => discoveries[discoveryIndex++]!,
      authorize: async (provider, options) => {
        if (options.authorizationCode !== undefined) {
          tokenExchanges += 1;
          await provider.saveTokens({
            access_token: "synthetic-access-token",
            token_type: "Bearer",
          });
          return "AUTHORIZED";
        }
        await provider.saveClientInformation?.({ client_id: "registered-client" });
        await provider.saveCodeVerifier("synthetic-verifier");
        await provider.redirectToAuthorization(
          new URL(`https://auth-a.example.test/authorize?state=${await provider.state?.()}`),
        );
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "paraty",
      CALLBACK_URL,
    );

    await Effect.runPromise(oauth.begin({ preset: PARATY_MCP_PRESET, attempt, credentials }));
    await expect(
      Effect.runPromise(
        oauth.finish({
          preset: PARATY_MCP_PRESET,
          attempt,
          code: "synthetic-code",
          credentials,
        }),
      ),
    ).rejects.toMatchObject({ category: "authorization-server-mismatch" });
    expect(tokenExchanges).toBe(0);
  });

  it("rejects a captured HTTP authorization URL with a category-only error", async () => {
    const credentials = makeMemoryCredentials();
    let authorizeCalled = false;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "http://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
        },
      }),
      authorize: async (provider) => {
        authorizeCalled = true;
        await provider.saveClientInformation?.({ client_id: "registered-client" });
        await provider.saveCodeVerifier("synthetic-verifier");
        await provider.redirectToAuthorization(
          new URL(`http://auth.example.test/authorize?state=${await provider.state?.()}`),
        );
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "paraty",
      CALLBACK_URL,
    );

    const error = await Effect.runPromise(
      Effect.flip(oauth.begin({ preset: PARATY_MCP_PRESET, attempt, credentials })),
    );
    expect(error).toMatchObject({ category: "temporarily-unavailable" });
    expect(JSON.stringify(error)).not.toContain("auth.example.test");
    expect(authorizeCalled).toBe(false);
  });

  it("rejects off-origin dynamic registration metadata before authorization starts", async () => {
    const credentials = makeMemoryCredentials();
    let authorizeCalled = false;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://attacker.example.test/register",
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
    ).rejects.toMatchObject({ category: "temporarily-unavailable" });
    expect(authorizeCalled).toBe(false);
  });

  it("rejects off-origin callback token metadata before sending the authorization code", async () => {
    const credentials = makeMemoryCredentials();
    const discoveries = [
      {
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
        },
      },
      {
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://attacker.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
        },
      },
    ] as const;
    let discoveryIndex = 0;
    let tokenExchanges = 0;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => discoveries[discoveryIndex++]!,
      authorize: async (provider, options) => {
        if (options.authorizationCode !== undefined) {
          tokenExchanges += 1;
          return "AUTHORIZED";
        }
        await provider.saveClientInformation?.({ client_id: "registered-client" });
        await provider.saveCodeVerifier("synthetic-verifier");
        await provider.redirectToAuthorization(
          new URL(`https://auth.example.test/authorize?state=${await provider.state?.()}`),
        );
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "paraty",
      CALLBACK_URL,
    );
    await Effect.runPromise(oauth.begin({ preset: PARATY_MCP_PRESET, attempt, credentials }));

    await expect(
      Effect.runPromise(
        oauth.finish({
          preset: PARATY_MCP_PRESET,
          attempt,
          code: "synthetic-code",
          credentials,
        }),
      ),
    ).rejects.toMatchObject({ category: "temporarily-unavailable" });
    expect(tokenExchanges).toBe(0);
  });

  it("rejects off-origin revocation metadata before constructing or sending a token request", async () => {
    const credentials = makeMemoryCredentials();
    await Effect.runPromise(
      credentials.write("paraty", {
        clientInformation: { client_id: "public-client" },
        tokens: {
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          token_type: "Bearer",
        },
        authorizationServerUrl: "https://auth.example.test/",
      }),
    );
    let requests = 0;
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test/",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          revocation_endpoint: "https://attacker.example.test/revoke",
          response_types_supported: ["code"],
        },
      }),
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 200 });
      },
      resolveAddresses: PUBLIC_TEST_RESOLVER,
    });

    await expect(
      Effect.runPromise(oauth.revoke({ preset: PARATY_MCP_PRESET, credentials })),
    ).rejects.toMatchObject({ category: "revocation-failed" });
    expect(requests).toBe(0);
  });

  it("resets a stored OAuth client when the same resource discovers a new authority", async () => {
    const credentials = makeMemoryCredentials();
    await Effect.runPromise(
      credentials.write("paraty", {
        clientInformation: {
          client_id: "synthetic-old-confidential-client",
          client_secret: "synthetic-old-confidential-secret",
        },
        tokens: {
          access_token: "synthetic-old-access-token",
          refresh_token: "synthetic-old-refresh-token",
          token_type: "Bearer",
        },
        authorizationServerUrl: "https://old-auth.example.test/",
      }),
    );
    let observedClientInformation: unknown = "authorize-not-called";
    const oauth = makeSdkMcpConnectionOAuthLifecycle({
      discoverServerInfo: async () => ({
        authorizationServerUrl: "https://new-auth.example.test/",
        authorizationServerMetadata: {
          issuer: "https://new-auth.example.test/",
          authorization_endpoint: "https://new-auth.example.test/authorize",
          token_endpoint: "https://new-auth.example.test/token",
          registration_endpoint: "https://new-auth.example.test/register",
          response_types_supported: ["code"],
        },
      }),
      authorize: async (provider) => {
        observedClientInformation = await provider.clientInformation();
        await provider.saveClientInformation?.({ client_id: "new-registered-client" });
        await provider.saveCodeVerifier("new-verifier");
        await provider.redirectToAuthorization(
          new URL(`https://new-auth.example.test/authorize?state=${await provider.state?.()}`),
        );
        return "REDIRECT";
      },
    });
    const attempt = makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }).create(
      "paraty",
      CALLBACK_URL,
    );

    const result = await Effect.runPromise(
      oauth.begin({ preset: PARATY_MCP_PRESET, attempt, credentials }),
    );

    expect(observedClientInformation).toEqual({ client_id: "mcp-paraty" });
    expect(result.href).toContain("https://new-auth.example.test/authorize");
    expect(await Effect.runPromise(credentials.read("paraty"))).toEqual({
      clientInformation: { client_id: "new-registered-client" },
      authorizationServerUrl: "https://new-auth.example.test/",
    });
    expect(JSON.stringify({ result: result.href, observedClientInformation })).not.toMatch(
      /synthetic-old-confidential-client|synthetic-old-confidential-secret/,
    );
  });

  it("reports incompatible before authorization when discovery advertises no DCR and no public client exists", async () => {
    const { publicClientId: _publicClientId, ...presetWithoutPublicClient } = PARATY_MCP_PRESET;
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
      Effect.runPromise(oauth.begin({ preset: presetWithoutPublicClient, attempt, credentials })),
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
        authorizationServerUrl: "https://auth.example.test/",
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
      resolveAddresses: PUBLIC_TEST_RESOLVER,
    });

    await Effect.runPromise(oauth.revoke({ preset: PARATY_MCP_PRESET, credentials }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://auth.example.test/revoke");
    const body = new URLSearchParams(requests[0]?.body);
    expect(body.has("token")).toBe(true);
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("public-client");
  });
});
