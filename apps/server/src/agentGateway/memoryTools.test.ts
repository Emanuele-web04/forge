import { assert, describe, it } from "@effect/vitest";
import {
  ExternalMcpCapability,
  MindError,
  MindMemoryId,
  ProjectId,
  ProviderKind,
  ThreadId,
  TurnId,
  type MindConfirmResult,
  type MindListResult,
  type MindMemory,
  type MindMemoryMatch,
  type MindPinResult,
  type MindPruneResult,
  type MindRecallResult,
  type MindRememberResult,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect } from "effect";

import { makeAgentGatewaySessionRegistry } from "./Layers/AgentGatewaySessionRegistry.ts";
import {
  MIND_MEMORY_TEXT_MAX_CHARS,
  makeAgentGatewayMemoryTools,
  type MindServiceShape,
} from "./memoryTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-mem");
const CALLER_THREAD_ID = "thread-mem";
const CALLER_TURN_ID = "turn-mem";

function makeThreadShell(projectId = PROJECT_ID): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(CALLER_THREAD_ID),
    projectId,
    title: "Memory thread",
    modelSelection: { provider: "codex" as ProviderKind, model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
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
      turnId: TurnId.makeUnsafe(CALLER_TURN_ID),
      state: "running",
      requestedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    handoff: null,
    session: null,
  };
}

function makeMockMindService(overrides?: Partial<MindServiceShape>): MindServiceShape {
  const memory = (memoryId: string, projectId: string, text: string): MindMemory =>
    ({
      memoryId: MindMemoryId.makeUnsafe(memoryId),
      projectId,
      text,
      weight: 1,
      accessCount: 0,
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }) as MindMemory;

  return {
    remember: ({ text, projectId }) =>
      Effect.succeed({
        memory: memory(`memory:${projectId}:${text}`, projectId, text),
        status: "created",
      } as MindRememberResult),
    recall: ({ projectId, query }) =>
      Effect.succeed({
        items: [
          {
            memory: memory(
              `memory:${projectId}:sample`,
              projectId,
              query ? `Result for ${query}` : "Sample memory",
            ),
            rank: 1,
            decayedWeight: 1,
          } as MindMemoryMatch,
        ],
        digest: query ? `Digest for ${query}` : "Sample digest",
      } as MindRecallResult),
    confirm: ({ memoryId, projectId }) =>
      Effect.succeed({
        memory: memory(memoryId, projectId, "Confirmed memory"),
        alreadyConfirmedInTurn: false,
      } as MindConfirmResult),
    forget: () => Effect.succeed({ deleted: true }),
    pin: ({ memoryId, projectId }) =>
      Effect.succeed({
        memory: memory(memoryId, projectId, "Pinned memory"),
      } as MindPinResult),
    list: () => Effect.succeed({ memories: [] } as MindListResult),
    prune: ({ projectId }) =>
      Effect.succeed({
        deletedIds: [MindMemoryId.makeUnsafe(`memory:${projectId}:pruned`)],
      } as MindPruneResult),
    ...overrides,
  };
}

function makeContext(): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "session-mem",
      threadId: CALLER_THREAD_ID,
      provider: "codex" as ProviderKind,
      turnId: CALLER_TURN_ID,
    },
    callerThreadId: CALLER_THREAD_ID,
    callerSessionKey: "session-mem",
    callerProvider: "codex" as ProviderKind,
    callerCapabilities: new Set(["memory:use" as const]),
    callerTurnId: CALLER_TURN_ID,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

function requireThreadShell(threadId: string) {
  if (threadId !== CALLER_THREAD_ID) {
    return Effect.fail(new Error(`Thread "${threadId}" was not found.`));
  }
  return Effect.succeed(makeThreadShell());
}

function firstText(result: McpToolCallResult) {
  const item = result.content[0];
  return item?.type === "text" ? item.text : "";
}

function makeTools(overrides?: Partial<MindServiceShape>) {
  return makeAgentGatewayMemoryTools({
    mindService: makeMockMindService(overrides),
    requireThreadShell,
  });
}

