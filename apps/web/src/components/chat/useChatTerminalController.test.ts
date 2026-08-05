// FILE: useChatTerminalController.test.ts
// Purpose: Characterizes terminal split limits, focus requests, and final-tab close behavior.
// Layer: Chat terminal controller tests

import { ThreadId } from "@synara/contracts";
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
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };
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
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T {
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

const terminalHarness = vi.hoisted(() => {
  const actions = {
    setTerminalOpen: vi.fn(),
    setTerminalPresentationMode: vi.fn(),
    setTerminalWorkspaceLayout: vi.fn(),
    openChatThreadPage: vi.fn(),
    openTerminalThreadPage: vi.fn(),
    closeWorkspaceChat: vi.fn(),
    setTerminalWorkspaceTab: vi.fn(),
    setTerminalHeight: vi.fn(),
    setTerminalMetadata: vi.fn(),
    setTerminalActivity: vi.fn(),
    splitTerminalLeft: vi.fn(),
    splitTerminalRight: vi.fn(),
    splitTerminalDown: vi.fn(),
    splitTerminalUp: vi.fn(),
    newTerminal: vi.fn(),
    newTerminalTab: vi.fn(),
    openNewFullWidthTerminal: vi.fn(),
    setActiveTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    closeTerminalGroup: vi.fn(),
    resizeTerminalSplit: vi.fn(),
  };

  const makeTerminalState = (terminalIds: string[]) => ({
    entryPoint: "terminal" as const,
    terminalOpen: true,
    presentationMode: "drawer" as const,
    workspaceLayout: "both" as const,
    workspaceActiveTab: "terminal" as const,
    terminalHeight: 280,
    terminalIds,
    terminalLabelsById: { [terminalIds[0] ?? "terminal-1"]: "Shell" },
    terminalTitleOverridesById: {},
    terminalCliKindsById: {},
    terminalAttentionStatesById: {},
    runningTerminalIds: terminalIds.slice(0, 0),
    activeTerminalId: terminalIds[0] ?? "terminal-1",
    terminalGroups: [
      {
        id: "group-1",
        activeTerminalId: terminalIds[0] ?? "terminal-1",
        layout: {
          type: "terminal" as const,
          paneId: "pane-1",
          terminalIds,
          activeTerminalId: terminalIds[0] ?? "terminal-1",
        },
      },
    ],
    activeTerminalGroupId: "group-1",
  });

  return {
    actions,
    makeTerminalState,
    terminalState: makeTerminalState(["terminal-1"]),
  };
});

const nativeApi = vi.hoisted(() => ({ confirm: vi.fn() }));
const terminalSession = vi.hoisted(() => ({ disposeAndClose: vi.fn() }));
const terminalLogic = vi.hoisted(() => ({ shouldAutoDelete: vi.fn() }));

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useState: reactHarness.useState,
}));

vi.mock("../../terminalStateStore", () => ({
  selectThreadTerminalState: () => terminalHarness.terminalState,
  useTerminalStateStore: (selector: (state: unknown) => unknown) =>
    selector({ terminalStateByThreadId: {}, ...terminalHarness.actions }),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ dialogs: { confirm: nativeApi.confirm } }),
}));

vi.mock("../ChatView.logic", () => ({
  shouldAutoDeleteTerminalThreadOnLastClose: terminalLogic.shouldAutoDelete,
}));

vi.mock("../terminal/terminalSession", () => ({
  disposeAndCloseTerminalSession: terminalSession.disposeAndClose,
}));

vi.mock("../terminal/terminalIds", () => ({
  randomTerminalId: () => "terminal-new",
}));

import { useChatTerminalController } from "./useChatTerminalController";

const THREAD_ID = ThreadId.makeUnsafe("thread-a");

