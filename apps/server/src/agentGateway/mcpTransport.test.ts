import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayBrowserTools } from "./browserTools.ts";
import { BrowserHostRpcError } from "../browserAutomation/browserHostRpcClient.ts";
import { makeAgentGatewaySessionRegistry } from "./Layers/AgentGatewaySessionRegistry.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "./inFlightRequestRegistry.ts";
import { makeAgentGatewayMcpTransport } from "./mcpTransport.ts";
import { acquireAgentGatewaySessionLease, type AgentGatewaySessionLease } from "./sessionLease.ts";
import type { ToolEntry } from "./toolRuntime.ts";

const NOW = "2026-07-22T03:00:00.000Z";

function makeThread(threadId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-mcp-cancellation"),
    title: threadId,
    modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: TurnId.makeUnsafe(`turn-${threadId}`),
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
  };
}

function makeTransport(input: {
  readonly tool: ToolEntry;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}) {
  const threads = new Map(input.threads.map((thread) => [String(thread.id), thread]));
  let nextSession = 0;
  let nextRandomPartIsSession = true;
  const sessionRegistry = makeAgentGatewaySessionRegistry({
    randomId: () => {
      if (nextRandomPartIsSession) {
        nextSession += 1;
        nextRandomPartIsSession = false;
        return `session-${nextSession}`;
      }
      nextRandomPartIsSession = true;
      return `token-${nextSession}`;
    },
  });
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();
  const credentials = {
    verifySession: sessionRegistry.verify,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests: (token: string, turnId: string) => {
      const session = sessionRegistry.verify(token);
      return session
        ? inFlightRequests.cancelTurn(session.sessionKey, turnId).settled
        : Promise.resolve();
    },
    retireSessionTurn: (token: string, turnId: string) => {
      const session = sessionRegistry.verify(token);
      if (!session) return Promise.resolve();
      sessionRegistry.retireWriteAuthority(token, turnId);
      return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
    },
    revokeSessionToken: (token: string) => {
      const session = sessionRegistry.verify(token);
      sessionRegistry.revoke(token);
      if (session) inFlightRequests.revokeSession(session.sessionKey);
    },
    connectionForThread: (threadId: ThreadId) => {
      const issued = sessionRegistry.issue(threadId, "codex");
      return {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken: issued.token,
      };
    },
  } as unknown as AgentGatewayCredentialsShape;
  const tokenAliases = new Map<string, string>();
  const sessionKeyAliases = new Map<string, string>();
  const leases = new Map<string, AgentGatewaySessionLease>();
  const startRuntime = (threadId: string, tokenAlias: string): AgentGatewaySessionLease => {
    const lease = acquireAgentGatewaySessionLease(
      credentials,
      ThreadId.makeUnsafe(threadId),
      "codex",
    );
    if (!lease) throw new Error("Expected gateway session lease");
    tokenAliases.set(tokenAlias, lease.connection.bearerToken);
    const session = sessionRegistry.verify(lease.connection.bearerToken);
    if (!session) throw new Error("Expected registered gateway session");
    sessionKeyAliases.set(`session-${leases.size + 1}`, session.sessionKey);
    leases.set(threadId, lease);
    return lease;
  };
  input.threads.forEach((thread, index) => {
    startRuntime(String(thread.id), `token-${index + 1}`);
  });
  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.get(String(threadId)))),
  } as unknown as ProjectionSnapshotQueryShape;

  const transport = makeAgentGatewayMcpTransport({
    credentials,
    snapshotQuery,
    tools: [input.tool],
    instructions: "test",
    requireThreadShell: (threadId) => {
      const thread = threads.get(threadId);
      return thread ? Effect.succeed(thread) : Effect.fail(new Error("missing thread"));
    },
  });
  return Object.assign(transport, {
    resolveToken: (token: string) => tokenAliases.get(token) ?? token,
    cancelTurn: (sessionKey: string, turnId: string) =>
      inFlightRequests.cancelTurn(sessionKeyAliases.get(sessionKey) ?? sessionKey, turnId),
    setThreadTurnState: (
      threadId: string,
      state: "running" | "completed" | "error" | "interrupted",
    ) => {
      const thread = threads.get(threadId);
      if (!thread?.latestTurn) return;
      threads.set(threadId, {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          state,
          completedAt: state === "running" ? null : NOW,
        },
      });
    },
    completeTurnAndRestartRuntime: async (
      threadId: string,
      completedTurnId: string,
      replacementTokenAlias: string,
    ) => {
      const outgoing = leases.get(threadId);
      if (!outgoing) throw new Error("Expected outgoing gateway session lease");
      await outgoing.retireTurn(completedTurnId);
      outgoing.release();
      startRuntime(threadId, replacementTokenAlias);
    },
    setThreadTurn: (threadId: string, turnId: string) => {
      const thread = threads.get(threadId);
      if (!thread?.latestTurn) return;
      threads.set(threadId, {
        ...thread,
        latestTurn: {
          ...thread.latestTurn,
          turnId: TurnId.makeUnsafe(turnId),
          state: "running",
          completedAt: null,
        },
      });
    },
  });
}

