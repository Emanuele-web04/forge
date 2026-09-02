import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayKanbanTools } from "./kanbanTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const NOW_ISO = "2026-08-16T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const WORKSPACE_PATHS = {
  homeDir: "/home/tester",
  chatWorkspaceRoot: "/home/tester/chats",
};

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:kanban",
    threadId: "thread-caller",
    provider: "claudeAgent",
    turnId: "turn-caller",
  },
  callerThreadId: "thread-caller",
  callerSessionKey: "gateway-session:kanban",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn-caller",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

const otherContext: ToolContext = {
  ...context,
  principal: {
    ...context.principal,
    threadId: "thread-other",
    turnId: "turn-other",
  },
  callerThreadId: "thread-other",
  callerTurnId: "turn-other",
};

function makeProjectShell(
  projectId = "project-a",
  title = "Project A",
  workspaceRoot = `/repos/${title}`,
  kind: "project" | "chat" = "project",
) {
  return {
    id: ProjectId.makeUnsafe(projectId),
    title,
    kind,
    workspaceRoot,
  } as const;
}

type ProjectShellRow = ReturnType<typeof makeProjectShell>;

const projectA = [makeProjectShell()];

function makeThreadShell(
  threadId: string,
  projectId = "project-a",
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe(projectId),
    title: threadId,
    modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
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
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
    handoff: null,
    session: null,
    ...overrides,
  };
}

/** Completed-turn shell with an idle live session row (a settled card). */
function makeSessionShell(
  threadId: string,
  projectId = "project-a",
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return makeThreadShell(threadId, projectId, {
    latestTurn: {
      turnId: TurnId.makeUnsafe(`turn-${threadId}`),
      state: "completed",
      requestedAt: NOW_ISO,
      startedAt: NOW_ISO,
      completedAt: NOW_ISO,
      assistantMessageId: null,
    },
    session: {
      threadId: ThreadId.makeUnsafe(threadId),
      status: "idle",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW_ISO,
    },
    ...overrides,
  });
}

/** Settled card whose turn is running against a live session row. */
const makeRunningShell = (threadId: string): OrchestrationThreadShell =>
  makeSessionShell(threadId, "project-a", {
    latestTurn: {
      ...makeSessionShell(threadId).latestTurn!,
      state: "running",
      completedAt: null,
    },
    session: {
      threadId: ThreadId.makeUnsafe(threadId),
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: TurnId.makeUnsafe(`turn-${threadId}`),
      lastError: null,
      updatedAt: NOW_ISO,
    },
  });

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<ProjectShellRow>,
): ProjectionSnapshotQueryShape {
  return {
    getShellSnapshot: () => Effect.succeed({ projects: [...projects], threads: [...threads] }),
  } as unknown as ProjectionSnapshotQueryShape;
}

function makeTools(input: {
  threads: ReadonlyArray<OrchestrationThreadShell>;
  projects?: ReadonlyArray<ProjectShellRow>;
  runCreateThreads?: (args: unknown) => unknown;
  startTurn?: (args: unknown) => unknown;
  interruptTurn?: (args: unknown) => unknown;
  assertCallerMayDriveThread?: () => Effect.Effect<void>;
}) {
  const started: Array<{
    threadId: string;
    message: string;
    dispatchMode: string;
  }> = [];
  const interrupted: Array<{ threadId: string }> = [];
  const created: Array<unknown> = [];
  const tools = makeAgentGatewayKanbanTools({
    snapshotQuery: makeSnapshot(input.threads, input.projects ?? projectA),
    workspacePaths: WORKSPACE_PATHS,
    now: () => NOW_MS,
    helpers: {
      requireThreadShell: (threadId) => {
        const found = input.threads.find((thread) => String(thread.id) === threadId);
        if (found) return Effect.succeed(found);
        if (threadId === "thread-caller" || threadId === "thread-other") {
          return Effect.succeed(makeThreadShell(threadId));
        }
        return Effect.fail(new Error(`missing thread ${threadId}`));
      },
      assertCallerMayDriveThread: (input.assertCallerMayDriveThread ??
        (() => Effect.void)) as never,
      runCreateThreads: ((args: unknown) => {
        created.push(args);
        return input.runCreateThreads ? input.runCreateThreads(args) : Effect.succeed(mcpOk({}));
      }) as never,
      startTurn: ((args: unknown) => {
        started.push(args as never);
        return input.startTurn ? input.startTurn(args) : Effect.succeed({ sequence: 42 });
      }) as never,
      interruptTurn: ((args: unknown) => {
        interrupted.push(args as never);
        return input.interruptTurn ? input.interruptTurn(args) : Effect.succeed({ sequence: 7 });
      }) as never,
    },
  });
  return { tools, started, interrupted, created };
}

