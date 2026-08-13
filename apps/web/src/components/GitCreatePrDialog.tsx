// FILE: GitCreatePrDialog.tsx
// Purpose: Render the Create PR dialog: branch summary, optional PR title/description,
//          local-changes toggle with diff stats, and create/draft/browser actions.
// Layer: Header action control
// Depends on: GitActionsControl.logic resolvers and the shared git dialog chrome.

import { useEffect, useMemo, useState } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { DiffStat } from "~/components/ui/diff-stat";
import { SubmitShortcutKbd } from "~/components/ui/kbd";
import {
  type CreatePrBrowserPreparation,
  type GitDialogContext,
  resolveCreatePrBrowserPreparation,
  resolveCreatePrDialogExecution,
  resolveCreatePrDialogView,
} from "./GitActionsControl.logic";
import {
  GIT_DIALOG_FIELD_CLASS,
  GitDialogActionList,
  GitDialogActionRow,
  GitDialogBody,
  GitDialogHeading,
  GitDialogShell,
} from "./GitDialogChrome";
import { ArrowUpRightIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

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
  context: GitDialogContext;
  onSubmit: (submission: GitCreatePrDialogSubmission) => void;
  onOpenInBrowser: (request: GitCreatePrDialogBrowserRequest) => void;
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
    <GitDialogShell open={open} onOpenChange={onOpenChange} onSubmitShortcut={() => submit(false)}>
      <GitDialogHeading
        eyebrow={`${view.isNewBranch ? "New branch" : "Branch"} → ${view.baseBranchName}`}
        subject={
          view.willCreateFeatureBranch
            ? "Auto-named feature branch"
            : (view.branchName ?? "(detached HEAD)")
        }
        subjectMuted={view.willCreateFeatureBranch}
      />
      <GitDialogBody>
        <input
          autoFocus
          aria-label="Pull request title"
          className={GIT_DIALOG_FIELD_CLASS}
          maxLength={300}
          placeholder="Title (leave empty to generate)"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Pull request description"
          className={cn(GIT_DIALOG_FIELD_CLASS, "resize-none")}
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
            <DiffStat
              className="shrink-0 font-mono text-xs"
              insertions={view.insertions}
              deletions={view.deletions}
            />
          </label>
        )}
        {unavailableHint && <p className="py-1 text-warning text-xs">{unavailableHint}</p>}
      </GitDialogBody>
      <GitDialogActionList>
        <GitDialogActionRow
          disabled={!canCreate}
          icon={<GitPullRequestDraftIcon />}
          label="Create draft PR"
          onClick={() => submit(true)}
        />
        <GitDialogActionRow
          highlighted
          disabled={!canCreate}
          icon={<GitPullRequestIcon />}
          label="Create PR"
          trailing={<SubmitShortcutKbd />}
          onClick={() => submit(false)}
        />
        <GitDialogActionRow
          disabled={!canOpenInBrowser}
          icon={<ArrowUpRightIcon />}
          label="Open PR in browser"
          onClick={() => onOpenInBrowser({ preparation: browserPreparation, includeLocalChanges })}
        />
      </GitDialogActionList>
    </GitDialogShell>
  );
}
