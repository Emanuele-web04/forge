import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  type McpConnectionServiceShape,
  McpConnectionServiceError,
} from "./Services/McpConnectionService.ts";
import { OutboundMcpCredentials } from "./Services/OutboundMcpCredentials.ts";
import type {
  OutboundMcpConnectionRecord,
  OutboundMcpRepositoryShape,
  OutboundMcpStatusUpdate,
} from "./Services/OutboundMcpRepository.ts";
import { makeAuthorizationAttemptRegistry } from "./authorizationAttempts.ts";
import {
  OutboundMcpDecodeError,
  OutboundMcpInputError,
  type McpConsumerBinding,
} from "./consumerBinding.ts";
import {
  makeMcpConnectionService,
  makeSdkMcpConnectionOAuthLifecycle,
} from "./Layers/McpConnectionService.ts";
import { makeLiveMcpToolClient } from "./Layers/McpToolClient.ts";
import { makeOutboundMcpCredentialsLive } from "./Layers/OutboundMcpCredentials.ts";
import { makeOutboundMcpPresetRegistry, type OutboundMcpPreset } from "./presets/index.ts";
import {
  makeFakeMcpAuthority,
  type FakeMcpAuthority,
  type FakeMcpTool,
} from "./testing/fakeMcpAuthority.ts";

type FixtureOperation = "read";

type FixtureContext = {
  readonly authority: FakeMcpAuthority;
  readonly binding: McpConsumerBinding<FixtureOperation>;
  readonly connections: McpConnectionServiceShape;
  readonly credentials: OutboundMcpCredentials["Service"];
};

const PUBLIC_FIXTURE_RESOLVER = async (): Promise<ReadonlyArray<string>> => ["1.1.1.1"];

function makeMemoryRepository(): OutboundMcpRepositoryShape {
  const records = new Map<string, OutboundMcpConnectionRecord>();

  const updateRecord = (input: OutboundMcpStatusUpdate): void => {
    const current = records.get(input.connectionId);
    if (current === undefined) return;
    records.set(input.connectionId, {
      ...current,
      status: input.status,
      errorCategory: input.errorCategory,
      updatedAt: input.updatedAt,
      ...(input.catalogFingerprint === undefined
        ? {}
        : { catalogFingerprint: input.catalogFingerprint }),
      ...(input.lastValidatedAt === undefined ? {} : { lastValidatedAt: input.lastValidatedAt }),
    });
  };

  return {
    list: () =>
      Effect.succeed(
        [...records.values()].toSorted((left, right) =>
          left.connectionId < right.connectionId
            ? -1
            : left.connectionId > right.connectionId
              ? 1
              : 0,
        ),
      ),
    get: (connectionId) => Effect.succeed(records.get(connectionId) ?? null),
    upsertMetadata: (record) => Effect.sync(() => records.set(record.connectionId, record)),
    setStatus: (input) => Effect.sync(() => updateRecord(input)),
    delete: (connectionId) => Effect.sync(() => records.delete(connectionId)),
  };
}

function decodeTextResult(result: unknown) {
  const text =
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray(result.content) &&
    typeof result.content[0] === "object" &&
    result.content[0] !== null &&
    "text" in result.content[0] &&
    typeof result.content[0].text === "string"
      ? result.content[0].text
      : null;
  return text === null
    ? Effect.fail(
        new OutboundMcpDecodeError({
          consumerId: "fixture-consumer",
          operation: "read",
          category: "invalid-result",
        }),
      )
    : Effect.succeed(text);
}

function makeFixtureBinding(requiredTool = "fixture_read"): McpConsumerBinding<FixtureOperation> {
  return {
    id: "fixture-consumer",
    presetIds: new Set(["fixture"]),
    requiredTools: new Set([requiredTool]),
    optionalTools: new Set(),
    operations: {
      read: {
        tool: requiredTool,
        encode: (input) =>
          typeof input === "object" &&
          input !== null &&
          !Array.isArray(input) &&
          Object.keys(input).length === 0
            ? Effect.succeed({})
            : Effect.fail(
                new OutboundMcpInputError({
                  consumerId: "fixture-consumer",
                  operation: "read",
                  category: "invalid-input",
                }),
              ),
        decode: decodeTextResult,
      },
    },
  };
}

function fixtureTool(name: string): FakeMcpTool {
  return {
    name,
    handler: () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function numberedTools(count: number): ReadonlyArray<FakeMcpTool> {
  return Array.from({ length: count }, (_, index) => fixtureTool(`fixture_tool_${index}`));
}

function makeFixturePreset(
  authority: FakeMcpAuthority,
  binding: McpConsumerBinding<FixtureOperation>,
): OutboundMcpPreset {
  return {
    id: "fixture",
    displayName: "Fixture MCP",
    endpoint: authority.endpoint,
    clientMetadata: {
      client_name: "Synara fixture",
      redirect_uris: [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    consumers: [binding],
  };
}

const temporaryHome = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "synara-outbound-mcp-e2e-"))),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
);

