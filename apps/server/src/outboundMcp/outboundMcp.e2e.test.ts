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
import { OutboundMcpDecodeError, type McpConsumerBinding } from "./consumerBinding.ts";
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
          });
          yield* Effect.addFinalizer(() => toolClient.closeAll());

          const preset = makeFixturePreset(authority, binding);
          const connections = makeMcpConnectionService({
            repository,
            credentials,
            toolClient,
            oauth: makeSdkMcpConnectionOAuthLifecycle({ fetch: authority.fetch }),
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
              connections.invoke(binding, "undeclared" as FixtureOperation, {}),
            );
            expect(rejected).toBeInstanceOf(McpConnectionServiceError);
            expect(rejected.category).toBe("invalid-operation");
            expect(authority.metrics().mcpRequests).toBe(requestsBeforeRejectedInvocation);

            yield* authority.expireAccessTokens();
            expect(yield* connections.invoke(binding, "read", {})).toBe("ok");
            expect(authority.metrics().refreshRotations).toBe(1);
            expect(authority.matchesCurrentCredentials(yield* credentials.read("fixture"))).toBe(
              true,
            );

            yield* connections.disconnect({ connectionId: "fixture" });
            expect(yield* credentials.read("fixture")).toBeNull();
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
            expect(JSON.stringify(requestLog)).not.toMatch(
              /fixture-(?:access|refresh|authorization-code)|Bearer\s+/,
            );
          }),
      );
    },
  );

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