function mcpOk(text: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(text) }] };
}

const toolById = (tools: ReadonlyArray<ToolEntry>, name: string): ToolEntry => {
  const tool = tools.find((entry) => entry.definition.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

const runHandler = (tool: ToolEntry, args: Record<string, unknown>, ctx = context) =>
  Effect.runPromise(tool.handler(args, ctx));

/** Loose view of every kanban payload shape; per-test field reads stay self-documenting. */
type JsonPayload = Record<string, any>;

const jsonText = (result: McpToolCallResult): JsonPayload => {
  const content = result.content[0];
  // Surface the raw isError flag alongside the parsed text so callers can
  // assert error-ness and payload fields against one view.
  if (result.isError) {
    return {
      isError: true,
      __errorText: content?.type === "text" ? content.text : "",
    };
  }
  return {
    isError: false,
    ...(JSON.parse(content?.type === "text" ? content.text : "{}") as JsonPayload),
  };
};

type BoardPayload = {
  isError?: boolean;
  __errorText?: string;
  projects: Array<{
    projectId: string;
    columns: Array<{ key: string; cards: Array<Record<string, any>> }>;
  }>;
  truncated?: boolean;
  truncatedReason?: string;
  asOf?: string;
  callerThreadId?: string;
};

/** Run the board read and index every project's cards by column key. */
async function boardByColumn(tools: ReadonlyArray<ToolEntry>, args: Record<string, unknown> = {}) {
  const payload = jsonText(
    await runHandler(toolById(tools, "synara_read_kanban_board"), args),
  ) as BoardPayload & {
    projects: Array<{
      columns: Array<{ key: string; cards: Array<{ threadId: string }> }>;
    }>;
  };
  return {
    payload,
    columnsOf: (index = 0) =>
      Object.fromEntries(
        payload.projects[index]!.columns.map((column) => [column.key, column.cards]),
      ),
  };
}

describe("synara_read_kanban_board", () => {
  it("derives v2 columns + attention flags and skips non-project containers", async () => {
    const { tools } = makeTools({
      threads: [
        makeThreadShell("thread-draft"),
        makeRunningShell("thread-running"),
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
        makeSessionShell("thread-done"),
        makeThreadShell("thread-chat", "chat-container"),
      ],
      projects: [
        makeProjectShell(),
        makeProjectShell("chat-container", "Chats", WORKSPACE_PATHS.chatWorkspaceRoot, "chat"),
      ],
    });

    const { payload, columnsOf } = await boardByColumn(tools);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]!.projectId).toBe("project-a");
    const byColumn = columnsOf();
    expect(
      ["draft", "inProgress", "awaitingYou", "done"].map((key) =>
        (byColumn[key] ?? []).map((card) => card.threadId),
      ),
    ).toEqual([["thread-draft"], ["thread-running"], ["thread-waiting"], ["thread-done"]]);
    const waitingCard = byColumn.awaitingYou![0]!;
    expect(waitingCard.attention).toContain("awaiting-approval");
    // The chat container's thread must not surface on the ordinary-project board.
    expect(Object.values(byColumn).flatMap((cards) => cards.map((c) => c.threadId))).not.toContain(
      "thread-chat",
    );
  });

  it("rejects a board read for a project other than the caller's and hides archived threads", async () => {
    const archivedRunning = makeSessionShell("thread-archived", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-archived").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-archived"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-archived"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
      archivedAt: NOW_ISO,
    });
    const { tools } = makeTools({
      threads: [archivedRunning, makeRunningShell("thread-live")],
    });

    const empty = await boardByColumn(tools, { projectId: "project-nope" });
    expect(empty.payload.isError).toBe(true);
    expect(empty.payload.__errorText).toContain("project-nope");

    const full = await boardByColumn(tools, { projectId: "project-a" });
    const cardIds = full.payload.projects.flatMap((project) =>
      project.columns.flatMap((column) => column.cards.map((card) => card.threadId)),
    );
    expect(cardIds).toContain("thread-live");
    expect(cardIds).not.toContain("thread-archived");
  });

  it("filters to one project and exposes card metadata", async () => {
    const { tools } = makeTools({
      threads: [makeRunningShell("thread-a"), makeThreadShell("thread-b", "project-b")],
      projects: [makeProjectShell(), makeProjectShell("project-b", "Project B")],
    });

    const { payload, columnsOf } = await boardByColumn(tools, {
      projectId: "project-a",
    });
    expect(payload.projects).toHaveLength(1);
    const populatedColumns = payload.projects[0]!.columns.filter(
      (column) => column.cards.length > 0,
    );
    expect(populatedColumns).toHaveLength(1);
    const card = columnsOf().inProgress![0]!;
    expect(card.threadId).toBe("thread-a");
    expect(card.model).toBe("gpt-5.6-sol");
    expect(card.summary).toBeTruthy();
  });

  it("caps the board at MAX_CARDS_PER_BOARD and reports truncated with a fallback hint", async () => {
    const threads = Array.from({ length: 501 }, (_, index) => makeThreadShell(`thread-${index}`));
    const { tools } = makeTools({ threads });

    const { payload } = await boardByColumn(tools);
    expect(payload.truncated).toBe(true);
    expect(payload.truncatedReason).toContain("synara_read_kanban_card");
    const totalCards = payload.projects.reduce(
      (sum, project) =>
        sum + project.columns.reduce((columnSum, column) => columnSum + column.cards.length, 0),
      0,
    );
    expect(totalCards).toBe(500);
  });

  it("omits projects past the board cap instead of emitting empty ghost columns", async () => {
    const { tools } = makeTools({
      threads: [
        ...Array.from({ length: 501 }, (_, index) => makeThreadShell(`thread-a-${index}`)),
        makeThreadShell("thread-b-0", "project-b"),
      ],
      projects: [makeProjectShell(), makeProjectShell("project-b", "B")],
    });

    const { payload } = await boardByColumn(tools);
    expect(payload.truncated).toBe(true);
    expect(payload.projects.map((project) => project.projectId)).toEqual(["project-a"]);
  });

  it("does not report truncated under the cap", async () => {
    const { tools } = makeTools({ threads: [makeThreadShell("thread-draft")] });
    const { payload } = await boardByColumn(tools);
    expect(payload.truncated).toBe(false);
  });
});

