import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayKanbanTools } from "./kanbanTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const NOW_ISO = "2026-08-16T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const WORKSPACE_PATHS = { homeDir: "/home/tester", chatWorkspaceRoot: "/home/tester/chats" };

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
  principal: { ...context.principal, threadId: "thread-other", turnId: "turn-other" },
  callerThreadId: "thread-other",
  callerTurnId: "turn-other",
};

function makeProjectShell(
  projectId: string,
  title: string,
  workspaceRoot = `/repos/${title}`,
  kind: "project" | "chat" = "project",
) {
  return { id: ProjectId.makeUnsafe(projectId), title, kind, workspaceRoot } as const;
}

function makeThreadShell(
  threadId: string,
  projectId: string,
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

function makeSessionShell(
  threadId: string,
  projectId: string,
  overrides: {
    latestTurn?: OrchestrationThreadShell["latestTurn"];
    session?: OrchestrationThreadShell["session"];
    hasPendingApprovals?: boolean;
    hasPendingUserInput?: boolean;
    updatedAt?: string;
  } = {},
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

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<{
    id: ReturnType<typeof ProjectId.makeUnsafe>;
    title: string;
    kind: string;
    workspaceRoot: string;
  }>,
): ProjectionSnapshotQueryShape {
  return {
    getShellSnapshot: () =>
      Effect.succeed({
        projects: [...projects],
        threads: [...threads],
      }),
  } as unknown as ProjectionSnapshotQueryShape;
}

function makeTools(input: {
  threads: ReadonlyArray<OrchestrationThreadShell>;
  projects: ReturnType<typeof makeProjectShell>[];
  runCreateThreads?: (args: unknown) => unknown;
  startTurn?: (args: unknown) => unknown;
  interruptTurn?: (args: unknown) => unknown;
  assertCallerMayDriveThread?: () => Effect.Effect<void>;
}) {
  const started: Array<{ threadId: string; message: string; dispatchMode: string }> = [];
  const interrupted: Array<{ threadId: string }> = [];
  const created: Array<unknown> = [];
  const tools = makeAgentGatewayKanbanTools({
    snapshotQuery: makeSnapshot(input.threads, input.projects),
    workspacePaths: WORKSPACE_PATHS,
    now: () => NOW_MS,
    helpers: {
      requireThreadShell: (threadId) => {
        const found = input.threads.find((thread) => String(thread.id) === threadId);
        if (found) return Effect.succeed(found);
        if (threadId === "thread-caller" || threadId === "thread-other") {
          return Effect.succeed(makeThreadShell(threadId, "project-a"));
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

const jsonText = (result: McpToolCallResult): Record<string, unknown> => {
  const content = result.content[0];
  if (result.isError) {
    return { __errorText: content?.type === "text" ? content.text : "" };
  }
  return JSON.parse(content?.type === "text" ? content.text : "{}") as Record<string, unknown>;
};

describe("synara_read_kanban_board", () => {
  it("derives v2 columns + attention flags and skips non-project containers", async () => {
    const draft = makeThreadShell("thread-draft", "project-a");
    const running = makeSessionShell("thread-running", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-running", "project-a").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-running"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-running"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
    });
    const waiting = makeSessionShell("thread-waiting", "project-a", {
      hasPendingApprovals: true,
    });
    const done = makeSessionShell("thread-done", "project-a");
    const chatThread = makeThreadShell("thread-chat", "chat-container");
    const { tools } = makeTools({
      threads: [draft, running, waiting, done, chatThread],
      projects: [
        makeProjectShell("project-a", "Project A"),
        makeProjectShell("chat-container", "Chats", WORKSPACE_PATHS.chatWorkspaceRoot, "chat"),
      ],
    });
    const result = await runHandler(toolById(tools, "synara_read_kanban_board"), {});
    const payload = jsonText(result) as {
      projects: Array<{
        projectId: string;
        columns: Array<{
          key: string;
          cards: Array<{ threadId: string; column: string; attention: string[] }>;
        }>;
      }>;
    };

    expect(payload.projects).toHaveLength(1);
    const project = payload.projects[0];
    expect(project).toBeTruthy();
    if (!project) return;
    expect(project.projectId).toBe("project-a");
    const byColumn = Object.fromEntries(
      project.columns.map((column) => [column.key, column.cards]),
    ) as Record<string, Array<{ threadId: string; column: string; attention: string[] }>>;
    const draftCards = byColumn.draft ?? [];
    const waitingCards = byColumn.awaitingYou ?? [];
    const doneCards = byColumn.done ?? [];
    const inProgressCards = byColumn.inProgress ?? [];
    expect(draftCards.map((card) => card.threadId)).toEqual(["thread-draft"]);
    expect(inProgressCards.map((card) => card.threadId)).toEqual(["thread-running"]);
    expect(waitingCards.map((card) => card.threadId)).toEqual(["thread-waiting"]);
    expect(doneCards.map((card) => card.threadId)).toEqual(["thread-done"]);
    const waitingCard = waitingCards[0];
    expect(waitingCard).toBeTruthy();
    expect(waitingCard!.attention).toContain("awaiting-approval");
  });

  it("returns an empty board for an unknown projectId and hides archived threads", async () => {
    const archived = makeThreadShell("thread-archived", "project-a", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-thread-archived"),
        state: "running",
        requestedAt: NOW_ISO,
        startedAt: NOW_ISO,
        completedAt: null,
        assistantMessageId: null,
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
    const live = makeSessionShell("thread-live", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-live", "project-a").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-live"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-live"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
    });
    const { tools } = makeTools({
      threads: [archived, live],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const empty = await runHandler(toolById(tools, "synara_read_kanban_board"), {
      projectId: "project-nope",
    });
    const emptyPayload = jsonText(empty) as {
      projects: unknown[];
      asOf?: string;
      callerThreadId?: string;
    };
    expect(emptyPayload.projects).toEqual([]);
    expect(emptyPayload.asOf).toBe(NOW_ISO);
    expect(emptyPayload.callerThreadId).toBe("thread-caller");

    const full = await runHandler(toolById(tools, "synara_read_kanban_board"), {
      projectId: "project-a",
    });
    const fullPayload = jsonText(full) as {
      projects: Array<{
        columns: Array<{ cards: Array<{ threadId: string }> }>;
      }>;
    };
    const project = fullPayload.projects[0];
    expect(project).toBeTruthy();
    const cardIds =
      project?.columns.flatMap((column) => column.cards.map((card) => card.threadId)) ?? [];
    expect(cardIds).toContain("thread-live");
    expect(cardIds).not.toContain("thread-archived");
  });

  it("filters to one project and exposes card metadata", async () => {
    const running = makeSessionShell("thread-a", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-a", "project-a").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-a"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-a"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
    });
    const other = makeThreadShell("thread-b", "project-b");
    const { tools } = makeTools({
      threads: [running, other],
      projects: [
        makeProjectShell("project-a", "Project A"),
        makeProjectShell("project-b", "Project B"),
      ],
    });

    const result = await runHandler(toolById(tools, "synara_read_kanban_board"), {
      projectId: "project-a",
    });
    const payload = jsonText(result) as {
      projects: Array<{
        projectId: string;
        columns: Array<{
          cards: Array<{
            threadId: string;
            branch: string | null;
            model: string;
            summary: unknown;
          }>;
        }>;
      }>;
    };
    expect(payload.projects).toHaveLength(1);
    const project = payload.projects[0];
    expect(project).toBeTruthy();
    if (!project) return;
    const inProgress = project.columns.find((column) => (column.cards.length ?? 0) > 0);
    expect(inProgress).toBeTruthy();
    const card = inProgress?.cards[0] ?? null;
    expect(card).toBeTruthy();
    expect(card?.threadId).toBe("thread-a");
    expect(card?.model).toBe("gpt-5.6-sol");
    expect(card?.summary).toBeTruthy();
  });

  it("caps the board at MAX_CARDS_PER_BOARD and reports truncated", async () => {
    // 501 threads (one over the cap) across two projects.
    const threads: OrchestrationThreadShell[] = [];
    for (let index = 0; index < 501; index += 1) {
      threads.push(makeThreadShell(`thread-${index}`, "project-a"));
    }
    const { tools } = makeTools({
      threads,
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_read_kanban_board"), {});
    const payload = jsonText(result) as {
      truncated: boolean;
      truncatedReason?: string;
      projects: Array<{ columns: Array<{ cards: unknown[] }> }>;
    };
    expect(payload.truncated).toBe(true);
    expect(payload.truncatedReason).toContain("synara_read_kanban_card");
    const totalCards = payload.projects[0]!.columns.reduce(
      (sum, column) => sum + column.cards.length,
      0,
    );
    expect(totalCards).toBe(500);
  });

  it("does not report truncated under the cap", async () => {
    const { tools } = makeTools({
      threads: [makeThreadShell("thread-draft", "project-a")],
      projects: [makeProjectShell("project-a", "Project A")],
    });
    const result = await runHandler(toolById(tools, "synara_read_kanban_board"), {});
    const payload = jsonText(result) as { truncated: boolean };
    expect(payload.truncated).toBe(false);
  });
});

describe("synara_read_kanban_card", () => {
  it("returns the single card with column and attention flags", async () => {
    const waiting = makeSessionShell("thread-waiting", "project-a", {
      hasPendingApprovals: true,
    });
    const { tools } = makeTools({
      threads: [waiting],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_read_kanban_card"), {
      threadId: "thread-waiting",
    });
    const payload = jsonText(result) as {
      card: { threadId: string; column: string; attention: string[]; model: string };
      asOf: string;
      callerThreadId: string;
    };
    expect(payload.card.threadId).toBe("thread-waiting");
    expect(payload.card.column).toBe("awaitingYou");
    expect(payload.card.attention).toContain("awaiting-approval");
    expect(payload.card.model).toBe("gpt-5.6-sol");
    expect(payload.asOf).toBe(NOW_ISO);
    expect(payload.callerThreadId).toBe("thread-caller");
  });

  it("rejects a missing thread with an error result", async () => {
    const { tools } = makeTools({
      threads: [],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_read_kanban_card"), {
      threadId: "thread-missing",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("thread-missing");
  });

  it("rejects an archived thread", async () => {
    const archived = makeThreadShell("thread-archived", "project-a", {
      archivedAt: NOW_ISO,
    });
    const { tools } = makeTools({
      threads: [archived],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_read_kanban_card"), {
      threadId: "thread-archived",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("archived");
  });
});

describe("synara_create_kanban_task", () => {
  it("forwards the spec to runCreateThreads and returns threadId + card", async () => {
    const createdThread = makeSessionShell("thread-created", "project-a");
    const { tools, created } = makeTools({
      threads: [createdThread],
      projects: [makeProjectShell("project-a", "Project A")],
      runCreateThreads: () =>
        Effect.succeed(
          mcpOk({
            operationId: "op-1",
            requestedCount: 1,
            createdCount: 1,
            threadIds: ["thread-created"],
            threads: [{ index: 0, threadId: "thread-created", title: "created" }],
          }),
        ),
    });

    const result = await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      requestId: "req-1",
    });
    const payload = jsonText(result) as {
      threadId: string;
      title: string;
      card: { column: string };
    };
    expect(created).toHaveLength(1);
    const spec = (
      created[0] as {
        threads: Array<{ title: string; prompt: string; target: { provider: string } }>;
      }
    ).threads[0];
    expect(spec).toBeTruthy();
    expect(spec!.title).toBe("Fix bug");
    expect(spec!.prompt).toBe("Fix bug");
    expect(spec!.target.provider).toBe("claudeAgent");
    expect(payload.threadId).toBe("thread-created");
    expect(payload.card.column).toBe("done");
  });

  it("uses description as the first-turn prompt and forwards projectId", async () => {
    const createdThread = makeSessionShell("thread-created", "project-a");
    const { tools, created } = makeTools({
      threads: [createdThread],
      projects: [makeProjectShell("project-a", "Project A")],
      runCreateThreads: () =>
        Effect.succeed(
          mcpOk({
            operationId: "op-2",
            requestedCount: 1,
            createdCount: 1,
            threadIds: ["thread-created"],
            threads: [{ index: 0, threadId: "thread-created", title: "created" }],
          }),
        ),
    });

    const result = await runHandler(toolById(tools, "synara_create_kanban_task"), {
      title: "Fix bug",
      description: "Investigate the flaky test first.",
      projectId: "project-a",
      requestId: "req-2",
    });
    expect(result.isError).toBeFalsy();
    expect(created).toHaveLength(1);
    const spec = (
      created[0] as {
        threads: Array<{ title: string; prompt: string; projectId: string }>;
      }
    ).threads[0];
    expect(spec).toBeTruthy();
    expect(spec!.prompt).toBe("Investigate the flaky test first.");
    expect(spec!.projectId).toBe("project-a");
  });

  it("returns the failed creation result untouched as isError", async () => {
    const { tools } = makeTools({
      threads: [],
      projects: [makeProjectShell("project-a", "Project A")],
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
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("creation failed");
  });

  it("rejects concurrent writes past the per-caller in-flight cap", async () => {
    const createdThread = makeSessionShell("thread-created", "project-a");
    // Block runCreateThreads until every slot-holder is released, so the
    // in-flight count stays at the cap while the over-cap call arrives.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tools } = makeTools({
      threads: [createdThread],
      projects: [makeProjectShell("project-a", "Project A")],
      runCreateThreads: () => Effect.promise(() => held.then(() => mcpOk({}))),
    });
    const tool = toolById(tools, "synara_create_kanban_task");
    const args = { title: "Fix bug" };

    // Fire 4 held calls (filling the cap) plus a 5th that must be rejected.
    const heldResults = [
      runHandler(tool, { ...args, requestId: "req-a" }),
      runHandler(tool, { ...args, requestId: "req-b" }),
      runHandler(tool, { ...args, requestId: "req-c" }),
      runHandler(tool, { ...args, requestId: "req-d" }),
    ];
    // Yield so the held calls enter runCreateThreads and hold their slots.
    await Promise.resolve();
    const overCap = await runHandler(tool, { ...args, requestId: "req-e" });
    expect(overCap.isError).toBe(true);
    const overCapPayload = jsonText(overCap) as { __errorText?: string };
    expect(overCapPayload.__errorText).toContain("Too many concurrent kanban write calls");

    // Release the held calls so they settle and the process can exit.
    release();
    await Promise.allSettled(heldResults);
  });
});

describe("synara_move_kanban_card", () => {
  it("starts a turn with an explicit message on a draft card", async () => {
    const draft = makeThreadShell("thread-draft", "project-a");
    const { tools, started } = makeTools({
      threads: [draft],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-draft",
      target: "inProgress",
      message: "Start this work",
    });
    const payload = jsonText(result) as {
      turnStarted: boolean;
      card: { column: string };
    };
    expect(started).toEqual([
      {
        threadId: "thread-draft",
        message: "Start this work",
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ]);
    expect(payload.turnStarted).toBe(true);
    expect(payload.card.column).toBe("inProgress");
  });

  it("interrupts a live turn for target done", async () => {
    const running = makeSessionShell("thread-live", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-live", "project-a").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-live"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-live"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
    });
    const { tools, interrupted } = makeTools({
      threads: [running],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-live",
      target: "done",
    });
    const payload = jsonText(result) as {
      interruptRequested: boolean;
      eventSequence: number;
    };
    expect(interrupted).toEqual([{ threadId: "thread-live" }]);
    expect(payload.interruptRequested).toBe(true);
    expect(payload.eventSequence).toBe(7);
  });

  it("is a no-op for a card already inProgress", async () => {
    const running = makeSessionShell("thread-live", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-live", "project-a").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-live"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-live"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
    });
    const { tools, started } = makeTools({
      threads: [running],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-live",
      target: "inProgress",
    });
    const payload = jsonText(result) as {
      alreadyInProgress: boolean;
    };
    expect(payload.alreadyInProgress).toBe(true);
    expect(started).toHaveLength(0);
  });

  it("is a no-op for an already-done card", async () => {
    const done = makeSessionShell("thread-done", "project-a");
    const { tools, interrupted } = makeTools({
      threads: [done],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-done",
      target: "done",
    });
    const payload = jsonText(result) as {
      alreadyDone: boolean;
    };
    expect(payload.alreadyDone).toBe(true);
    expect(interrupted).toHaveLength(0);
  });

  it("rejects a missing thread with an error result", async () => {
    const { tools } = makeTools({
      threads: [],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-missing",
      target: "done",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("thread-missing");
  });

  it("rejects an unknown target", async () => {
    const draft = makeThreadShell("thread-draft", "project-a");
    const { tools, started } = makeTools({
      threads: [draft],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-draft",
      target: "awaitingYou",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain('must be "inProgress" or "done"');
    expect(started).toHaveLength(0);
  });

  it("rejects restarting a settled thread without a message", async () => {
    const done = makeSessionShell("thread-done", "project-a");
    const { tools, started } = makeTools({
      threads: [done],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-done",
      target: "inProgress",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain('"message" is required to restart a settled thread');
    expect(started).toHaveLength(0);
  });

  it("returns an error result when the start dispatch fails", async () => {
    const draft = makeThreadShell("thread-draft", "project-a");
    const { tools } = makeTools({
      threads: [draft],
      projects: [makeProjectShell("project-a", "Project A")],
      startTurn: () => Effect.fail(new Error("start exploded")),
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-draft",
      target: "inProgress",
      message: "Start this work",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("start exploded");
  });

  it("returns alreadyDone for a settled thread with target done and no live turn", async () => {
    const settled = makeSessionShell("thread-waiting", "project-a", {
      hasPendingApprovals: true,
    });
    const { tools, interrupted } = makeTools({
      threads: [settled],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-waiting",
      target: "done",
    });
    const payload = jsonText(result) as {
      alreadyDone: boolean;
      card: { column: string };
    };
    expect(payload.alreadyDone).toBe(true);
    expect(payload.card.column).toBe("awaitingYou");
    expect(interrupted).toHaveLength(0);
  });

  it("rejects a cross-thread drive without authority", async () => {
    const draft = makeThreadShell("thread-draft", "project-a");
    const { tools, started } = makeTools({
      threads: [draft],
      projects: [makeProjectShell("project-a", "Project A")],
      assertCallerMayDriveThread: (() =>
        Effect.fail(
          new Error("assertCallerMayDriveThread failed"),
        ) as unknown) as () => Effect.Effect<void>,
    });
    const fenceTool = toolById(tools, "synara_move_kanban_card");
    const fencedContext: ToolContext = {
      ...otherContext,
      assertCallerTurnActive: () => Effect.void,
    };

    const result = await runHandler(
      fenceTool,
      { threadId: "thread-draft", target: "inProgress", message: "nope" },
      fencedContext,
    );
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("assertCallerMayDriveThread failed");
    expect(started).toHaveLength(0);
  });

  it("rejects an archived thread for target inProgress", async () => {
    const archived = makeThreadShell("thread-archived", "project-a", {
      archivedAt: NOW_ISO,
    });
    const { tools, started, interrupted } = makeTools({
      threads: [archived],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-archived",
      target: "inProgress",
      message: "hi",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("archived");
    expect(started).toHaveLength(0);
    expect(interrupted).toHaveLength(0);
  });

  it("rejects an archived thread for target done", async () => {
    const archived = makeThreadShell("thread-archived", "project-a", {
      archivedAt: NOW_ISO,
    });
    const { tools, started, interrupted } = makeTools({
      threads: [archived],
      projects: [makeProjectShell("project-a", "Project A")],
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-archived",
      target: "done",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("archived");
    expect(started).toHaveLength(0);
    expect(interrupted).toHaveLength(0);
  });

  it("returns an error result when the interrupt dispatch fails", async () => {
    const running = makeSessionShell("thread-live", "project-a", {
      latestTurn: {
        ...makeSessionShell("thread-live", "project-a").latestTurn!,
        state: "running",
        completedAt: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-live"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.makeUnsafe("turn-thread-live"),
        lastError: null,
        updatedAt: NOW_ISO,
      },
    });
    const { tools } = makeTools({
      threads: [running],
      projects: [makeProjectShell("project-a", "Project A")],
      interruptTurn: () => Effect.fail(new Error("provider exploded")),
    });

    const result = await runHandler(toolById(tools, "synara_move_kanban_card"), {
      threadId: "thread-live",
      target: "done",
    });
    expect(result.isError).toBe(true);
    const payload = jsonText(result) as { __errorText?: string };
    expect(payload.__errorText).toContain("provider exploded");
  });
});
