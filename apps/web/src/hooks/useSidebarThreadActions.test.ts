// FILE: useSidebarThreadActions.test.ts
// Purpose: Characterizes Sidebar pin races, archive serialization/undo, and batch deletion.
// Layer: Web hook tests

import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // Vitest requires helpers referenced by a hoisted factory to stay inside that factory.
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = callback;
      }
      return slot.value as T;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = factory();
      }
      return slot.value as T;
    },
    useRef<T>(value: T) {
      const slot = nextSlot();
      if (!("value" in slot)) slot.value = { current: value };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const harness = vi.hoisted(() => ({
  pinnedThreadIds: [] as string[],
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
  prunePinnedThreads: vi.fn(),
  dispatchCommand: vi.fn(),
  confirm: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  alreadyUnarchived: false,
  activeThreadDelete: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  removeFromSelection: vi.fn(),
  reconcileDeletedThreads: vi.fn(),
  clearDraftThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  removeThreadFromSplitViews: vi.fn(),
  clearTemporaryThread: vi.fn(),
  clearTerminalState: vi.fn(),
  handleNewChat: vi.fn(),
  removeDeletedThreadFromClientState: vi.fn(),
  resolveSplitViewPaneIdForThread: vi.fn(),
  resolveSplitViewFocusedThreadId: vi.fn(),
  splitViewsById: {} as Record<string, unknown>,
  shellSnapshotSequence: 0,
}));

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useMemo: reactHarness.useMemo,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("../lib/gitReactQuery", () => ({ gitRemoveWorktreeMutationOptions: () => ({}) }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearDraftThread: harness.clearDraftThread,
      clearProjectDraftThreadById: harness.clearProjectDraftThreadById,
    }),
}));
vi.mock("../pinnedThreadsStore", () => ({
  usePinnedThreadsStore: (selector: (state: unknown) => unknown) =>
    selector({
      pinnedThreadIds: harness.pinnedThreadIds,
      pinThread: harness.pinThread,
      unpinThread: harness.unpinThread,
      prunePinnedThreads: harness.prunePinnedThreads,
    }),
}));
vi.mock("../splitViewStore", () => {
  const useSplitViewStore = (selector: (state: unknown) => unknown) =>
    selector({ removeThreadFromSplitViews: harness.removeThreadFromSplitViews });
  useSplitViewStore.getState = () => ({ splitViewsById: harness.splitViewsById });
  return {
    useSplitViewStore,
    resolveSplitViewFocusedThreadId: harness.resolveSplitViewFocusedThreadId,
    resolveSplitViewPaneIdForThread: harness.resolveSplitViewPaneIdForThread,
  };
});
vi.mock("../temporaryThreadStore", () => ({
  useTemporaryThreadStore: (selector: (state: unknown) => unknown) =>
    selector({ clearTemporaryThread: harness.clearTemporaryThread }),
}));
vi.mock("../threadSelectionStore", () => ({
  useThreadSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({ removeFromSelection: harness.removeFromSelection }),
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: harness.dispatchCommand },
    dialogs: { confirm: harness.confirm },
  }),
}));
vi.mock("../lib/threadArchive", () => ({
  archiveThreadFromClient: harness.archiveThread,
  unarchiveThreadFromClient: harness.unarchiveThread,
  isThreadAlreadyUnarchivedError: () => harness.alreadyUnarchived,
}));
vi.mock("../lib/activeThreadDelete", () => ({
  deleteActiveThreadFromClient: harness.activeThreadDelete,
}));
vi.mock("../lib/deletedThreadClientReconciliation", () => ({
  reconcileDeletedThreadsFromClient: harness.reconcileDeletedThreads,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("../store", () => {
  const useStore = (selector: (state: unknown) => unknown) =>
    selector({ shellSnapshotSequence: harness.shellSnapshotSequence });
  useStore.getState = () => ({
    shellSnapshotSequence: harness.shellSnapshotSequence,
    removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
  });
  useStore.subscribe = () => () => {};
  return { useStore };
});
vi.mock("../threadDerivation", () => ({
  getThreadFromState: (_state: unknown, threadId: ThreadId) => ({ id: threadId }),
}));

import type { Project, SidebarThreadSummary } from "../types";
import { useSidebarThreadActions } from "./useSidebarThreadActions";

const PROJECT_ID = ProjectId.makeUnsafe("project-actions");
const THREAD_ID = ThreadId.makeUnsafe("thread-actions");
const FALLBACK_ID = ThreadId.makeUnsafe("thread-fallback");
const PROJECT = {
  id: PROJECT_ID,
  kind: "project",
  name: "Actions",
  remoteName: "Actions",
  folderName: "actions",
  localName: null,
  cwd: "/repo",
  defaultModelSelection: null,
  expanded: true,
  scripts: [],
} satisfies Project;

function makeThread(id: ThreadId, overrides: Partial<SidebarThreadSummary> = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    title: String(id),
    modelSelection: { provider: "codex", model: "gpt-5.6" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: id === THREAD_ID ? "2026-07-20T00:00:00.000Z" : "2026-07-19T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  } as SidebarThreadSummary;
}

let sidebarThreads: SidebarThreadSummary[];

function render(
  overrides: {
    activeSplitView?: Parameters<typeof useSidebarThreadActions>[0]["activeSplitView"];
    routeSplitViewId?: string | null;
    routeThreadId?: ThreadId | null;
    threadsHydrated?: boolean;
  } = {},
) {
  reactHarness.beginRender();
  return useSidebarThreadActions({
    activeSplitView: overrides.activeSplitView ?? null,
    appSettings: {
      confirmThreadArchive: false,
      confirmThreadDelete: false,
      sidebarThreadSortOrder: "updated_at",
    },
    clearTerminalState: harness.clearTerminalState,
    handleNewChat: harness.handleNewChat,
    projectById: new Map([[PROJECT_ID, PROJECT]]),
    routeSplitViewId: overrides.routeSplitViewId ?? null,
    routeThreadId: overrides.routeThreadId ?? null,
    sidebarThreads,
    sidebarTreeThreads: sidebarThreads,
    sidebarThreadSummaryById: Object.fromEntries(
      sidebarThreads.map((thread) => [thread.id, thread]),
    ),
    threadsHydrated: overrides.threadsHydrated ?? false,
  });
}

beforeEach(() => {
  reactHarness.reset();
  sidebarThreads = [makeThread(THREAD_ID), makeThread(FALLBACK_ID)];
  harness.pinnedThreadIds = [];
  harness.shellSnapshotSequence = 0;
  harness.alreadyUnarchived = false;
  harness.splitViewsById = {};
  for (const mock of [
    harness.pinThread,
    harness.unpinThread,
    harness.prunePinnedThreads,
    harness.dispatchCommand,
    harness.confirm,
    harness.archiveThread,
    harness.unarchiveThread,
    harness.activeThreadDelete,
    harness.navigate,
    harness.toast,
    harness.removeFromSelection,
    harness.reconcileDeletedThreads,
    harness.clearDraftThread,
    harness.clearProjectDraftThreadById,
    harness.removeThreadFromSplitViews,
    harness.clearTemporaryThread,
    harness.clearTerminalState,
    harness.handleNewChat,
    harness.resolveSplitViewPaneIdForThread,
    harness.resolveSplitViewFocusedThreadId,
  ]) {
    mock.mockReset();
  }
  harness.pinThread.mockImplementation((threadId: ThreadId) => {
    if (!harness.pinnedThreadIds.includes(threadId)) harness.pinnedThreadIds.unshift(threadId);
  });
  harness.unpinThread.mockImplementation((threadId: ThreadId) => {
    harness.pinnedThreadIds = harness.pinnedThreadIds.filter((id) => id !== threadId);
  });
  harness.dispatchCommand.mockResolvedValue({ sequence: 1 });
  harness.archiveThread.mockResolvedValue(undefined);
  harness.unarchiveThread.mockResolvedValue(undefined);
  harness.confirm.mockResolvedValue(true);
  harness.handleNewChat.mockResolvedValue({ ok: true });
  harness.activeThreadDelete.mockImplementation(async (input: unknown) => {
    const action = input as {
      prepareForDelete?: () => unknown;
      onDeleted: (input: {
        thread: { id: ThreadId; projectId: ProjectId };
        prepared?: unknown;
      }) => void;
    };
    const prepared = action.prepareForDelete?.();
    action.onDeleted({ thread: { id: THREAD_ID, projectId: PROJECT_ID }, prepared });
  });
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
});

describe("useSidebarThreadActions", () => {
  it("pins optimistically and dispatches thread metadata", async () => {
    let controller = render();

    controller.toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalled());
    controller = render();

    expect(harness.pinThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.meta.update",
        threadId: THREAD_ID,
        isPinned: true,
      }),
    );
    expect(controller.pinnedThreadIdSet.has(THREAD_ID)).toBe(true);
  });

  it("rolls the latest failed pin back to confirmed server state", async () => {
    harness.dispatchCommand.mockRejectedValue(new Error("pin rejected"));

    render().toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalled());

    expect(harness.pinThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.unpinThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to pin thread" }),
    );
  });

  it("does not let an older failed pin roll back a newer click", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    harness.dispatchCommand
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveSecond = resolve)));
    let controller = render();

    controller.toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalledTimes(1));
    controller = render();
    controller.toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalledTimes(2));
    resolveSecond();
    rejectFirst(new Error("stale failure"));
    await vi.waitFor(() => expect(harness.unpinThread).toHaveBeenCalledTimes(1));

    expect(harness.pinThread).toHaveBeenCalledTimes(1);
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("waits for hydration and deduplicates an in-flight legacy pin migration", async () => {
    harness.pinnedThreadIds = [THREAD_ID];
    let resolveMigration!: () => void;
    harness.dispatchCommand.mockImplementation(
      () => new Promise<void>((resolve) => (resolveMigration = resolve)),
    );

    render({ threadsHydrated: false });
    expect(harness.dispatchCommand).not.toHaveBeenCalled();
    render({ threadsHydrated: true });
    sidebarThreads = [...sidebarThreads];
    render({ threadsHydrated: true });
    expect(harness.dispatchCommand).toHaveBeenCalledTimes(1);
    resolveMigration();
  });

  it("keeps archive available while server-side runtime cleanup is pending", async () => {
    await expect(render().archiveThread(THREAD_ID)).resolves.toBe(true);

    expect(harness.archiveThread).toHaveBeenCalledWith(expect.anything(), THREAD_ID);
  });

  it("serializes archives and navigates the active thread to its fallback", async () => {
    let releaseArchive!: () => void;
    harness.archiveThread.mockImplementation(
      () => new Promise<void>((resolve) => (releaseArchive = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });

    const first = controller.archiveThread(THREAD_ID);
    const duplicate = controller.archiveThread(THREAD_ID);
    await expect(duplicate).resolves.toBe(false);
    releaseArchive();
    await expect(first).resolves.toBe(true);

    expect(harness.archiveThread).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID }, replace: true }),
    );
  });

  it("treats an already-restored invariant as successful Undo", async () => {
    harness.alreadyUnarchived = true;
    harness.unarchiveThread.mockRejectedValue(new Error("already restored"));
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(THREAD_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onUndo: () => Promise<boolean> } };
    };

    await expect(toast.data.archiveUndo.onUndo()).resolves.toBe(true);

    expect(harness.unarchiveThread).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: THREAD_ID }, replace: true }),
    );
  });

  it("deduplicates concurrent Undo requests", async () => {
    let resolveUndo!: () => void;
    harness.unarchiveThread.mockImplementation(
      () => new Promise<void>((resolve) => (resolveUndo = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(THREAD_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onUndo: () => Promise<boolean> } };
    };

    const first = toast.data.archiveUndo.onUndo();
    await expect(toast.data.archiveUndo.onUndo()).resolves.toBe(false);
    resolveUndo();
    await expect(first).resolves.toBe(true);

    expect(harness.unarchiveThread).toHaveBeenCalledOnce();
  });

  it("continues project deletion after failures and reconciles only successful ids", async () => {
    const thirdId = ThreadId.makeUnsafe("thread-third");
    sidebarThreads = [makeThread(THREAD_ID), makeThread(thirdId)];
    harness.activeThreadDelete
      .mockRejectedValueOnce(new Error("first failed"))
      .mockImplementationOnce(async (input: unknown) => {
        const action = input as {
          onDeleted: (input: { thread: { id: ThreadId; projectId: ProjectId } }) => void;
        };
        action.onDeleted({ thread: { id: thirdId, projectId: PROJECT_ID } });
      });

    const result = await render().deleteProjectThreads(PROJECT_ID, { confirmMessage: null });

    expect(harness.activeThreadDelete).toHaveBeenCalledTimes(2);
    const firstInput = harness.activeThreadDelete.mock.calls[0]?.[0] as {
      deletedThreadIds: ReadonlySet<ThreadId>;
    };
    const secondInput = harness.activeThreadDelete.mock.calls[1]?.[0] as {
      deletedThreadIds: ReadonlySet<ThreadId>;
    };
    expect(firstInput.deletedThreadIds).toBe(secondInput.deletedThreadIds);
    expect([...firstInput.deletedThreadIds]).toEqual([THREAD_ID, thirdId]);
    expect(harness.reconcileDeletedThreads).toHaveBeenCalledWith(
      expect.objectContaining({ threadIds: [thirdId] }),
    );
    expect(result).toMatchObject({ deletedCount: 1, failureCount: 1, totalCount: 2 });
  });

  it("navigates split deletion to the surviving focused pane after cleanup", async () => {
    const splitView = { id: "split-actions" } as never;
    harness.resolveSplitViewPaneIdForThread.mockReturnValue("pane-deleted");
    harness.resolveSplitViewFocusedThreadId.mockReturnValue(FALLBACK_ID);
    harness.splitViewsById = { "split-actions": { id: "split-actions" } };

    await render({
      activeSplitView: splitView,
      routeSplitViewId: "split-actions",
      routeThreadId: THREAD_ID,
    }).deleteThread(THREAD_ID);

    expect(harness.removeThreadFromSplitViews).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.clearDraftThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.clearTerminalState).toHaveBeenCalledWith(THREAD_ID);
    const navigation = harness.navigate.mock.calls.at(-1)?.[0] as {
      params: { threadId: ThreadId };
      search: () => { splitViewId: string };
    };
    expect(navigation.params).toEqual({ threadId: FALLBACK_ID });
    expect(navigation.search()).toEqual({ splitViewId: "split-actions" });
  });

  it("opens a fresh chat when deleting the last pane leaves no fallback", async () => {
    sidebarThreads = [makeThread(THREAD_ID)];
    harness.resolveSplitViewPaneIdForThread.mockReturnValue("pane-only");
    harness.resolveSplitViewFocusedThreadId.mockReturnValue(null);

    await render({
      activeSplitView: { id: "split-empty" } as never,
      routeSplitViewId: "split-empty",
      routeThreadId: THREAD_ID,
    }).deleteThread(THREAD_ID);

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).toHaveBeenCalledWith({ fresh: true });
  });
});
