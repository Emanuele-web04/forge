// FILE: EditorDirtyRouteGuard.tsx
// Purpose: Route-level guard for the dirty editor: intercepts navigation that
// originates outside EditorWorkspaceView (sidebar links, thread switching,
// settings) via the router blocker and asks before discarding unsaved edits.
// Layer: Editor UI
// Exports: EditorDirtyRouteGuard

import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { WorkspaceFileEditorDiscardDialog } from "./chat/WorkspaceFileEditorChrome";

export function EditorDirtyRouteGuard(props: { enabled: boolean; saving: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: () => props.enabled,
    withResolver: true,
  });
  const blocked = blocker.status === "blocked" ? blocker : null;
  // A confirmed exit during an in-flight save waits for the write to settle;
  // the RPC cannot be cancelled, so leaving earlier would let it land after
  // the user was told the changes were discarded. If the save fails or new
  // edits arrive meanwhile, the buffer stays dirty and the navigation is
  // cancelled so the editor can surface the failure instead of losing edits.
  const [proceedAfterSave, setProceedAfterSave] = useState(false);
  useEffect(() => {
    if (!proceedAfterSave || props.saving || blocked === null) {
      return;
    }
    setProceedAfterSave(false);
    if (props.enabled) {
      blocked.reset();
    } else {
      blocked.proceed();
    }
  }, [blocked, proceedAfterSave, props.enabled, props.saving]);

  return (
    <WorkspaceFileEditorDiscardDialog
      open={blocked !== null}
      title="Discard unsaved changes?"
      description="Leaving this page drops the changes you have not saved yet."
      confirmLabel="Discard changes and leave"
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") {
          setProceedAfterSave(false);
          blocker.reset();
        }
      }}
      onConfirm={() => {
        if (props.saving) {
          setProceedAfterSave(true);
          return;
        }
        blocked?.proceed();
      }}
    />
  );
}