describe("makeAgentGatewayMemoryTools", () => {
  it("exposes the five memory tools with the memory:use capability", () => {
    const tools = makeTools();

    assert.equal(Object.keys(tools).length, 5);
    for (const name of [
      "synara_remember",
      "synara_recall_memories",
      "synara_confirm_memory",
      "synara_forget_memory",
      "synara_prune_memories",
    ]) {
      assert.property(tools, name);
      assert.equal(tools[name]!.requiredCapability, "memory:use");
      assert.equal(tools[name]!.definition.name, name);
    }
  });

  it("does not expose memory:use to external MCP capabilities", () => {
    const externalCapabilities = new Set(ExternalMcpCapability.literals);
    assert.isFalse(externalCapabilities.has("memory:use" as never));
  });

  it("grants memory:use only to provider sessions", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "mem" });
    const session = registry.issue(ThreadId.makeUnsafe(CALLER_THREAD_ID), "codex");
    assert.isTrue(session.capabilities.has("memory:use"));

    // No other session type in the registry should receive the capability.
    const otherSession = registry.issue(ThreadId.makeUnsafe("thread-other"), "claudeAgent");
    assert.isTrue(otherSession.capabilities.has("memory:use"));
    assert.equal(otherSession.capabilities.size, session.capabilities.size);
  });

  it.effect("remembers a fact and returns memoryId plus status", () =>
    Effect.gen(function* () {
      const tools = makeTools();
      const result = yield* tools.synara_remember!.handler({ text: "Fact A" }, makeContext());
      const text = firstText(result);
      const parsed = JSON.parse(text);
      assert.equal(parsed.memoryId, `memory:${PROJECT_ID}:Fact A`);
      assert.equal(parsed.status, "created");
    }),
  );

  it.effect("rejects text over the memory length limit", () =>
    Effect.gen(function* () {
      const tools = makeTools();
      const longText = "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS + 1);
      const result = yield* tools.synara_remember!.handler({ text: longText }, makeContext());
      assert.isTrue(result.isError);
      const text = firstText(result);
      const parsed = JSON.parse(text);
      assert.equal(parsed.error.code, "invalid_input");
      assert.include(parsed.error.message, "at most");
    }),
  );

  it.effect("recalls memories with an optional query", () =>
    Effect.gen(function* () {
      const tools = makeTools();
      const withQuery = yield* tools.synara_recall_memories!.handler(
        { query: "search" },
        makeContext(),
      );
      const parsed = JSON.parse(firstText(withQuery));
      assert.isArray(parsed.items);
      assert.equal(parsed.items.length, 1);
      assert.equal(parsed.items[0].memory.text, "Result for search");
      assert.equal(parsed.digest, "Digest for search");

      const withoutQuery = yield* tools.synara_recall_memories!.handler({}, makeContext());
      const parsedNoQuery = JSON.parse(firstText(withoutQuery));
      assert.equal(parsedNoQuery.items[0].memory.text, "Sample memory");
      assert.equal(parsedNoQuery.digest, "Sample digest");
    }),
  );

  it.effect("confirms a memory by id", () =>
    Effect.gen(function* () {
      const tools = makeTools();
      const result = yield* tools.synara_confirm_memory!.handler(
        { memory_id: "mem-123" },
        makeContext(),
      );
      const parsed = JSON.parse(firstText(result));
      assert.equal(parsed.memory.memoryId, "mem-123");
    }),
  );

  it.effect("forgets a memory by id", () =>
    Effect.gen(function* () {
      const tools = makeTools();
      const result = yield* tools.synara_forget_memory!.handler(
        { memory_id: "mem-123" },
        makeContext(),
      );
      const parsed = JSON.parse(firstText(result));
      assert.equal(parsed.deleted, true);
    }),
  );

  it.effect("prunes memories and returns deleted ids", () =>
    Effect.gen(function* () {
      const tools = makeTools();
      const result = yield* tools.synara_prune_memories!.handler({}, makeContext());
      const parsed = JSON.parse(firstText(result));
      assert.deepEqual(parsed.deletedIds, [`memory:${PROJECT_ID}:pruned`]);
    }),
  );

  it.effect("surfaces mind service errors as gateway tool errors", () =>
    Effect.gen(function* () {
      const tools = makeTools({
        remember: () =>
          Effect.fail(
            new MindError({ code: "mind.memory-cap-reached", message: "Project cap reached" }),
          ),
      });
      const result = yield* tools.synara_remember!.handler({ text: "Fact" }, makeContext());
      assert.isTrue(result.isError);
      const parsed = JSON.parse(firstText(result));
      assert.equal(parsed.error.code, "mind.memory-cap-reached");
      assert.include(parsed.error.message, "Project cap reached");
    }),
  );

  it.effect("reports an error when the caller thread cannot be resolved", () =>
    Effect.gen(function* () {
      const tools = makeAgentGatewayMemoryTools({
        mindService: makeMockMindService(),
        requireThreadShell: (threadId) =>
          Effect.fail(new Error(`Thread "${threadId}" was not found.`)),
      });
      const result = yield* tools.synara_remember!.handler({ text: "Fact" }, makeContext());
      assert.isTrue(result.isError);
      const parsed = JSON.parse(firstText(result));
      assert.equal(parsed.error.code, "mind_error");
      assert.include(parsed.error.message, "not found");
    }),
  );
});
