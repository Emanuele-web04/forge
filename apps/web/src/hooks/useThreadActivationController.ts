// FILE: useThreadActivationController.ts
// Purpose: Centralize sidebar thread activation side effects around the pure activation policy.
// Exports: useThreadActivationController

import type { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@synara/contracts";
import type { LastThreadRoute } from "../chatRouteRestore";
import {
  resolveSplitViewThreadIds,
  type PaneId,
  type SplitView,
  type SplitViewId,
} from "../splitViewStore";
import { selectThreadTerminalState } from "../terminalStateStore";
import type { SidebarThreadSummary } from "../types";
import {
  resolvePreferredSplitForCommand,
  resolveThreadCommandActivation,
} from "../threadActivation.logic";

type Navigate = ReturnType<typeof useNavigate>;
type ThreadTerminalStateById = Parameters<typeof selectThreadTerminalState>[0];
type SidebarThreadActivationSummary = Pick<
  SidebarThreadSummary,
  "id" | "projectId" | "sidechatSourceThreadId"
>;

export type ThreadActivationControllerInput = {
  activeSplitView: SplitView | null;
  clearSelection: () => void;
  navigate: Navigate;
  openChatThreadPage: (threadId: ThreadId) => void;
  openSidechatDock: (input: { sidechatThreadId: ThreadId; sourceThreadId: ThreadId }) => void;
  openTerminalThreadPage: (threadId: ThreadId) => void;
  prewarmThreadDetailForIntent: (threadId: ThreadId) => void;
  rememberLastThreadRouteNow: (nextLastThreadRoute: LastThreadRoute) => void;
  routeSplitViewId: string | null | undefined;
  routeThreadId: ThreadId | null | undefined;
  selectedThreadCount: number;
  setOptimisticActiveThreadId: (threadId: ThreadId) => void;
  setSelectionAnchor: (threadId: ThreadId) => void;
  setSplitFocusedPane: (splitViewId: SplitViewId, paneId: PaneId) => void;
  sidebarThreadSummaryById: Readonly<Partial<Record<ThreadId, SidebarThreadActivationSummary>>>;
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  terminalStateByThreadId: ThreadTerminalStateById;
};

// Runs the complete sidebar activation side-effect chain for one thread intent.
export function activateThreadFromSidebarIntent(
  input: ThreadActivationControllerInput,
  threadId: ThreadId,
): void {
  const {
    activeSplitView,
    clearSelection,
    navigate,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId,
    routeThreadId,
    selectedThreadCount,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
  } = input;

  const targetThread = sidebarThreadSummaryById[threadId];
  const sidechatDockActivation = resolveSidechatDockActivation(input, {
    threadId,
    targetThread,
  });
  if (sidechatDockActivation) {
    activateSidechatDock(input, sidechatDockActivation);
    return;
  }

  // Active split wins first; otherwise every persisted split block can restore deterministically.
  const preferredSplitCandidate = resolvePreferredSplitForCommand({
    activeSplitView,
    splitViewsById,
    threadId,
  });
  const preferredSplitView = preferredSplitCandidate
    ? (splitViewsById[preferredSplitCandidate.splitViewId] ??
      (activeSplitView?.id === preferredSplitCandidate.splitViewId ? activeSplitView : null))
    : null;
  const preferredSplit =
    preferredSplitCandidate &&
    preferredSplitView &&
    resolveSplitViewThreadIds(preferredSplitView).some(
      (paneThreadId) => sidebarThreadSummaryById[paneThreadId]?.sidechatSourceThreadId,
    )
      ? null
      : preferredSplitCandidate;
  const activation = resolveThreadCommandActivation({
    threadId,
    threadExists: targetThread !== undefined,
    activeSidebarThreadId:
      routeSplitViewId && preferredSplitCandidate && !preferredSplit ? null : routeThreadId,
    preferredSplitViewId: preferredSplit?.splitViewId ?? null,
    splitPaneId: preferredSplit?.paneId ?? null,
  });

  if (activation.kind === "ignore") {
    return;
  }

  if (activation.kind === "single") {
    activateThreadSingle(input, activation.threadId);
    return;
  }

  if (routeThreadId === activation.threadId && routeSplitViewId === activation.splitViewId) {
    return;
  }

  prewarmThreadDetailForIntent(activation.threadId);
  setOptimisticActiveThreadId(activation.threadId);
  if (selectedThreadCount > 0) {
    clearSelection();
  }
  setSelectionAnchor(activation.threadId);
  setSplitFocusedPane(activation.splitViewId, activation.paneId);
  rememberLastThreadRouteNow({
    threadId: activation.threadId,
    splitViewId: activation.splitViewId,
  });
  void navigate({
    to: "/$threadId",
    params: { threadId: activation.threadId },
    search: (previous) => ({
      ...previous,
      splitViewId: activation.splitViewId,
    }),
  });
}

function resolveSidechatDockActivation(
  input: ThreadActivationControllerInput,
  options: {
    threadId: ThreadId;
    targetThread: SidebarThreadActivationSummary | undefined;
  },
): { threadId: ThreadId; sourceThreadId: ThreadId } | null {
  if (!options.targetThread?.sidechatSourceThreadId) {
    return null;
  }
  const sourceThread = input.sidebarThreadSummaryById[options.targetThread.sidechatSourceThreadId];
  if (!sourceThread) {
    return null;
  }
  return {
    threadId: options.threadId,
    sourceThreadId: options.targetThread.sidechatSourceThreadId,
  };
}

// Sidechat rows always target the source thread's dock, matching where sidechats
// are created and avoiding a second, conflicting split-view navigation model.
function activateSidechatDock(
  input: ThreadActivationControllerInput,
  activation: {
    threadId: ThreadId;
    sourceThreadId: ThreadId;
  },
): void {
  input.prewarmThreadDetailForIntent(activation.sourceThreadId);
  input.prewarmThreadDetailForIntent(activation.threadId);
  input.setOptimisticActiveThreadId(activation.sourceThreadId);
  if (input.selectedThreadCount > 0) {
    input.clearSelection();
  }
  input.setSelectionAnchor(activation.threadId);

  input.openChatThreadPage(activation.sourceThreadId);
  input.openSidechatDock({
    sourceThreadId: activation.sourceThreadId,
    sidechatThreadId: activation.threadId,
  });
  input.rememberLastThreadRouteNow({
    threadId: activation.sourceThreadId,
  });
  void input.navigate({
    to: "/$threadId",
    params: { threadId: activation.sourceThreadId },
    search: (previous) => ({
      ...previous,
      splitViewId: undefined,
    }),
  });
}

// Opens the target as a single chat while preserving chat-vs-terminal entry point.
function activateThreadSingle(input: ThreadActivationControllerInput, threadId: ThreadId): void {
  if (!input.sidebarThreadSummaryById[threadId]) return;

  input.prewarmThreadDetailForIntent(threadId);
  input.setOptimisticActiveThreadId(threadId);
  if (input.selectedThreadCount > 0) {
    input.clearSelection();
  }
  input.setSelectionAnchor(threadId);

  const threadEntryPoint = selectThreadTerminalState(
    input.terminalStateByThreadId,
    threadId,
  ).entryPoint;
  if (threadEntryPoint === "terminal") {
    input.openTerminalThreadPage(threadId);
  } else {
    input.openChatThreadPage(threadId);
  }

  void input.navigate({
    to: "/$threadId",
    params: { threadId },
    search: (previous) => ({
      ...previous,
      splitViewId: undefined,
    }),
  });
}

export function useThreadActivationController(input: ThreadActivationControllerInput): {
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
} {
  const {
    activeSplitView,
    clearSelection,
    navigate,
    openChatThreadPage,
    openSidechatDock,
    openTerminalThreadPage,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId,
    routeThreadId,
    selectedThreadCount,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
    terminalStateByThreadId,
  } = input;

  const activateThread = (threadId: ThreadId) => {
    activateThreadFromSidebarIntent(
      {
        activeSplitView,
        clearSelection,
        navigate,
        openChatThreadPage,
        openSidechatDock,
        openTerminalThreadPage,
        prewarmThreadDetailForIntent,
        rememberLastThreadRouteNow,
        routeSplitViewId,
        routeThreadId,
        selectedThreadCount,
        setOptimisticActiveThreadId,
        setSelectionAnchor,
        setSplitFocusedPane,
        sidebarThreadSummaryById,
        splitViewsById,
        terminalStateByThreadId,
      },
      threadId,
    );
  };

  return { activateThreadFromSidebarIntent: activateThread };
}