function runFixture(
  options: Parameters<typeof makeFakeMcpAuthority>[0],
  binding: McpConsumerBinding<FixtureOperation>,
  use: (context: FixtureContext) => Effect.Effect<void, unknown>,
): Promise<void> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const homeDir = yield* temporaryHome;
        const authority = yield* makeFakeMcpAuthority(options);
        const repository = makeMemoryRepository();

        return yield* Effect.gen(function* () {
          const credentials = yield* OutboundMcpCredentials;
          const toolClient = makeLiveMcpToolClient({
            repository,
            credentials,
            fetch: authority.fetch,
            resolveAddresses: PUBLIC_FIXTURE_RESOLVER,
          });
          yield* Effect.addFinalizer(() => toolClient.closeAll());

          const preset = makeFixturePreset(authority, binding);
          const connections = makeMcpConnectionService({
            repository,
            credentials,
            toolClient,
            oauth: makeSdkMcpConnectionOAuthLifecycle({
              fetch: authority.fetch,
              resolveAddresses: PUBLIC_FIXTURE_RESOLVER,
            }),
            attempts: makeAuthorizationAttemptRegistry({ ttlMs: 60_000 }),
            presets: makeOutboundMcpPresetRegistry([preset]),
            callbackUrl: new URL("http://127.0.0.1:43123/oauth/callback"),
            now: () => "2026-09-01T12:00:00.000Z",
          });

          yield* use({ authority, binding, connections, credentials });
        }).pipe(
          Effect.provide(makeOutboundMcpCredentialsLive(homeDir)),
          Effect.provide(NodeServices.layer),
        );
      }),
    ),
  );
}

function authorizeAndComplete(context: FixtureContext) {
  return Effect.gen(function* () {
    const attempt = yield* context.connections.beginAuthorization({ presetId: "fixture" });
    yield* context.authority.authorize(attempt.authorizationUrl);
    return yield* context.connections.completeAuthorization(context.authority.callbackParameters());
  });
}