describe("useChatTerminalController", () => {
  const onDeletePlaceholderThread = vi.fn();

  const render = () => {
    reactHarness.beginRender();
    return useChatTerminalController({
      threadId: THREAD_ID,
      activeThreadId: THREAD_ID,
      activeThread: {
        title: "New terminal",
        messages: [],
        latestTurn: null,
        session: null,
        activities: [],
        proposedPlans: [],
      },
      activeProjectPresent: true,
      isFocusedPane: false,
      isServerThread: true,
      confirmTerminalClose: true,
      onDeletePlaceholderThread,
    });
  };

  beforeEach(() => {
    reactHarness.reset();
    vi.stubGlobal("window", {});
    terminalHarness.terminalState = terminalHarness.makeTerminalState(["terminal-1"]);
    for (const action of Object.values(terminalHarness.actions)) action.mockReset();
    nativeApi.confirm.mockReset().mockResolvedValue(true);
    terminalSession.disposeAndClose.mockReset();
    terminalLogic.shouldAutoDelete.mockReset().mockReturnValue(false);
    onDeletePlaceholderThread.mockReset();
  });

  it("bumps focus after a split and refuses splits at the group limit", () => {
    let result = render();

    result.splitTerminalRight();
    result = render();

    expect(terminalHarness.actions.splitTerminalRight).toHaveBeenCalledWith(
      THREAD_ID,
      "terminal-new",
    );
    expect(result.terminalFocusRequestId).toBe(1);

    terminalHarness.terminalState = terminalHarness.makeTerminalState(
      Array.from({ length: 6 }, (_, index) => `terminal-${index + 1}`),
    );
    result = render();
    result.splitTerminalRight();
    result = render();

    expect(result.hasReachedSplitLimit).toBe(true);
    expect(terminalHarness.actions.splitTerminalRight).toHaveBeenCalledTimes(1);
    expect(result.terminalFocusRequestId).toBe(1);
  });

  it("honors close confirmation before deleting a final placeholder terminal thread", async () => {
    terminalHarness.terminalState = {
      ...terminalHarness.makeTerminalState(["terminal-1"]),
      runningTerminalIds: ["terminal-1"],
    };
    terminalLogic.shouldAutoDelete.mockReturnValue(true);
    nativeApi.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let result = render();

    await result.closeTerminal("terminal-1");

    expect(nativeApi.confirm).toHaveBeenCalledWith(
      'Close terminal "Shell"?\nThis permanently clears the terminal history for this tab and deletes the empty terminal thread.',
    );
    expect(terminalSession.disposeAndClose).not.toHaveBeenCalled();
    expect(terminalHarness.actions.closeTerminal).not.toHaveBeenCalled();
    expect(onDeletePlaceholderThread).not.toHaveBeenCalled();

    await result.closeTerminal("terminal-1");
    result = render();

    expect(terminalSession.disposeAndClose).toHaveBeenCalledWith({
      api: expect.any(Object),
      threadId: THREAD_ID,
      terminalId: "terminal-1",
      clearHistoryBeforeClose: true,
    });
    expect(terminalHarness.actions.closeTerminal).toHaveBeenCalledWith(THREAD_ID, "terminal-1");
    expect(onDeletePlaceholderThread).toHaveBeenCalledWith(THREAD_ID);
    expect(result.terminalFocusRequestId).toBe(1);
  });

  it("finalizes a naturally exited terminal without confirmation or placeholder deletion", () => {
    terminalHarness.terminalState = {
      ...terminalHarness.makeTerminalState(["terminal-1"]),
      runningTerminalIds: ["terminal-1"],
    };
    terminalLogic.shouldAutoDelete.mockReturnValue(true);
    let result = render();

    result.handleTerminalSessionExited("terminal-1");
    result = render();

    expect(nativeApi.confirm).not.toHaveBeenCalled();
    expect(terminalLogic.shouldAutoDelete).not.toHaveBeenCalled();
    expect(terminalSession.disposeAndClose).toHaveBeenCalledWith({
      api: expect.any(Object),
      threadId: THREAD_ID,
      terminalId: "terminal-1",
      clearHistoryBeforeClose: true,
      processAlreadyExited: true,
    });
    expect(terminalHarness.actions.closeTerminal).toHaveBeenCalledWith(THREAD_ID, "terminal-1");
    expect(onDeletePlaceholderThread).not.toHaveBeenCalled();
    expect(result.terminalFocusRequestId).toBe(1);
  });
});
