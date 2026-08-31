import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { useWorkspaceFileEditorSession } from "~/hooks/useWorkspaceFileEditorSession";
import type { DiffEditBaseRev } from "~/lib/diffEditBaseRev";
import { gitReadFileAtRevQueryOptions } from "~/lib/gitReactQuery";
import { Columns2Icon, Rows3Icon } from "~/lib/icons";
import { CodeDiffEditorPane } from "../codeEditor/CodeDiffEditorPane";
import {
  INITIAL_CODE_EDIT_HISTORY_STATE,
  type CodeEditHistoryControls,
} from "../codeEditor/pierreEdit";
import { ChatHeaderIconButton } from "./chatHeaderControls";
import { PanelStateMessage } from "./PanelStateMessage";
import {
  WorkspaceFileEditorConflictBar,
  WorkspaceFileEditorDiscardDialog,
  WorkspaceFileEditorHeader,
  WorkspaceFileEditorHistoryActions,
} from "./WorkspaceFileEditorChrome";

export interface WorkspaceFileDiffEditorPaneProps {
  workspaceRoot: string | null;
  filePath: string;
  /** Pre-change path for renamed files: the base revision read uses it. */
  basePath?: string | null | undefined;
  baseRev: DiffEditBaseRev;
  resolvedTheme: "light" | "dark";
  onClose: () => void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export function WorkspaceFileDiffEditorPane(props: WorkspaceFileDiffEditorPaneProps) {
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const historyControlsRef = useRef<CodeEditHistoryControls | null>(null);
  const [history, setHistory] = useState(INITIAL_CODE_EDIT_HISTORY_STATE);
  const session = useWorkspaceFileEditorSession({
    cwd: props.workspaceRoot,
    filePath: props.filePath,
    enabled: true,
    onClose: props.onClose,
    onDirtyChange: props.onDirtyChange,
  });
  const originalQuery = useQuery(
    gitReadFileAtRevQueryOptions({
      cwd: props.workspaceRoot,
      filePath: props.basePath ?? props.filePath,
      ...(props.baseRev.rev !== undefined ? { rev: props.baseRev.rev } : {}),
      ...(props.baseRev.mergeBaseWith !== undefined
        ? { mergeBaseWith: props.baseRev.mergeBaseWith }
        : {}),
    }),
  );
  const original = originalQuery.data?.missing ? "" : (originalQuery.data?.contents ?? "");
  const originalVersionRef = useRef({ contents: original, version: 0 });
  if (originalVersionRef.current.contents !== original) {
    originalVersionRef.current = {
      contents: original,
      version: originalVersionRef.current.version + 1,
    };
  }
  const originalTruncated = originalQuery.data?.truncated ?? false;
  const originalError =
    originalQuery.error instanceof Error
      ? originalQuery.error.message
      : originalQuery.error
        ? "Could not read the base revision of this file."
        : null;
  const editable = session.canEdit && !originalTruncated;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <WorkspaceFileEditorHeader
        workspaceRoot={props.workspaceRoot}
        filePath={props.filePath}
        title={
          originalQuery.data?.resolvedRev
            ? `vs ${originalQuery.data.resolvedRev.slice(0, 7)}`
            : "Diff"
        }
        dirty={session.dirty}
        saving={session.state.saving}
        canSave={session.dirty && editable}
        onSave={session.save}
        onClose={session.requestClose}
        actions={
          <>
            <WorkspaceFileEditorHistoryActions
              history={history}
              canRevert={session.dirty && editable}
              onUndo={() => historyControlsRef.current?.undo()}
              onRedo={() => historyControlsRef.current?.redo()}
              onRevert={() => historyControlsRef.current?.revertTo(session.state.baseline)}
            />
            <ChatHeaderIconButton
              type="button"
              tone="plain"
              label={renderSideBySide ? "Switch to inline diff" : "Switch to side-by-side diff"}
              title={renderSideBySide ? "Switch to inline diff" : "Switch to side-by-side diff"}
              onClick={() => setRenderSideBySide((previous) => !previous)}
            >
              {renderSideBySide ? (
                <Rows3Icon aria-hidden="true" className="size-3.5" />
              ) : (
                <Columns2Icon aria-hidden="true" className="size-3.5" />
              )}
            </ChatHeaderIconButton>
          </>
        }
      />
      {session.state.saveError ? (
        <WorkspaceFileEditorConflictBar
          message={session.state.saveError}
          conflict={session.state.conflict}
          onReload={session.requestReload}
          onOverwrite={session.overwrite}
          onDismiss={session.dismissConflict}
        />
      ) : originalTruncated ? (
        <div className="shrink-0 border-b border-border bg-[var(--color-background-elevated-secondary)] px-3 py-1.5 text-[11px] text-muted-foreground">
          The base revision of this file is too large to load in full, so this diff is read-only.
        </div>
      ) : null}
      {(session.loadError ?? originalError) ? (
        <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
          <p className="text-left text-[11px] text-destructive/85">
            {session.loadError ?? originalError}
          </p>
        </PanelStateMessage>
      ) : session.truncated ? (
        <PanelStateMessage density="compact" fill="flex">
          <p>This file is too large to open in the editor without truncating it.</p>
        </PanelStateMessage>
      ) : session.loading || originalQuery.isLoading || !session.canEdit ? (
        <PanelStateMessage density="compact" fill="flex">
          <p>Loading diff...</p>
        </PanelStateMessage>
      ) : (
        <CodeDiffEditorPane
          original={original}
          originalVersion={originalVersionRef.current.version}
          modified={session.state.value}
          modifiedVersion={session.state.version}
          fileName={props.filePath}
          resolvedTheme={props.resolvedTheme}
          renderSideBySide={renderSideBySide}
          readOnly={!editable}
          onChange={session.handleChange}
          onSave={session.save}
          historyControlsRef={historyControlsRef}
          onHistoryChange={setHistory}
        />
      )}
      <WorkspaceFileEditorDiscardDialog
        open={session.pendingDiscard !== null}
        title="Discard unsaved changes?"
        description={
          session.pendingDiscard === "reload"
            ? "Reloading replaces the editor contents with what is currently on disk."
            : "Closing the diff editor drops the changes you have not saved yet."
        }
        confirmLabel={
          session.pendingDiscard === "reload" ? "Reload and discard" : "Discard changes"
        }
        onOpenChange={(open) => {
          if (!open) {
            session.cancelPendingDiscard();
          }
        }}
        onConfirm={session.confirmPendingDiscard}
      />
    </div>
  );
}
