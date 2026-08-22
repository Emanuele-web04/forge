import { type ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { resolveTerminalNewAction } from "../../lib/terminalNewAction";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { collectTerminalIdsFromLayout } from "../../terminalPaneLayout";
import { MAX_TERMINALS_PER_GROUP, type Thread } from "../../types";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
  shouldPromptForTerminalClose,
} from "../../lib/terminalCloseConfirmation";
import { readNativeApi } from "../../nativeApi";
import { shouldAutoDeleteTerminalThreadOnLastClose } from "../ChatView.logic";
import { randomTerminalId } from "../terminal/terminalIds";
import { disposeAndCloseTerminalSession } from "../terminal/terminalSession";

type AutoDeleteCandidateThread = Pick<
  Thread,
  "activities" | "latestTurn" | "messages" | "proposedPlans" | "session" | "title"
>;

interface UseChatTerminalControllerInput {
  readonly threadId: ThreadId;
  readonly activeThreadId: ThreadId | null;
  readonly activeThread: AutoDeleteCandidateThread | null | undefined;
  readonly activeProjectPresent: boolean;
  readonly isFocusedPane: boolean;
  readonly isServerThread: boolean;
  readonly confirmTerminalClose: boolean;
  readonly onDeletePlaceholderThread: (threadId: ThreadId) => Promise<void> | void;
}