const post = (transport: ReturnType<typeof makeTransport>, token: string, body: unknown) =>
  transport({ authorizationHeader: `Bearer ${transport.resolveToken(token)}`, body });

describe("makeAgentGatewayMcpTransport cancellation", () => {
  it.effect(
    "rejects turn A's credential after production completion and restart admit turn B",
    () =>
      Effect.gen(function* () {
        let handlerCalls = 0;
        const transport = makeTransport({
          threads: [makeThread("thread-rotated")],
          tool: {
            definition: {
              name: "browser_click",
              description: "test",
              inputSchema: { type: "object" },
            },
            requiredCapability: "browser:control",
            requiresActiveTurn: true,
            handler: () => {
              handlerCalls += 1;
              return Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] });
            },
          },
        });
        yield* Effect.promise(() =>
          transport.completeTurnAndRestartRuntime(
            "thread-rotated",
            "turn-thread-rotated",
            "token-b",
          ),
        );
        transport.setThreadTurn("thread-rotated", "turn-b");
        const body = {
          jsonrpc: "2.0",
          id: "browser-click",
          method: "tools/call",
          params: { name: "browser_click", arguments: {} },
        };

        const lateA = yield* post(transport, "token-1", body);
        assert.equal(lateA.status, 401);
        const turnB = yield* post(transport, "token-b", body);
        assert.equal(turnB.status, 200);
        assert.equal(handlerCalls, 1);
      }),
  );

  it.effect(
    "cancels a detached MCP call by gateway session and turn without a client notification",
    () =>
      Effect.gen(function* () {
        const hostStarted = yield* Deferred.make<void>();
        const hostAbortObserved = yield* Deferred.make<void>();
        let hostCalls = 0;
        const browserWait = makeAgentGatewayBrowserTools({
          available: true,
          execute: () => {
            hostCalls += 1;
            return Effect.tryPromise({
              try: (signal) => {
                return new Promise<never>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      Deferred.doneUnsafe(hostAbortObserved, Effect.void);
                      reject(new Error("browser host request aborted"));
                    },
                    { once: true },
                  );
                  // Wake the Stop path before tryPromise returns, reproducing
                  // the re-entrant window where a direct interrupt would miss
                  // Effect's not-yet-installed AbortController finalizer.
                  Deferred.doneUnsafe(hostStarted, Effect.void);
                });
              },
              catch: (error) => new BrowserHostRpcError("transport", String(error)),
            });
          },
        }).find((tool) => tool.definition.name === "browser_wait");
        assert.isDefined(browserWait);
        const transport = makeTransport({
          threads: [makeThread("thread-detached")],
          tool: browserWait!,
        });
        const body = {
          jsonrpc: "2.0",
          id: "detached-browser-wait",
          method: "tools/call",
          params: {
            name: "browser_wait",
            arguments: {
              tabId: "53756993-1de8-47a5-82c9-e00766199802",
              conditions: [{ kind: "text", text: "STOP_SENTINEL_NEVER_APPEARS", state: "present" }],
              timeoutMs: 30_000,
            },
          },
        };

        const request = yield* post(transport, "token-1", body).pipe(Effect.forkChild);
        yield* Deferred.await(hostStarted);

        const cancellation = transport.cancelTurn("session-1", "turn-thread-detached");
        assert.equal(cancellation.count, 1);
        yield* Effect.promise(() => cancellation.settled);
        yield* Deferred.await(hostAbortObserved);
        assert.deepEqual(yield* Fiber.join(request), { status: 202 });

        // A detached cell can race and issue the request after Stop. The turn
        // tombstone must reject it before the handler starts.
        assert.deepEqual(yield* post(transport, "token-1", { ...body, id: "late-request" }), {
          status: 202,
        });
        transport.setThreadTurnState("thread-detached", "interrupted");
        const afterProjectionSettled = yield* post(transport, "token-1", {
          ...body,
          id: "after-turn-terminal",
        });
        assert.equal(afterProjectionSettled.status, 200);
        assert.equal(hostCalls, 1);
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect("cleans a completed request before the same JSON-RPC id is reused", () =>
    Effect.gen(function* () {
      const transport = makeTransport({
        threads: [makeThread("thread-reuse")],
        tool: {
          definition: {
            name: "unused",
            description: "unused",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: () => Effect.never,
        },
      });
      const ping = { jsonrpc: "2.0", id: "reusable", method: "ping" };

      for (let iteration = 0; iteration < 25; iteration += 1) {
        const response = yield* post(transport, "token-1", ping);
        assert.deepEqual(response, {
          status: 200,
          body: { jsonrpc: "2.0", id: "reusable", result: {} },
        });
      }
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "interrupts only the matching session request and keeps a following ping responsive",
    () =>
      Effect.gen(function* () {
        const startedOne = yield* Deferred.make<void>();
        const startedTwo = yield* Deferred.make<void>();
        const interruptedOne = yield* Deferred.make<void>();
        const interruptedTwo = yield* Deferred.make<void>();
        const releaseFirstCleanup = yield* Deferred.make<void>();
        const tool: ToolEntry = {
          definition: {
            name: "slow",
            description: "Wait until cancelled",
            inputSchema: { type: "object" },
          },
          requiredCapability: "thread:read",
          handler: (_args, context) => {
            const first = context.callerSessionKey.endsWith(":session-1");
            return Deferred.succeed(first ? startedOne : startedTwo, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(first ? interruptedOne : interruptedTwo, undefined);
                  if (first) yield* Deferred.await(releaseFirstCleanup);
                }),
              ),
            );
          },
        };
        const transport = makeTransport({
          tool,
          threads: [makeThread("thread-one"), makeThread("thread-two")],
        });
        const slowBody = {
          jsonrpc: "2.0",
          id: "shared-id",
          method: "tools/call",
          params: { name: "slow", arguments: {} },
        };
        const requestOne = yield* post(transport, "token-1", slowBody).pipe(Effect.forkChild);
        const requestTwo = yield* post(transport, "token-2", slowBody).pipe(Effect.forkChild);
        yield* Deferred.await(startedOne);
        yield* Deferred.await(startedTwo);

        const cancellation = yield* post(transport, "token-1", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "shared-id", reason: "test" },
        });
        assert.deepEqual(cancellation, { status: 202 });
        yield* Deferred.await(interruptedOne);
        assert.isUndefined(yield* Deferred.poll(interruptedTwo));

        const ping = yield* post(transport, "token-1", {
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          method: "ping",
        });
        assert.equal(ping.status, 200);
        assert.deepEqual(ping.body, {
          jsonrpc: "2.0",
          id: "ping-after-cancel",
          result: {},
        });
        assert.isUndefined(requestOne.pollUnsafe());
        yield* Deferred.succeed(releaseFirstCleanup, undefined);

        yield* post(transport, "token-2", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "shared-id" },
        });
        yield* Deferred.await(interruptedTwo);
        assert.deepEqual(yield* Fiber.join(requestOne), { status: 202 });
        assert.deepEqual(yield* Fiber.join(requestTwo), { status: 202 });
      }).pipe(Effect.timeout("2 seconds")),
  );

  it.effect(
    "runs batch requests concurrently and applies cancellation without head-of-line blocking",
    () =>
      Effect.gen(function* () {
        const interrupted = yield* Deferred.make<void>();
        const transport = makeTransport({
          threads: [makeThread("thread-batch")],
          tool: {
            definition: {
              name: "slow",
              description: "Wait until cancelled",
              inputSchema: { type: "object" },
            },
            requiredCapability: "thread:read",
            handler: () =>
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
                ),
              ),
          },
        });

        const response = yield* post(transport, "token-1", [
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: "slow-batch" },
          },
          {
            jsonrpc: "2.0",
            id: "slow-batch",
            method: "tools/call",
            params: { name: "slow", arguments: {} },
          },
          { jsonrpc: "2.0", id: "fast-batch", method: "ping" },
        ]);

        yield* Deferred.await(interrupted);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, [{ jsonrpc: "2.0", id: "fast-batch", result: {} }]);
      }).pipe(Effect.timeout("2 seconds")),
  );
});
