// FILE: ThreadFolderRemovalDialog.tsx
// Purpose: Makes folder archive/delete consequences explicit for contained threads.
// Layer: Sidebar UI component
// Exports: ThreadFolderRemovalDialog

import { useState } from "react";

import { pluralize } from "@synara/shared/text";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export type ThreadFolderRemovalMode = "archive" | "delete";
export type ThreadFolderRemovalDisposition = "move-to-project" | "include-threads";

export function ThreadFolderRemovalDialog({
  open,
  folderName,
  threadCount,
  mode,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  folderName: string;
  threadCount: number;
  mode: ThreadFolderRemovalMode;
  onOpenChange: (open: boolean) => void;
  onConfirm: (disposition: ThreadFolderRemovalDisposition) => Promise<void> | void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "archive" ? "Archive" : "Delete"} folder “{folderName}”?
          </DialogTitle>
          <DialogDescription>
            Choose what happens to {threadCount} {pluralize(threadCount, "thread")} currently in
            this folder.
          </DialogDescription>
        </DialogHeader>
        <ThreadFolderRemovalActions
          mode={mode}
          threadCount={threadCount}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ThreadFolderRemovalActions({
  mode,
  threadCount,
  onOpenChange,
  onConfirm,
}: {
  mode: ThreadFolderRemovalMode;
  threadCount: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (disposition: ThreadFolderRemovalDisposition) => Promise<void> | void;
}) {
  const [workingDisposition, setWorkingDisposition] =
    useState<ThreadFolderRemovalDisposition | null>(null);
  const busy = workingDisposition !== null;

  const confirm = async (disposition: ThreadFolderRemovalDisposition) => {
    if (busy) return;
    setWorkingDisposition(disposition);
    try {
      await onConfirm(disposition);
      onOpenChange(false);
    } catch {
      setWorkingDisposition(null);
    }
  };

  return (
    <>
      <DialogPanel className="pb-1 text-sm text-muted-foreground">
        <p>
          Moving them to the project keeps every thread unchanged. Including them will
          {mode === "archive"
            ? " archive the threads too; they can be restored later from Settings."
            : " permanently delete their conversation history."}
        </p>
      </DialogPanel>
      <DialogFooter className="sm:flex-wrap">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void confirm("move-to-project")}
        >
          {workingDisposition === "move-to-project" ? "Moving…" : "Move threads to project"}
        </Button>
        <Button
          variant={mode === "delete" ? "destructive" : "default"}
          size="sm"
          disabled={busy || threadCount === 0}
          onClick={() => void confirm("include-threads")}
        >
          {workingDisposition === "include-threads"
            ? mode === "archive"
              ? "Archiving…"
              : "Deleting…"
            : `${mode === "archive" ? "Archive" : "Delete"} folder and threads`}
        </Button>
      </DialogFooter>
    </>
  );
}
