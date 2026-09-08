import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { makeImage, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import type { SidebarThreadSummary } from "../types";
import {
  dispatchKanbanDraftCard,
  dispatchKanbanDraftCardAsGoal,
  dispatchKanbanDraftThread,
  dispatchKanbanDraftThreadAsGoal,
} from "./kanbanDispatch";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (..._args: unknown[]) => undefined),
  cleanup: vi.fn(),
  runWithDispatch: vi.fn(async (fn: (attachments: unknown) => Promise<unknown>) => {
    await fn([]);
  }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

vi.mock("../kanbanUiStore", () => ({
  useKanbanUiStore: {
    getState: () => ({
      markOptimisticDispatch: () => undefined,
      clearOptimisticDispatch: () => undefined,
    }),
  },
}));

vi.mock("../store", () => ({
  useStore: {
    getState: () => ({ projects: [], threads: [], sessions: [] }),
  },
}));

vi.mock("./threadCreatePromotion", () => ({
  promoteThreadCreate: vi.fn(async () => "created"),
}));

vi.mock("./threadBootstrap", () => ({
  resolveTerminalThreadCreationState: () => ({
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    lastKnownPr: null,
  }),
}));

vi.mock("./composerSend", async () => {
  const actual = await vi.importActual<typeof import("./composerSend")>("./composerSend");
  return {
    ...actual,
    stageUploadComposerAttachments: vi.fn(async () => ({
      runWithDispatch: nativeApiMocks.runWithDispatch,
      cleanup: nativeApiMocks.cleanup,
    })),
  };
});

function buildCard(input: {
  threadId: ThreadId;
  projectId: ProjectId;
  thread: SidebarThreadSummary | null;
  draftPrompt: string;
  draftHasAttachments: boolean;
}): import("../components/kanban/kanban.logic").KanbanCard {
  return {
    cardId: `draft:${input.threadId}`,
    threadId: input.threadId,
    projectId: input.projectId,
    column: "draft",
    title: "Kanban draft",
    provider: "codex",
    isTerminal: false,
    branch: null,
    envMode: "local",
    worktreePath: null,
    thread: input.thread,
    draftPrompt: input.draftPrompt,
    draftHasAttachments: input.draftHasAttachments,
    sortTimestamp: 0,
    timestamp: null,
    activeWorkStartedAt: null,
    isOptimisticDispatch: false,
  };
}

function commandType(command: unknown): string {
  return (command as { type?: string }).type ?? "";
}

function commandGoal(command: unknown): string | undefined {
  return (command as { goal?: string }).goal;
}

describe("kanbanDispatch send-as-goal", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockReset();
    nativeApiMocks.runWithDispatch.mockClear();
  });

  it("sets a goal before starting the turn for a thread-backed draft", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-1");
    const projectId = ProjectId.makeUnsafe("project-goal");
    useComposerDraftStore.getState().setPrompt(threadId, "Ship the v2 kanban goal feature");

    const result = await dispatchKanbanDraftThreadAsGoal({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledTimes(2);
    expect(nativeApiMocks.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.meta.update",
      threadId,
      goal: "Ship the v2 kanban goal feature",
      goalStartBehavior: "defer",
    });
    expect(nativeApiMocks.dispatchCommand.mock.calls[1]?.[0]).toMatchObject({
      type: "thread.turn.start",
      threadId,
    });
  });

  it("clamps the goal text to 4096 characters", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-2");
    const projectId = ProjectId.makeUnsafe("project-goal");
    const longPrompt = "a".repeat(5000);
    useComposerDraftStore.getState().setPrompt(threadId, longPrompt);

    await dispatchKanbanDraftThreadAsGoal({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    const metaUpdate = nativeApiMocks.dispatchCommand.mock.calls.find(
      ([command]) => commandType(command) === "thread.meta.update",
    )?.[0];
    expect(commandGoal(metaUpdate)).toHaveLength(4096);
    expect(commandGoal(metaUpdate)).toBe(longPrompt.slice(0, 4096));
  });

  it("skips the goal command for attachment-only drafts but still starts the turn", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-3");
    const projectId = ProjectId.makeUnsafe("project-goal");
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "");
    store.addImage(
      threadId,
      makeImage({ id: "img-1", name: "screenshot.png", previewUrl: "blob:img-1" }),
    );

    const result = await dispatchKanbanDraftThreadAsGoal({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    const commands = nativeApiMocks.dispatchCommand.mock.calls.map(([command]) =>
      commandType(command),
    );
    expect(commands).not.toContain("thread.meta.update");
    expect(commands).toContain("thread.turn.start");
  });

  it("starts the turn and surfaces a warning when the goal update fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-4");
    const projectId = ProjectId.makeUnsafe("project-goal");
    useComposerDraftStore.getState().setPrompt(threadId, "Fix the flaky dispatch test");
    nativeApiMocks.dispatchCommand.mockImplementation(async (...args: unknown[]) => {
      const [command] = args;
      if (commandType(command) === "thread.meta.update") {
        throw new Error("goal store rejected");
      }
      return undefined;
    });

    const result = await dispatchKanbanDraftThreadAsGoal({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") throw new Error("expected dispatched");
    expect(result.warning).toContain("goal store rejected");
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it("promotes a local-only draft before setting the goal", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-5");
    const projectId = ProjectId.makeUnsafe("project-goal");
    useComposerDraftStore.getState().registerDraftThread(threadId, { projectId });
    useComposerDraftStore.getState().setPrompt(threadId, "Local-only goal draft");

    const result = await dispatchKanbanDraftCardAsGoal({
      card: buildCard({
        threadId,
        projectId,
        thread: null,
        draftPrompt: "Local-only goal draft",
        draftHasAttachments: false,
      }),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    const types = nativeApiMocks.dispatchCommand.mock.calls.map(([command]) =>
      commandType(command),
    );
    expect(types).toContain("thread.turn.start");
    const metaUpdate = nativeApiMocks.dispatchCommand.mock.calls.find(
      ([command]) => commandType(command) === "thread.meta.update",
    )?.[0];
    expect(commandGoal(metaUpdate)).toBe("Local-only goal draft");
  });

  it("rejects non-dispatchable cards through the public card wrapper", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-6");
    const projectId = ProjectId.makeUnsafe("project-goal");

    const result = await dispatchKanbanDraftCardAsGoal({
      card: buildCard({
        threadId,
        projectId,
        thread: null,
        draftPrompt: "",
        draftHasAttachments: false,
      }),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "open-thread", reason: "empty" });
  });

  it("keeps the original dispatch path unchanged", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-7");
    const projectId = ProjectId.makeUnsafe("project-goal");
    useComposerDraftStore.getState().setPrompt(threadId, "Plain dispatch");

    const result = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    const metaUpdates = nativeApiMocks.dispatchCommand.mock.calls.filter(
      ([command]) => commandType(command) === "thread.meta.update",
    );
    expect(metaUpdates.length).toBe(0);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it("also dispatches plain draft cards without a goal", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-8");
    const projectId = ProjectId.makeUnsafe("project-goal");
    useComposerDraftStore.getState().setPrompt(threadId, "Plain dispatch");

    const result = await dispatchKanbanDraftCard({
      card: buildCard({
        threadId,
        projectId,
        thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
        draftPrompt: "Plain dispatch",
        draftHasAttachments: false,
      }),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    const metaUpdates = nativeApiMocks.dispatchCommand.mock.calls.filter(
      ([command]) => commandType(command) === "thread.meta.update",
    );
    expect(metaUpdates.length).toBe(0);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it("coalesces a drag racing a send-as-goal onto one turn start", async () => {
    const threadId = ThreadId.makeUnsafe("thread-goal-9");
    const projectId = ProjectId.makeUnsafe("project-goal");
    useComposerDraftStore.getState().setPrompt(threadId, "Racing drag and goal");
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;

    const [plain, goal] = await Promise.all([
      dispatchKanbanDraftThread({
        threadId,
        projectId,
        thread,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      }),
      dispatchKanbanDraftThreadAsGoal({
        threadId,
        projectId,
        thread,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      }),
    ]);

    // The in-flight guard is keyed by threadId alone: both callers join the
    // first dispatch instead of queueing two thread.turn.start commands.
    expect(plain).toEqual({ kind: "dispatched" });
    expect(goal).toEqual({ kind: "dispatched" });
    const turnStarts = nativeApiMocks.dispatchCommand.mock.calls.filter(
      ([command]) => commandType(command) === "thread.turn.start",
    );
    expect(turnStarts).toHaveLength(1);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledTimes(1);
  });
});