export function useChatTerminalController({
  threadId,
  activeThreadId,
  activeThread,
  activeProjectPresent,
  isFocusedPane,
  isServerThread,
  confirmTerminalClose,
  onDeletePlaceholderThread,
}: UseChatTerminalControllerInput) {
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const setTerminalOpenInStore = useTerminalStateStore((state) => state.setTerminalOpen);
  const setPresentationModeInStore = useTerminalStateStore(
    (state) => state.setTerminalPresentationMode,
  );
  const setWorkspaceLayoutInStore = useTerminalStateStore(
    (state) => state.setTerminalWorkspaceLayout,
  );
  const openChatThreadPageInStore = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPageInStore = useTerminalStateStore(
    (state) => state.openTerminalThreadPage,
  );
  const closeWorkspaceChatInStore = useTerminalStateStore((state) => state.closeWorkspaceChat);
  const setWorkspaceTabInStore = useTerminalStateStore((state) => state.setTerminalWorkspaceTab);
  const setTerminalHeightInStore = useTerminalStateStore((state) => state.setTerminalHeight);
  const setTerminalMetadataInStore = useTerminalStateStore((state) => state.setTerminalMetadata);
  const setTerminalActivityInStore = useTerminalStateStore((state) => state.setTerminalActivity);
  const splitTerminalLeftInStore = useTerminalStateStore((state) => state.splitTerminalLeft);
  const splitTerminalRightInStore = useTerminalStateStore((state) => state.splitTerminalRight);
  const splitTerminalDownInStore = useTerminalStateStore((state) => state.splitTerminalDown);
  const splitTerminalUpInStore = useTerminalStateStore((state) => state.splitTerminalUp);
  const newTerminalInStore = useTerminalStateStore((state) => state.newTerminal);
  const newTerminalTabInStore = useTerminalStateStore((state) => state.newTerminalTab);
  const openFullWidthTerminalInStore = useTerminalStateStore(
    (state) => state.openNewFullWidthTerminal,
  );
  const setActiveTerminalInStore = useTerminalStateStore((state) => state.setActiveTerminal);
  const closeTerminalInStore = useTerminalStateStore((state) => state.closeTerminal);
  const closeTerminalGroupInStore = useTerminalStateStore((state) => state.closeTerminalGroup);
  const resizeTerminalSplitInStore = useTerminalStateStore((state) => state.resizeTerminalSplit);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const requestTerminalFocus = useCallback(() => {
    setFocusRequestId((value) => value + 1);
  }, []);

  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup ? collectTerminalIdsFromLayout(activeTerminalGroup.layout).length : 0) >=
    MAX_TERMINALS_PER_GROUP;
  const terminalWorkspaceOpen =
    terminalState.presentationMode === "workspace" && terminalState.terminalOpen;
  const terminalWorkspaceTerminalTabActive =
    terminalWorkspaceOpen &&
    (terminalState.workspaceLayout === "terminal-only" ||
      terminalState.workspaceActiveTab === "terminal");
  const terminalWorkspaceChatTabActive =
    terminalWorkspaceOpen &&
    terminalState.workspaceLayout === "both" &&
    terminalState.workspaceActiveTab === "chat";

  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (activeThreadId) setTerminalOpenInStore(activeThreadId, open);
    },
    [activeThreadId, setTerminalOpenInStore],
  );
  const setTerminalPresentationMode = useCallback(
    (mode: "drawer" | "workspace") => {
      if (activeThreadId) setPresentationModeInStore(activeThreadId, mode);
    },
    [activeThreadId, setPresentationModeInStore],
  );
  const setTerminalWorkspaceLayout = useCallback(
    (layout: "both" | "terminal-only") => {
      if (activeThreadId) setWorkspaceLayoutInStore(activeThreadId, layout);
    },
    [activeThreadId, setWorkspaceLayoutInStore],
  );
  const setTerminalWorkspaceTab = useCallback(
    (tab: "terminal" | "chat") => {
      if (activeThreadId) setWorkspaceTabInStore(activeThreadId, tab);
    },
    [activeThreadId, setWorkspaceTabInStore],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (activeThreadId) setTerminalHeightInStore(activeThreadId, height);
    },
    [activeThreadId, setTerminalHeightInStore],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    if (!terminalState.terminalOpen) setTerminalPresentationMode("drawer");
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, setTerminalPresentationMode, terminalState.terminalOpen]);
  const expandTerminalWorkspace = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("workspace");
    setTerminalWorkspaceLayout("both");
    setTerminalWorkspaceTab("terminal");
  }, [
    activeThreadId,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
  ]);
  const collapseTerminalWorkspace = useCallback(() => {
    if (activeThreadId) setTerminalPresentationMode("drawer");
  }, [activeThreadId, setTerminalPresentationMode]);

  const splitTerminal = useCallback(
    (direction: "left" | "right" | "down" | "up") => {
      if (!activeThreadId || hasReachedSplitLimit) return;
      const terminalId = randomTerminalId();
      const splitInStore = {
        left: splitTerminalLeftInStore,
        right: splitTerminalRightInStore,
        down: splitTerminalDownInStore,
        up: splitTerminalUpInStore,
      }[direction];
      splitInStore(activeThreadId, terminalId);
      requestTerminalFocus();
    },
    [
      activeThreadId,
      hasReachedSplitLimit,
      requestTerminalFocus,
      splitTerminalDownInStore,
      splitTerminalLeftInStore,
      splitTerminalRightInStore,
      splitTerminalUpInStore,
    ],
  );
  const splitTerminalLeft = useCallback(() => splitTerminal("left"), [splitTerminal]);
  const splitTerminalRight = useCallback(() => splitTerminal("right"), [splitTerminal]);
  const splitTerminalDown = useCallback(() => splitTerminal("down"), [splitTerminal]);
  const splitTerminalUp = useCallback(() => splitTerminal("up"), [splitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    newTerminalInStore(activeThreadId, randomTerminalId());
    requestTerminalFocus();
  }, [activeThreadId, newTerminalInStore, requestTerminalFocus]);
  const createNewTerminalTab = useCallback(
    (targetTerminalId: string) => {
      if (!activeThreadId) return;
      newTerminalTabInStore(activeThreadId, targetTerminalId, randomTerminalId());
      requestTerminalFocus();
    },
    [activeThreadId, newTerminalTabInStore, requestTerminalFocus],
  );
  const createTerminalFromShortcut = useCallback(() => {
    const action = resolveTerminalNewAction({
      terminalOpen: terminalState.terminalOpen,
      activeTerminalId: terminalState.activeTerminalId,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      terminalGroups: terminalState.terminalGroups,
    });
    if (action.kind === "new-group") {
      if (!terminalState.terminalOpen) setTerminalOpen(true);
      createNewTerminal();
      return;
    }
    createNewTerminalTab(action.targetTerminalId);
  }, [
    createNewTerminal,
    createNewTerminalTab,
    setTerminalOpen,
    terminalState.activeTerminalGroupId,
    terminalState.activeTerminalId,
    terminalState.terminalGroups,
    terminalState.terminalOpen,
  ]);
  const moveTerminalToNewGroup = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      newTerminalInStore(activeThreadId, terminalId);
      requestTerminalFocus();
    },
    [activeThreadId, newTerminalInStore, requestTerminalFocus],
  );
  const openNewFullWidthTerminal = useCallback(() => {
    if (!activeThreadId || !activeProjectPresent) return;
    openFullWidthTerminalInStore(activeThreadId, randomTerminalId());
    requestTerminalFocus();
  }, [activeProjectPresent, activeThreadId, openFullWidthTerminalInStore, requestTerminalFocus]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || !isFocusedPane) return;
    return onMenuAction((action) => {
      if (action === "new-terminal-tab") createTerminalFromShortcut();
    });
  }, [createTerminalFromShortcut, isFocusedPane]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      setActiveTerminalInStore(activeThreadId, terminalId);
      requestTerminalFocus();
    },
    [activeThreadId, requestTerminalFocus, setActiveTerminalInStore],
  );
  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const shouldDeletePlaceholderThread = shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: isFinalTerminal,
        isServerThread,
        terminalEntryPoint: terminalState.entryPoint,
        thread: activeThread,
      });
      const confirmed = await confirmTerminalTabClose({
        api,
        enabled: shouldPromptForTerminalClose({
          confirmationEnabled: confirmTerminalClose,
          runningTerminalIds: terminalState.runningTerminalIds,
          terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          terminalId,
        }),
        terminalTitle: resolveTerminalCloseTitle({
          terminalId,
          terminalLabelsById: terminalState.terminalLabelsById,
          terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
        }),
        willDeleteThread: shouldDeletePlaceholderThread,
      });
      if (!confirmed) return;
      disposeAndCloseTerminalSession({
        api,
        threadId: activeThreadId,
        terminalId,
        clearHistoryBeforeClose: isFinalTerminal,
      });
      closeTerminalInStore(activeThreadId, terminalId);
      requestTerminalFocus();
      if (shouldDeletePlaceholderThread) {
        void onDeletePlaceholderThread(activeThreadId);
      }
    },
    [
      activeThread,
      activeThreadId,
      closeTerminalInStore,
      confirmTerminalClose,
      isServerThread,
      onDeletePlaceholderThread,
      requestTerminalFocus,
      terminalState.entryPoint,
      terminalState.runningTerminalIds,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalIds.length,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
    ],
  );
  const handleTerminalSessionExited = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      disposeAndCloseTerminalSession({
        api: readNativeApi(),
        threadId: activeThreadId,
        terminalId,
        clearHistoryBeforeClose: isFinalTerminal,
        processAlreadyExited: true,
      });
      closeTerminalInStore(activeThreadId, terminalId);
      requestTerminalFocus();
    },
    [activeThreadId, closeTerminalInStore, requestTerminalFocus, terminalState.terminalIds.length],
  );
  const closeActiveWorkspaceView = useCallback(() => {
    if (!activeThreadId || !terminalWorkspaceOpen) return;
    if (terminalState.workspaceLayout === "both" && terminalState.workspaceActiveTab === "chat") {
      if (terminalState.entryPoint === "chat") {
        collapseTerminalWorkspace();
      } else {
        closeWorkspaceChatInStore(activeThreadId);
      }
      return;
    }
    void closeTerminal(terminalState.activeTerminalId);
  }, [
    activeThreadId,
    closeTerminal,
    closeWorkspaceChatInStore,
    collapseTerminalWorkspace,
    terminalState.activeTerminalId,
    terminalState.entryPoint,
    terminalState.workspaceActiveTab,
    terminalState.workspaceLayout,
    terminalWorkspaceOpen,
  ]);

  return {
    terminalState,
    terminalFocusRequestId: focusRequestId,
    requestTerminalFocus,
    hasReachedSplitLimit,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    setTerminalOpen,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
    setTerminalHeight,
    setTerminalMetadataInStore,
    setTerminalActivityInStore,
    openChatThreadPageInStore,
    openTerminalThreadPageInStore,
    newTerminalInStore,
    setActiveTerminalInStore,
    closeTerminalGroupInStore,
    resizeTerminalSplitInStore,
    toggleTerminalVisibility,
    expandTerminalWorkspace,
    collapseTerminalWorkspace,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalDown,
    splitTerminalUp,
    createNewTerminal,
    createNewTerminalTab,
    createTerminalFromShortcut,
    moveTerminalToNewGroup,
    openNewFullWidthTerminal,
    activateTerminal,
    closeTerminal,
    handleTerminalSessionExited,
    closeActiveWorkspaceView,
  };
}
