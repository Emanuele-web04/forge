// FILE: GitCommitDialog.tsx
// Purpose: Render the Commit dialog: branch summary, commit message, a compact
//          file selection with diff stats, and the shared git action rows
//          (commit on new branch / commit / commit & push / create PR).
// Layer: Header action control
// Depends on: GitActionsControl.logic resolvers and the shared git dialog chrome.

import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DiffStat } from "~/components/ui/diff-stat";
import { SubmitShortcutKbd } from "~/components/ui/kbd";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  type GitCommitDialogAction,
  type GitDialogContext,
  resolveCommitDialogActions,
} from "./GitActionsControl.logic";
import { GitActionGlyph } from "./gitActionGlyphs";
import {
  GIT_DIALOG_FIELD_CLASS,
  GitDialogActionList,
  GitDialogActionRow,
  GitDialogBody,
  GitDialogHeading,
  GitDialogShell,
} from "./GitDialogChrome";
import { cn } from "~/lib/utils";

export interface GitCommitDialogSubmission {
  action: GitCommitDialogAction["action"];
  featureBranch: boolean;
  message: string | null;
  /** null commits every changed file; otherwise only the listed paths. */
  filePaths: string[] | null;
}

interface ChangedFile {
  path: string;
  insertions: number;
  deletions: number;
}

interface GitCommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: GitDialogContext;
  onSubmit: (submission: GitCommitDialogSubmission) => void;
  onOpenFile: (filePath: string) => void;
}

export function GitCommitDialog({
  open,
  onOpenChange,
  context,
  onSubmit,
  onOpenFile,
}: GitCommitDialogProps) {
  const [message, setMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
  }, [open]);

  const gitStatus = context.gitStatus;
  const allFiles = useMemo(() => gitStatus?.workingTree.files ?? [], [gitStatus]);
  const selectedFiles = useMemo(
    () => allFiles.filter((file) => !excludedFiles.has(file.path)),
    [allFiles, excludedFiles],
  );
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  // With nothing to select the file gate is vacuous — a pure push must stay runnable.
  const hasFileSelection = allFiles.length === 0 || !noneSelected;

  const actions = useMemo(
    () => resolveCommitDialogActions({ context, hasFileSelection }),
    [context, hasFileSelection],
  );

  const submit = (action: GitCommitDialogAction) => {
    if (action.disabled) return;
    onSubmit({
      action: action.action,
      featureBranch: action.featureBranch,
      message: message.trim() || null,
      filePaths: allSelected ? null : selectedFiles.map((file) => file.path),
    });
  };

  const submitPrimary = () => {
    const primary = actions.find((action) => action.id === "commit");
    if (primary) submit(primary);
  };

  const toggleFile = (path: string) => {
    setExcludedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <GitDialogShell open={open} onOpenChange={onOpenChange} onSubmitShortcut={submitPrimary}>
      <GitDialogHeading
        eyebrow="Commit"
        eyebrowTrailing={
          context.isDefaultBranch ? <span className="text-warning">Default branch</span> : null
        }
        subject={gitStatus?.branch ?? "(detached HEAD)"}
      />
      <GitDialogBody>
        <textarea
          autoFocus
          aria-label="Commit message"
          className={cn(GIT_DIALOG_FIELD_CLASS, "resize-none")}
          maxLength={20_000}
          placeholder="Message (leave empty to generate)"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="space-y-1">
          <div className="flex items-center gap-2 py-1 text-sm">
            {isEditingFiles && allFiles.length > 0 ? (
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && !noneSelected}
                onCheckedChange={() => {
                  setExcludedFiles(
                    allSelected ? new Set(allFiles.map((file) => file.path)) : new Set(),
                  );
                }}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {summarizeSelection(allFiles.length, selectedFiles.length, allSelected)}
            </span>
            <DiffStat
              className="shrink-0 font-mono text-xs"
              insertions={selectedFiles.reduce((sum, file) => sum + file.insertions, 0)}
              deletions={selectedFiles.reduce((sum, file) => sum + file.deletions, 0)}
            />
            {allFiles.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0"
                onClick={() => setIsEditingFiles((prev) => !prev)}
              >
                {isEditingFiles ? "Done" : "Edit"}
              </Button>
            ) : null}
          </div>
          {allFiles.length > 0 ? (
            <ScrollArea className="h-32 rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]">
              <div className="space-y-1 p-1">
                {allFiles.map((file) => (
                  <ChangedFileRow
                    key={file.path}
                    file={file}
                    excluded={excludedFiles.has(file.path)}
                    selectable={isEditingFiles}
                    onToggle={() => toggleFile(file.path)}
                    onOpen={() => onOpenFile(file.path)}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : null}
        </div>
      </GitDialogBody>
      <GitDialogActionList>
        {actions.map((action) => (
          <GitDialogActionRow
            key={action.id}
            highlighted={action.id === "commit"}
            disabled={action.disabled}
            disabledReason={action.disabledReason}
            icon={<GitActionGlyph name={action.icon} className="size-4" />}
            label={action.label}
            {...(action.id === "commit" ? { trailing: <SubmitShortcutKbd /> } : {})}
            onClick={() => submit(action)}
          />
        ))}
      </GitDialogActionList>
    </GitDialogShell>
  );
}

function summarizeSelection(total: number, selected: number, allSelected: boolean): string {
  if (total === 0) return "No local changes";
  if (allSelected) return `${total} ${total === 1 ? "file" : "files"}`;
  return `${selected} of ${total} files`;
}

function ChangedFileRow({
  file,
  excluded,
  selectable,
  onToggle,
  onOpen,
}: {
  file: ChangedFile;
  excluded: boolean;
  selectable: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-[var(--color-background-button-secondary-hover)]">
      {selectable ? <Checkbox checked={!excluded} onCheckedChange={onToggle} /> : null}
      {/* Raw <button> intentionally — list-row click target, not a shadcn Button. */}
      <button
        type="button"
        className="group flex flex-1 items-center justify-between gap-3 truncate text-left"
        onClick={onOpen}
      >
        <span
          className={cn(
            "truncate underline-offset-2 group-hover:underline group-focus-visible:underline",
            excluded && "text-muted-foreground",
          )}
        >
          {file.path}
        </span>
        <span className="shrink-0">
          {excluded ? (
            <span className="text-muted-foreground">Excluded</span>
          ) : (
            <DiffStat
              insertions={file.insertions}
              deletions={file.deletions}
              separator={<span className="text-muted-foreground">/</span>}
            />
          )}
        </span>
      </button>
    </div>
  );
}
