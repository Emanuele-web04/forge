// FILE: useTerminalSurfaceController.ts
// Purpose: Terminal-store controller for the right-dock terminal pane. Owns the
//          store selector slice, focus-request bump, and standard create/split/tab/
//          move/activate/close handlers.
// Layer: Web terminal UI hook
// Note: ChatView is intentionally NOT a consumer — it adds split limits, placeholder
//       thread cleanup, and split-view navigation, so it shares only the lower-level
//       terminalSession helpers instead of this controller.

import { type ThreadId } from "@synara/contracts";
import { type TerminalCliKind } from "@synara/shared/terminalThreads";
import { useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
  shouldPromptForTerminalClose,
} from "~/lib/terminalCloseConfirmation";
import { readNativeApi } from "~/nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import { randomTerminalId } from "~/components/terminal/terminalIds";
import { disposeAndCloseTerminalSession } from "~/components/terminal/terminalSession";

type TerminalMetadata = { cliKind: TerminalCliKind | null; label: string };
type TerminalActivity = {
  hasRunningSubprocess: boolean;
  agentState: "running" | "attention" | "review" | null;
};

export function useTerminalSurfaceController(threadId: ThreadId) {
  const { settings } = useAppSettings();
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const openTerminalThreadPage = useTerminalStateStore((s) => s.openTerminalThreadPage);
  const newTerminal = useTerminalStateStore((s) => s.newTerminal);
  const newTerminalTab = useTerminalStateStore((s) => s.newTerminalTab);
  const splitTerminalRightStore = useTerminalStateStore((s) => s.splitTerminalRight);
  const splitTerminalDownStore = useTerminalStateStore((s) => s.splitTerminalDown);
  const setActiveTerminalStore = useTerminalStateStore((s) => s.setActiveTerminal);
  const closeTerminalAndEnsureReplacementStore = useTerminalStateStore(
    (s) => s.closeTerminalAndEnsureReplacement,
  );
  const closeExitedTerminalStore = useTerminalStateStore((s) => s.closeExitedTerminal);
  const closeTerminalGroupStore = useTerminalStateStore((s) => s.closeTerminalGroup);
  const setTerminalHeightStore = useTerminalStateStore((s) => s.setTerminalHeight);
  const resizeTerminalSplitStore = useTerminalStateStore((s) => s.resizeTerminalSplit);
  const setTerminalMetadataStore = useTerminalStateStore((s) => s.setTerminalMetadata);
  const setTerminalActivityStore = useTerminalStateStore((s) => s.setTerminalActivity);

  const [focusRequestId, setFocusRequestId] = useState(0);
  const bumpFocusRequest = () => setFocusRequestId((value) => value + 1);

  const newTerminalGroup = () => {
    newTerminal(threadId, randomTerminalId());
    bumpFocusRequest();
  };

  const splitRight = () => {
    splitTerminalRightStore(threadId, randomTerminalId());
    bumpFocusRequest();
  };

  const splitDown = () => {
    splitTerminalDownStore(threadId, randomTerminalId());
    bumpFocusRequest();
  };

  const createTerminalTab = (targetTerminalId: string) => {
    newTerminalTab(threadId, targetTerminalId, randomTerminalId());
    bumpFocusRequest();
  };

  const moveTerminalToNewGroup = (terminalId: string) => {
    newTerminal(threadId, terminalId);
    bumpFocusRequest();
  };

  const activateTerminal = (terminalId: string) => {
    setActiveTerminalStore(threadId, terminalId);
    bumpFocusRequest();
  };

  const closeTerminal = async (terminalId: string) => {
    const api = readNativeApi();
    const confirmed = await confirmTerminalTabClose({
      api,
      enabled: shouldPromptForTerminalClose({
        confirmationEnabled: settings.confirmTerminalTabClose,
        runningTerminalIds: terminalState.runningTerminalIds,
        terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
        terminalId,
      }),
      terminalTitle: resolveTerminalCloseTitle({
        terminalId,
        terminalLabelsById: terminalState.terminalLabelsById,
        terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
      }),
    });
    if (!confirmed) {
      return;
    }
    disposeAndCloseTerminalSession({ api, threadId, terminalId });
    closeTerminalAndEnsureReplacementStore(threadId, terminalId, randomTerminalId());
    bumpFocusRequest();
  };

  const disposeExitedTerminal = (terminalId: string) => {
    disposeAndCloseTerminalSession({
      api: readNativeApi(),
      threadId,
      terminalId,
      processAlreadyExited: true,
    });
  };

  const handleTerminalSessionExited = (terminalId: string) => {
    disposeExitedTerminal(terminalId);
    closeTerminalAndEnsureReplacementStore(threadId, terminalId, randomTerminalId());
    bumpFocusRequest();
  };

  const handleDockTerminalSessionExited = (terminalId: string) => {
    disposeExitedTerminal(terminalId);
    const disposition = closeExitedTerminalStore(threadId, terminalId);
    bumpFocusRequest();
    return disposition;
  };

  const closeTerminalGroup = (groupId: string) => closeTerminalGroupStore(threadId, groupId);

  const setTerminalHeight = (height: number) => setTerminalHeightStore(threadId, height);

  const resizeTerminalSplit = (groupId: string, splitId: string, weights: number[]) =>
    resizeTerminalSplitStore(threadId, groupId, splitId, weights);

  const setTerminalMetadata = (terminalId: string, metadata: TerminalMetadata) =>
    setTerminalMetadataStore(threadId, terminalId, metadata);

  const setTerminalActivity = (terminalId: string, activity: TerminalActivity) =>
    setTerminalActivityStore(threadId, terminalId, activity);

  return {
    terminalState,
    focusRequestId,
    bumpFocusRequest,
    openTerminalThreadPage,
    newTerminalGroup,
    splitRight,
    splitDown,
    createTerminalTab,
    moveTerminalToNewGroup,
    activateTerminal,
    closeTerminal,
    handleTerminalSessionExited,
    handleDockTerminalSessionExited,
    closeTerminalGroup,
    setTerminalHeight,
    resizeTerminalSplit,
    setTerminalMetadata,
    setTerminalActivity,
  };
}