describe("outbound MCP foundation integration", () => {
  it(
    "connects through OAuth and the real SDK, refreshes, rejects undeclared operations, and revokes on disconnect",
    { timeout: 20_000 },
    async () => {
      const binding = makeFixtureBinding();
      await runFixture(
        { tools: [fixtureTool("fixture_read")], accessTokenTtlMs: 1_000 },
        binding,
        ({ authority, connections, credentials }) =>
          Effect.gen(function* () {
            expect(
              yield* authorizeAndComplete({
                authority,
                binding,
                connections,
                credentials,
              }),
            ).toEqual({ ok: true });
            expect((yield* connections.list())[0]?.status).toBe("connected");

            const initialCredentials = yield* credentials.read("fixture");
            expect(authority.matchesCurrentCredentials(initialCredentials)).toBe(true);
            expect(authority.metrics().registrations).toBe(1);
            expect(authority.metrics().authorizationCodeExchanges).toBe(1);
            expect(authority.metrics().pkceVerifications).toBe(1);

            const requestsBeforeRejectedInvocation = authority.metrics().mcpRequests;
            const rejected = yield* Effect.flip(
              connections.invoke(binding.id, "undeclared" as FixtureOperation, {}),
            );
            expect(rejected).toBeInstanceOf(McpConnectionServiceError);
            expect(rejected.category).toBe("invalid-operation");
            expect(authority.metrics().mcpRequests).toBe(requestsBeforeRejectedInvocation);

            yield* authority.expireAccessTokens();
            expect(yield* connections.invoke(binding.id, "read", {})).toBe("ok");
            expect(authority.metrics().refreshRotations).toBe(1);
            expect(authority.matchesCurrentCredentials(yield* credentials.read("fixture"))).toBe(
              true,
            );

            yield* connections.disconnect({ connectionId: "fixture" });
            expect((yield* credentials.read("fixture")) === null).toBe(true);
            expect((yield* connections.list())[0]?.status).toBe("disconnected");
            expect(authority.metrics().revocations).toBe(1);
            expect(authority.metrics().activeCredentials).toBe(0);
            expect(authority.metrics().blockedNonLoopbackRequests).toBe(0);

            const requestLog = authority.requestLog();
            expect(requestLog.length).toBeGreaterThan(0);
            expect(requestLog.every(({ origin }) => origin === authority.origin.origin)).toBe(true);
            expect(requestLog.some(({ headers }) => headers.authorization === "[redacted]")).toBe(
              true,
            );
            expect(
              /fixture-(?:access|refresh|authorization-code)|Bearer\s+/.test(
                JSON.stringify(requestLog),
              ),
            ).toBe(false);
          }),
      );
    },
  );

  it(
    "binds refresh and revocation to the public client that owns the token family",
    { timeout: 20_000 },
    async () => {
      const binding = makeFixtureBinding();
      await runFixture(
        { tools: [fixtureTool("fixture_read")] },
        binding,
        ({ authority, connections, credentials }) =>
          Effect.gen(function* () {
            expect(
              (yield* authorizeAndComplete({ authority, binding, connections, credentials })).ok,
            ).toBe(true);
            const originalCredentials = yield* credentials.read("fixture");

            const refreshStatus = yield* authority.attemptCrossClientRefresh();
            expect(refreshStatus).toBe(401);
            expect(authority.metrics().registrations).toBe(2);
            expect(authority.matchesCurrentCredentials(originalCredentials)).toBe(true);
            const revocationStatus = yield* authority.attemptCrossClientRevocation();
            expect(revocationStatus).toBe(401);
            expect(authority.matchesCurrentCredentials(originalCredentials)).toBe(true);
            expect(authority.metrics().refreshRotations).toBe(0);
            expect(authority.metrics().revocations).toBe(0);

            yield* authority.expireAccessTokens();
            expect(yield* connections.invoke(binding.id, "read", {})).toBe("ok");
            const rotatedCredentials = yield* credentials.read("fixture");
            expect(authority.matchesCurrentCredentials(rotatedCredentials)).toBe(true);

            const rotatedRefreshStatus = yield* authority.attemptCrossClientRefresh();
            expect(rotatedRefreshStatus).toBe(401);
            const rotatedRevocationStatus = yield* authority.attemptCrossClientRevocation();
            expect(rotatedRevocationStatus).toBe(401);
            expect(authority.matchesCurrentCredentials(rotatedCredentials)).toBe(true);
            expect(authority.metrics().refreshRotations).toBe(1);
            expect(authority.metrics().revocations).toBe(0);

            const requestLogContainsSecret =
              /fixture-(?:access|refresh|authorization-code)|Bearer\s+/.test(
                JSON.stringify(authority.requestLog()),
              );
            expect(requestLogContainsSecret).toBe(false);
          }),
      );
    },
  );

  it("fails safely when the required TLS generator is unavailable", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        makeFakeMcpAuthority({
          tools: [fixtureTool("fixture_read")],
          opensslExecutable: "synara-intentionally-missing-openssl",
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, category: error.category }),
            onSuccess: () => ({ ok: true as const }),
          }),
        ),
      ),
    );

    expect(result).toEqual({ ok: false, category: "tls-tool-unavailable" });
    expect(JSON.stringify(result).includes("synara-intentionally-missing-openssl")).toBe(false);
  });

  it(
    "follows stable live SDK catalog cursors and rejects duplicate names across pages",
    { timeout: 20_000 },
    async () => {
      const binding = makeFixtureBinding("fixture_tool_0");
      await runFixture({ tools: numberedTools(3), catalogPageSize: 1 }, binding, (context) =>
        Effect.gen(function* () {
          expect(yield* authorizeAndComplete(context)).toEqual({ ok: true });
          expect(context.authority.catalogRequestCursors()).toEqual([
            null,
            "fixture-catalog-page-1",
            "fixture-catalog-page-2",
          ]);
        }),
      );

      await runFixture(
        {
          tools: [fixtureTool("fixture_tool_0"), fixtureTool("fixture_tool_0")],
          catalogPageSize: 1,
        },
        binding,
        (context) =>
          Effect.gen(function* () {
            expect(yield* authorizeAndComplete(context)).toEqual({
              ok: false,
              category: "incompatible-tools",
            });
            expect(context.authority.metrics().catalogRequests).toBe(2);
          }),
      );
    },
  );

  it("accepts at most 20 live SDK catalog pages", { timeout: 20_000 }, async () => {
    const binding = makeFixtureBinding("fixture_tool_0");
    await runFixture({ tools: numberedTools(20), catalogPageSize: 1 }, binding, (context) =>
      Effect.gen(function* () {
        expect(yield* authorizeAndComplete(context)).toEqual({ ok: true });
        expect(context.authority.metrics().catalogRequests).toBe(20);
      }),
    );

    await runFixture({ tools: numberedTools(21), catalogPageSize: 1 }, binding, (context) =>
      Effect.gen(function* () {
        expect(yield* authorizeAndComplete(context)).toEqual({
          ok: false,
          category: "temporarily-unavailable",
        });
        expect(context.authority.metrics().catalogRequests).toBe(20);
      }),
    );
  });

  it("accepts at most 1,024 tools from the live SDK catalog", { timeout: 20_000 }, async () => {
    const binding = makeFixtureBinding("fixture_tool_0");
    await runFixture({ tools: numberedTools(1_024) }, binding, (context) =>
      Effect.gen(function* () {
        expect(yield* authorizeAndComplete(context)).toEqual({ ok: true });
        expect(context.authority.metrics().catalogRequests).toBe(1);
      }),
    );

    await runFixture({ tools: numberedTools(1_025) }, binding, (context) =>
      Effect.gen(function* () {
        expect(yield* authorizeAndComplete(context)).toEqual({
          ok: false,
          category: "temporarily-unavailable",
        });
        expect(context.authority.metrics().catalogRequests).toBe(1);
      }),
    );
  });
});
