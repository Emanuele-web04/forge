import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  useWorkspaceFileEditor,
  type WorkspaceFileEditorController,
} from "./useWorkspaceFileEditor";
import { useWorkspaceFileEditorSaveShortcut } from "./useWorkspaceFileEditorShortcuts";

export type WorkspaceFileEditorDiscardIntent = "close" | "reload";

export interface WorkspaceFileEditorSession extends WorkspaceFileEditorController {
  pendingDiscard: WorkspaceFileEditorDiscardIntent | null;
  requestClose: () => void;
  requestReload: () => void;
  confirmPendingDiscard: () => void;
  cancelPendingDiscard: () => void;
}

export function useWorkspaceFileEditorSession(input: {
  cwd: string | null;
  filePath: string | null;
  enabled: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}): WorkspaceFileEditorSession {
  const { cwd, enabled, filePath, onClose, onDirtyChange, surfaceRef } = input;
  const controller = useWorkspaceFileEditor({ cwd, filePath, enabled });
  const [pendingDiscard, setPendingDiscard] = useState<WorkspaceFileEditorDiscardIntent | null>(
    null,
  );
  const { dirty, reloadFromDisk, save } = controller;

  useWorkspaceFileEditorSaveShortcut({ enabled, surfaceRef, onSave: save });

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
    return () => onDirtyChangeRef.current?.(false);
  }, [dirty]);

  const requestClose = useCallback(() => {
    if (dirty) {
      setPendingDiscard("close");
      return;
    }
    onClose();
  }, [dirty, onClose]);

  const requestReload = useCallback(() => {
    if (dirty) {
      setPendingDiscard("reload");
      return;
    }
    reloadFromDisk();
  }, [dirty, reloadFromDisk]);

  const confirmPendingDiscard = useCallback(() => {
    const intent = pendingDiscard;
    setPendingDiscard(null);
    if (intent === "close") {
      onClose();
      return;
    }
    if (intent === "reload") {
      reloadFromDisk();
    }
  }, [onClose, pendingDiscard, reloadFromDisk]);

  const cancelPendingDiscard = useCallback(() => {
    setPendingDiscard(null);
  }, []);

  useEffect(() => {
    if (!enabled || dirty) {
      return;
    }
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, enabled, onClose]);

  return {
    ...controller,
    pendingDiscard,
    requestClose,
    requestReload,
    confirmPendingDiscard,
    cancelPendingDiscard,
  };
}