describe("synara_read_kanban_card", () => {
  it("returns the single card with column and attention flags", async () => {
    const { tools } = makeTools({
      threads: [
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
      ],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_read_kanban_card"), {
        threadId: "thread-waiting",
      }),
    ) as {
      card: {
        threadId: string;
        column: string;
        attention: string[];
        model: string;
      };
      asOf: string;
      callerThreadId: string;
    };
    expect(result.card.threadId).toBe("thread-waiting");
    expect(result.card.column).toBe("awaitingYou");
    expect(result.card.attention).toContain("awaiting-approval");
    expect(result.card.model).toBe("gpt-5.6-sol");
    expect(result.asOf).toBe(NOW_ISO);
    expect(result.callerThreadId).toBe("thread-caller");
  });

  it("rejects a card whose project is not an ordinary project row", async () => {
    const { tools } = makeTools({
      threads: [
        makeThreadShell("thread-caller", "chat-container"),
        makeThreadShell("thread-chat", "chat-container"),
      ],
      projects: [
        makeProjectShell("chat-container", "Chats", WORKSPACE_PATHS.chatWorkspaceRoot, "chat"),
      ],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_read_kanban_card"), {
        threadId: "thread-chat",
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("no Kanban card");
  });

  it.each([
    {
      label: "missing",
      threadId: "thread-missing",
      errorPart: "thread-missing",
    },
    {
      label: "archived",
      threadId: "thread-archived",
      errorPart: "archived",
      archived: true as const,
    },
  ])("rejects a $label thread with an error result", async ({ threadId, errorPart, archived }) => {
    const { tools } = makeTools({
      threads: [
        makeThreadShell("thread-archived", "project-a", {
          archivedAt: NOW_ISO,
        }),
      ].filter(() => archived),
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_read_kanban_card"), {
        threadId,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain(errorPart);
  });
});

describe("synara_create_kanban_task", () => {
  /** A creation-saga payload that satisfies the SynaraCreateThreadsResult contract. */
  const createOk = (threadIds: string[]) =>
    Effect.succeed(
      mcpOk({
        operationId: "op-1",
        requestId: "req-1",
        requestedCount: threadIds.length,
        createdCount: threadIds.length,
        threadIds,
        threads: threadIds.map((threadId, index) => ({
          index,
          threadId,
          projectId: "project-a",
          title: "created",
          target: { provider: "claudeAgent", model: "sonnet-5" },
          provider: "claudeAgent",
          model: "sonnet-5",
          runtimeMode: "approval-required",
          environment: "local",
          branch: null,
          worktreePath: null,
          status: "task_dispatched",
        })),
      }),
    );

  it("forwards the spec to runCreateThreads and returns threadId + card", async () => {
    const { tools, created } = makeTools({
      threads: [makeSessionShell("thread-created")],
      runCreateThreads: () => createOk(["thread-created"]),
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_create_kanban_task"), {
        title: "Fix bug",
        requestId: "req-1",
      }),
    ) as { threadId: string; title: string; card: { column: string } };
    expect(created).toHaveLength(1);
    const spec = (
      created[0] as {
        threads: Array<{
          title: string;
          prompt: string;
          target: { provider: string };
        }>;
      }
    ).threads[0]!;
    expect(spec.title).toBe("Fix bug");
    expect(spec.prompt).toBe("Fix bug");
    expect(spec.target.provider).toBe("claudeAgent");
    expect(result.threadId).toBe("thread-created");
    expect(result.card.column).toBe("done");
  });

  it("uses description as the first-turn prompt and forwards projectId", async () => {
    const { tools, created } = makeTools({
      threads: [makeSessionShell("thread-created")],
      runCreateThreads: () => createOk(["thread-created"]),
    });

    const result = await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      description: "Investigate the flaky test first.",
      projectId: "project-a",
      requestId: "req-2",
    });
    expect(result.isError).toBeFalsy();
    expect(created).toHaveLength(1);
    const spec = (created[0] as { threads: Array<{ prompt: string; projectId: string }> })
      .threads[0]!;
    expect(spec.prompt).toBe("Investigate the flaky test first.");
    expect(spec.projectId).toBe("project-a");
  });

  it("defaults the spawned task to the caller's own thread model", async () => {
    const { tools, created } = makeTools({
      threads: [
        makeThreadShell("thread-caller", "project-a", {
          modelSelection: { provider: "claudeAgent", model: "sonnet-5" },
        }),
        makeSessionShell("thread-created"),
      ],
      runCreateThreads: () => createOk(["thread-created"]),
    });
    const readTarget = () =>
      (
        created[created.length - 1] as {
          threads: Array<{ target: { provider: string; model: string } }>;
        }
      ).threads[0]!.target;

    // No model argument: the task inherits the caller's own non-default model
    // instead of the provider default.
    await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      requestId: "req-caller-model",
    });
    expect(readTarget()).toEqual({ provider: "claudeAgent", model: "sonnet-5" });

    // An explicit model argument still wins over the caller's own model.
    await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      model: "opus-4.8",
      requestId: "req-explicit-model",
    });
    expect(readTarget()).toEqual({ provider: "claudeAgent", model: "opus-4.8" });
  });

  it("returns the failed creation result untouched as isError", async () => {
    const { tools } = makeTools({
      threads: [],
      runCreateThreads: () =>
        Effect.succeed({
          isError: true,
          content: [{ type: "text", text: "creation failed: quota exceeded" }],
        }),
    });

    const result = await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      requestId: "req-3",
    });
    expect(result.isError).toBe(true);
    expect((jsonText(result) as { __errorText?: string }).__errorText).toContain("creation failed");
  });

  it("rejects concurrent writes past the per-caller in-flight cap", async () => {
    // Block runCreateThreads until every slot-holder is released, so the
    // in-flight count stays at the cap while the over-cap call arrives.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tools } = makeTools({
      threads: [makeSessionShell("thread-created")],
      runCreateThreads: () => Effect.promise(() => held.then(() => mcpOk({}))),
    });
    const tool = toolById(tools, "synara_create_kanban_task");
    const args = { title: "Fix bug" };

    // Fire 4 held calls (filling the cap) plus a 5th that must be rejected.
    const heldResults = ["a", "b", "c", "d"].map((suffix) =>
      runHandler(tool, { ...args, requestId: `req-${suffix}` }),
    );
    // Yield so the held calls enter runCreateThreads and hold their slots.
    await Promise.resolve();
    const overCap = await runHandler(tool, { ...args, requestId: "req-e" });
    expect(overCap.isError).toBe(true);
    expect((jsonText(overCap) as { __errorText?: string }).__errorText).toContain(
      "Too many concurrent kanban write calls",
    );

    // Release the held calls so they settle and the process can exit.
    release();
    await Promise.allSettled(heldResults);
  });

  it("fails explicitly when the saga result is not valid JSON", async () => {
    const sagaContent = [{ type: "text" as const, text: "{not json" }];
    const { tools } = makeTools({
      threads: [],
      runCreateThreads: () => Effect.succeed({ isError: false, content: sagaContent }),
    });

    const result = await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      requestId: "req-malformed-json",
    });
    expect(result.isError).toBe(true);
    expect((jsonText(result) as { __errorText?: string }).__errorText).toContain(
      "could not decode the creation saga result",
    );
  });

  it.each([
    {
      label: "string-threadIds",
      payload: { operationId: "op-1", threadIds: "thread-x" },
    },
    {
      label: "numeric-threadIds-entry",
      payload: { operationId: "op-1", threadIds: [42] },
    },
    {
      label: "object-threadIds",
      payload: { operationId: "op-1", threadIds: { 0: "thread-x" } },
    },
    {
      label: "numeric-threadId-in-threads",
      payload: { operationId: "op-1", threads: [{ threadId: 42 }] },
    },
    {
      label: "string-element-in-threads",
      payload: { operationId: "op-1", threads: ["thread-x"] },
    },
    {
      label: "numeric-operationId",
      payload: { operationId: 7, threadIds: ["thread-x"] },
    },
  ])(
    "fails explicitly when the saga result is valid JSON with a wrong-shaped $label",
    async ({ payload }) => {
      const sagaText = JSON.stringify(payload);
      const sagaContent = [{ type: "text" as const, text: sagaText }];
      const { tools } = makeTools({
        threads: [],
        runCreateThreads: () => Effect.succeed({ isError: false, content: sagaContent }),
      });

      const result = await runHandler(toolById(tools, "synara_create_kanban_task"), {
        title: "Fix bug",
        requestId: "req-wrong-shape",
      });
      expect(result.isError).toBe(true);
      expect((jsonText(result) as { __errorText?: string }).__errorText).toContain(
        "could not decode the creation saga result",
      );
    },
  );
});

