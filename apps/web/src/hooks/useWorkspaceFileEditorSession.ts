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
  onSavingChange?: ((saving: boolean) => void) | undefined;
}): WorkspaceFileEditorSession {
  const { cwd, enabled, filePath, onClose, onDirtyChange, onSavingChange, surfaceRef } = input;
  const controller = useWorkspaceFileEditor({ cwd, filePath, enabled });
  const [pendingDiscard, setPendingDiscard] = useState<WorkspaceFileEditorDiscardIntent | null>(
    null,
  );
  const { dirty, reloadFromDisk, save } = controller;
  const saving = controller.state.saving;
  // A close or reload requested while a save is in flight waits for that save:
  // unmounting immediately would let the write land after "discard" promised
  // otherwise. A failed save keeps the buffer so its error stays visible.
  const [afterSave, setAfterSave] = useState<WorkspaceFileEditorDiscardIntent | null>(null);
  useEffect(() => {
    if (afterSave === null || saving) {
      return;
    }
    setAfterSave(null);
    if (dirty) {
      return;
    }
    if (afterSave === "close") {
      onClose();
    } else {
      reloadFromDisk();
    }
  }, [afterSave, dirty, onClose, reloadFromDisk, saving]);

  useWorkspaceFileEditorSaveShortcut({ enabled, surfaceRef, onSave: save });

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
    return () => onDirtyChangeRef.current?.(false);
  }, [dirty]);
  const onSavingChangeRef = useRef(onSavingChange);
  onSavingChangeRef.current = onSavingChange;
  useEffect(() => {
    onSavingChangeRef.current?.(saving);
    return () => onSavingChangeRef.current?.(false);
  }, [saving]);

  const requestClose = useCallback(() => {
    if (saving) {
      setAfterSave("close");
      return;
    }
    if (dirty) {
      setPendingDiscard("close");
      return;
    }
    onClose();
  }, [dirty, onClose, saving]);

  const requestReload = useCallback(() => {
    if (saving) {
      setAfterSave("reload");
      return;
    }
    if (dirty) {
      setPendingDiscard("reload");
      return;
    }
    reloadFromDisk();
  }, [dirty, reloadFromDisk, saving]);

  const confirmPendingDiscard = useCallback(() => {
    const intent = pendingDiscard;
    setPendingDiscard(null);
    if (intent === null) {
      return;
    }
    if (saving) {
      setAfterSave(intent);
      return;
    }
    if (intent === "close") {
      onClose();
      return;
    }
    reloadFromDisk();
  }, [onClose, pendingDiscard, reloadFromDisk, saving]);

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
