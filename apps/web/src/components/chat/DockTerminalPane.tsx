// FILE: DockTerminalPane.tsx
// Purpose: Render an independent terminal workspace inside the right dock for a host thread.
// Layer: Chat right-dock UI
// Depends on: useTerminalSurfaceController (shared store wiring), ThreadTerminalDrawer.
//
// The dock terminal set is isolated from the bottom drawer via a synthetic scope id
// (dockTerminalThreadId), so the two never share xterm instances. All store wiring is
// shared with WorkspaceView through useTerminalSurfaceController; only the
// "ensure a terminal is open" policy is surface-specific (here: a single terminal-only page).

import { type ProjectId, type ThreadId } from "@synara/contracts";
import { useMemo, useEffect } from "react";

import { useTerminalSurfaceController } from "~/hooks/useTerminalSurfaceController";
import { dockTerminalThreadId } from "~/lib/dockTerminalScope";
import { projectScriptRuntimeEnv } from "~/projectScripts";
import { useStore } from "~/store";
import { createProjectSelector, createThreadSelector } from "~/storeSelectors";
import ThreadTerminalDrawer from "../ThreadTerminalDrawer";

export function DockTerminalPane(props: {
  hostThreadId: ThreadId;
  projectId: ProjectId | null;
  // When false the pane stays mounted but hidden (another dock tab is active),
  // so the xterm runtime sleeps its visual work without detaching its DOM.
  isActive?: boolean;
}) {
  const scopeId = dockTerminalThreadId(props.hostThreadId);
  const thread = useStore(
    useMemo(() => createThreadSelector(props.hostThreadId), [props.hostThreadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const worktreePath = thread?.worktreePath ?? null;
  const projectCwd = project?.cwd ?? null;
  const cwd = worktreePath ?? projectCwd ?? "";
  const runtimeEnv = projectCwd
    ? projectScriptRuntimeEnv({ project: { cwd: projectCwd }, worktreePath })
    : {};

  const terminal = useTerminalSurfaceController(scopeId);
  const {
    terminalState,
    openTerminalThreadPage,
    bumpFocusRequest,
    newTerminalGroup,
    onSessionExited,
  } = terminal;

  // A dock terminal pane always shows a live terminal: ensure one is open on mount
  // and re-open if the user closes the last tab (normalize guarantees a default id).
  useEffect(() => {
    if (terminalState.terminalOpen) {
      return;
    }
    openTerminalThreadPage(scopeId, { terminalOnly: true });
  }, [openTerminalThreadPage, scopeId, terminalState.terminalOpen]);

  const createTerminal = () => {
    if (!terminalState.terminalOpen) {
      openTerminalThreadPage(scopeId, { terminalOnly: true });
      bumpFocusRequest();
      return;
    }
    newTerminalGroup();
  };

  return (
    <ThreadTerminalDrawer
      key={scopeId}
      threadId={scopeId}
      cwd={cwd}
      runtimeEnv={runtimeEnv}
      height={terminalState.terminalHeight}
      presentationMode="workspace"
      isVisible={props.isActive ?? true}
      terminalIds={terminalState.terminalIds}
      terminalLabelsById={terminalState.terminalLabelsById}
      terminalTitleOverridesById={terminalState.terminalTitleOverridesById}
      terminalCliKindsById={terminalState.terminalCliKindsById}
      terminalAttentionStatesById={terminalState.terminalAttentionStatesById ?? {}}
      runningTerminalIds={terminalState.runningTerminalIds}
      activeTerminalId={terminalState.activeTerminalId}
      terminalGroups={terminalState.terminalGroups}
      activeTerminalGroupId={terminalState.activeTerminalGroupId}
      focusRequestId={terminal.focusRequestId}
      onSplitTerminal={terminal.splitRight}
      onSplitTerminalDown={terminal.splitDown}
      onNewTerminal={createTerminal}
      onNewTerminalTab={terminal.createTerminalTab}
      onMoveTerminalToGroup={terminal.moveTerminalToNewGroup}
      onActiveTerminalChange={terminal.activateTerminal}
      onCloseTerminal={terminal.closeTerminal}
      onSessionExited={onSessionExited}
      onCloseTerminalGroup={terminal.closeTerminalGroup}
      onHeightChange={terminal.setTerminalHeight}
      onResizeTerminalSplit={terminal.resizeTerminalSplit}
      onTerminalMetadataChange={terminal.setTerminalMetadata}
      onTerminalActivityChange={terminal.setTerminalActivity}
      onAddTerminalContext={() => {}}
    />
  );
}

export default DockTerminalPane;
