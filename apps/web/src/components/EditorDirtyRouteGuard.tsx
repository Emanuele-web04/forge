// FILE: EditorDirtyRouteGuard.tsx
// Purpose: Route-level guard for the dirty editor: intercepts navigation that
// originates outside EditorWorkspaceView (sidebar links, thread switching,
// settings) via the router blocker and asks before discarding unsaved edits.
// Layer: Editor UI
// Exports: EditorDirtyRouteGuard

import { useBlocker } from "@tanstack/react-router";

import { WorkspaceFileEditorDiscardDialog } from "./chat/WorkspaceFileEditorChrome";

export function EditorDirtyRouteGuard(props: { enabled: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: () => props.enabled,
    withResolver: true,
  });
  const blocked = blocker.status === "blocked" ? blocker : null;

  return (
    <WorkspaceFileEditorDiscardDialog
      open={blocked !== null}
      title="Discard unsaved changes?"
      description="Leaving this page drops the changes you have not saved yet."
      confirmLabel="Discard changes and leave"
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") {
          blocker.reset();
        }
      }}
      onConfirm={() => {
        blocked?.proceed();
      }}
    />
  );
}
