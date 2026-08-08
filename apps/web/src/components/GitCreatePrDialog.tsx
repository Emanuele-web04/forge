// FILE: GitCreatePrDialog.tsx
// Purpose: Render the Create PR dialog: branch summary, optional PR title/description,
//          local-changes toggle with diff stats, and create/draft/browser actions.
// Layer: Header action control
// Depends on: GitActionsControl.logic resolvers and shared dialog/checkbox/kbd primitives.

import { useEffect, useMemo, useState } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ShortcutKbd } from "~/components/ui/shortcut-kbd";
import {
  type CreatePrBrowserPreparation,
  type CreatePrDialogContext,
  resolveCreatePrBrowserPreparation,
  resolveCreatePrDialogExecution,
  resolveCreatePrDialogView,
} from "./GitActionsControl.logic";
import { cn, isMacPlatform } from "~/lib/utils";

export interface GitCreatePrDialogSubmission {
  action: "create_pr" | "commit_push_pr";
  draft: boolean;
  includeLocalChanges: boolean;
  title: string | null;
  body: string | null;
}

export interface GitCreatePrDialogBrowserRequest {
  preparation: CreatePrBrowserPreparation;
  includeLocalChanges: boolean;
}

interface GitCreatePrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: CreatePrDialogContext;
  onSubmit: (submission: GitCreatePrDialogSubmission) => void;
  onOpenInBrowser: (request: GitCreatePrDialogBrowserRequest) => void;
}

function CreatePrActionRow({
  highlighted,
  disabled,
  onClick,
  label,
  trailing,
}: {
  highlighted?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors",
        "hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:bg-[var(--color-background-button-secondary-hover)]",
        highlighted && "bg-[var(--color-background-button-secondary-hover)]",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  );
}

export function GitCreatePrDialog({
  open,
  onOpenChange,
  context,
  onSubmit,
  onOpenInBrowser,
}: GitCreatePrDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeLocalChanges, setIncludeLocalChanges] = useState(true);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setIncludeLocalChanges(true);
  }, [open]);

  const view = useMemo(() => resolveCreatePrDialogView(context), [context]);
  const execution = useMemo(
    () => resolveCreatePrDialogExecution(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const browserPreparation = useMemo(
    () => resolveCreatePrBrowserPreparation(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const canCreate = execution.kind === "run_action";
  const canOpenInBrowser = browserPreparation.kind !== "unavailable";
  const unavailableHint = execution.kind === "unavailable" ? execution.hint : null;
  const isMac = isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);

  const submit = (draft: boolean) => {
    if (execution.kind !== "run_action") return;
    onSubmit({
      action: execution.action,
      draft,
      includeLocalChanges,
      title: title.trim() || null,
      body: body.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-md"
        showCloseButton={false}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(false);
          }
        }}
      >
        <DialogHeader className="gap-0.5">
          <DialogTitle className="font-normal font-sans text-muted-foreground text-xs">
            {view.isNewBranch ? "New branch" : "Branch"} → {view.baseBranchName}
          </DialogTitle>
          <DialogDescription
            className={cn(
              "truncate font-medium text-sm",
              view.willCreateFeatureBranch
                ? "text-muted-foreground italic"
                : "text-[var(--color-text-foreground)]",
            )}
          >
            {view.willCreateFeatureBranch
              ? "Auto-named feature branch"
              : (view.branchName ?? "(detached HEAD)")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1 pt-2">
          <input
            autoFocus
            aria-label="Pull request title"
            className="w-full bg-transparent py-1 font-medium text-sm outline-none placeholder:text-muted-foreground/70"
            maxLength={300}
            placeholder="Title (leave empty to generate)"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            aria-label="Pull request description"
            className="w-full resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/70"
            maxLength={60_000}
            placeholder="Description (leave empty to generate)"
            rows={2}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {view.showCommitToggle && (
            <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
              <Checkbox
                checked={includeLocalChanges}
                onCheckedChange={(checked) => setIncludeLocalChanges(checked === true)}
              />
              <span className="flex-1">Commit and push local changes</span>
              <span className="shrink-0 font-mono text-xs">
                <span className="text-success">+{view.insertions}</span>{" "}
                <span className="text-destructive">−{view.deletions}</span>
              </span>
            </label>
          )}
          {unavailableHint && <p className="py-1 text-warning text-xs">{unavailableHint}</p>}
        </DialogPanel>
        <div className="border-[color:var(--color-border)] border-t p-2">
          <CreatePrActionRow
            disabled={!canCreate}
            label="Create draft PR"
            onClick={() => submit(true)}
          />
          <CreatePrActionRow
            highlighted
            disabled={!canCreate}
            label="Create PR"
            trailing={<ShortcutKbd shortcutLabel={isMac ? "⌘↵" : "Ctrl+↵"} />}
            onClick={() => submit(false)}
          />
          <CreatePrActionRow
            disabled={!canOpenInBrowser}
            label="Open PR in browser"
            onClick={() =>
              onOpenInBrowser({ preparation: browserPreparation, includeLocalChanges })
            }
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