describe("synara_move_kanban_card", () => {
  const move = async (
    tools: ReadonlyArray<ToolEntry>,
    threadId: string,
    target: string,
    extra: Record<string, unknown> = {},
    ctx: ToolContext = context,
  ) =>
    jsonText(
      await runHandler(
        toolById(tools, "synara_move_kanban_card"),
        { threadId, target, ...extra },
        ctx,
      ),
    );

  it("starts a turn with an explicit message on a draft card", async () => {
    const { tools, started } = makeTools({
      threads: [makeThreadShell("thread-draft")],
    });

    const result = await move(tools, "thread-draft", "inProgress", {
      message: "Start this work",
    });
    expect(started).toEqual([
      {
        threadId: "thread-draft",
        message: "Start this work",
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ]);
    expect(result.turnStarted).toBe(true);
    expect(result.card.column).toBe("inProgress");
  });

  it("interrupts a live turn for target done", async () => {
    const { tools, interrupted } = makeTools({
      threads: [makeRunningShell("thread-live")],
    });

    const result = await move(tools, "thread-live", "done");
    expect(interrupted).toEqual([{ threadId: "thread-live" }]);
    expect(result.interruptRequested).toBe(true);
    expect(result.eventSequence).toBe(7);
  });

  it("is a no-op for a card already inProgress", async () => {
    const { tools, started } = makeTools({
      threads: [makeRunningShell("thread-live")],
    });

    const result = await move(tools, "thread-live", "inProgress");
    expect(result.alreadyInProgress).toBe(true);
    expect(started).toHaveLength(0);
  });

  it("is a no-op for an already-done card", async () => {
    const { tools, interrupted } = makeTools({
      threads: [makeSessionShell("thread-done")],
    });

    const result = await move(tools, "thread-done", "done");
    expect(result.alreadyDone).toBe(true);
    expect(interrupted).toHaveLength(0);
  });

  it("refuses to drive an awaiting-you card into a new turn and reports why", async () => {
    const { tools, started } = makeTools({
      threads: [
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
      ],
    });

    const result = await move(tools, "thread-waiting", "inProgress");
    expect(result.isError ?? false).toBe(false);
    expect(result.alreadyInProgress).toBe(true);
    expect(result.awaitingYou).toBe(true);
    expect(started).toHaveLength(0);
  });

  it("rejects moving a card with no in-flight turn to done", async () => {
    const { tools, interrupted } = makeTools({
      threads: [makeThreadShell("thread-draft")],
    });

    const result = await move(tools, "thread-draft", "done");
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("no in-flight turn");
    expect(interrupted).toHaveLength(0);
  });

  it.each([
    {
      label: "settled-without-message",
      threadId: "thread-done",
      target: "inProgress",
      expected: '"message" is required to restart a settled thread',
    },
    // startTurn dispatch itself fails: the tool must convert it to a tool error.
    {
      label: "dispatch-fail",
      threadId: "thread-draft",
      target: "inProgress",
      message: "Start this work",
      failStartTurn: true as const,
      expected: "start exploded",
    },
  ])("rejects $label", async ({ threadId, target, message, failStartTurn, expected }) => {
    const { tools, started } = makeTools({
      threads:
        threadId === "thread-done"
          ? [makeSessionShell("thread-done")]
          : [makeThreadShell("thread-draft")],
      ...(failStartTurn ? { startTurn: () => Effect.fail(new Error("start exploded")) } : {}),
    });

    const result = await move(tools, threadId, target, message ? { message } : {});
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain(expected);
    if (!failStartTurn) expect(started).toHaveLength(0);
  });

  it("rejects moving an awaiting-you card to done", async () => {
    const { tools, interrupted } = makeTools({
      threads: [
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
      ],
    });

    const result = await move(tools, "thread-waiting", "done");
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("Awaiting-you cards cannot be force-moved");
    expect(interrupted).toHaveLength(0);
  });

  it("rejects a cross-thread drive without authority", async () => {
    const { tools, started } = makeTools({
      threads: [makeThreadShell("thread-draft")],
      assertCallerMayDriveThread: (() =>
        Effect.fail(
          new Error("assertCallerMayDriveThread failed"),
        ) as unknown) as () => Effect.Effect<void>,
    });
    const fencedContext: ToolContext = {
      ...otherContext,
      assertCallerTurnActive: () => Effect.void,
    };

    const result = await move(
      tools,
      "thread-draft",
      "inProgress",
      { message: "nope" },
      fencedContext,
    );
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("assertCallerMayDriveThread failed");
    expect(started).toHaveLength(0);
  });

  it("rejects moving a card in a different project from the caller", async () => {
    const { tools, started, interrupted } = makeTools({
      threads: [makeThreadShell("thread-foreign", "project-b")],
    });

    const result = await move(tools, "thread-foreign", "inProgress", {
      message: "Start work",
    });
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("different project");
    expect(started).toHaveLength(0);
    expect(interrupted).toHaveLength(0);
  });

  it.each([
    { target: "inProgress", extraArgs: { message: "hi" } },
    { target: "done", extraArgs: {} },
  ] as const)("rejects an archived thread for target $target", async ({ target, extraArgs }) => {
    const { tools, started, interrupted } = makeTools({
      threads: [
        makeThreadShell("thread-archived", "project-a", {
          archivedAt: NOW_ISO,
        }),
      ],
    });

    const result = await move(tools, "thread-archived", target, extraArgs);
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("archived");
    expect(started).toHaveLength(0);
    expect(interrupted).toHaveLength(0);
  });

  it("returns an error result when the interrupt dispatch fails", async () => {
    const { tools } = makeTools({
      threads: [makeRunningShell("thread-live")],
      interruptTurn: () => Effect.fail(new Error("provider exploded")),
    });

    const result = await move(tools, "thread-live", "done");
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("provider exploded");
  });
});
