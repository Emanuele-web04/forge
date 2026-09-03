// FILE: AutomationHeadingFields.tsx
// Purpose: Inline-editable name/prompt heading for the automation detail page.
// Layer: Web components (automation)
// Exports: AutomationNameField, AutomationPromptField, AutomationSaveStatus.
// The fields derive from the saved definition and commit on blur; a failed save rolls
// back through the mutation's cache rollback, snapping the field to the server value.

import { useEffect, useRef, useState } from "react";

import { automationNameError, automationPromptError } from "~/lib/automationForm";
import { useCommitDraft, useCommitDraftBlurHandlers } from "~/lib/automationInlineDraft";
import { cn } from "~/lib/utils";

const HEADING_FIELD_CLASS =
  "-mx-2 w-full rounded-md bg-transparent px-2 outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] disabled:hover:bg-transparent";

// Commits are trimmed before comparing to the saved value, so a whitespace-only edit
// reverts instead of round-tripping a no-op update through the server.
const trimDraft = (value: string) => value.trim();

/** The detail page's heading: an input styled as the page title. Enter commits, Escape reverts. */
export function AutomationNameField({
  value,
  onCommit,
  disabled,
  title,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  const draft = useCommitDraft({
    value,
    onCommit,
    validate: automationNameError,
    normalize: trimDraft,
  });
  const { onBlur, revertAndBlur } = useCommitDraftBlurHandlers(draft);
  return (
    <input
      value={draft.draft}
      disabled={disabled}
      title={title}
      aria-label="Automation name"
      aria-invalid={draft.error !== null || undefined}
      placeholder="Automation name"
      onChange={(event) => draft.setDraft(event.target.value)}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          revertAndBlur(event.currentTarget);
        }
      }}
      className={cn(
        HEADING_FIELD_CLASS,
        "py-1 font-heading text-2xl font-normal text-foreground placeholder:text-muted-foreground/50",
      )}
    />
  );
}

/** The automation prompt as an auto-growing textarea. Cmd/Ctrl+Enter commits, Escape reverts. */
export function AutomationPromptField({
  value,
  onCommit,
  disabled,
  title,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  const draft = useCommitDraft({
    value,
    onCommit,
    validate: automationPromptError,
    normalize: trimDraft,
  });
  const { onBlur, revertAndBlur } = useCommitDraftBlurHandlers(draft);
  return (
    <textarea
      value={draft.draft}
      disabled={disabled}
      title={title}
      aria-label="Automation prompt"
      aria-invalid={draft.error !== null || undefined}
      placeholder="What should this automation do on each run?"
      rows={1}
      onChange={(event) => draft.setDraft(event.target.value)}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          revertAndBlur(event.currentTarget);
        }
      }}
      className={cn(
        HEADING_FIELD_CLASS,
        "field-sizing-content resize-none whitespace-pre-wrap py-1.5 text-[0.9375rem] leading-relaxed text-muted-foreground placeholder:text-muted-foreground/50 focus-visible:text-foreground",
      )}
    />
  );
}

/**
 * Shared save feedback for the heading fields: "Saving…" while an update is in flight and a
 * short-lived "Saved" only on a success transition — a failed save rolls the fields back and
 * toasts instead, so it must not flash "Saved".
 */
export function AutomationSaveStatus({
  saving,
  failed,
}: {
  readonly saving: boolean;
  readonly failed: boolean;
}) {
  const [showSaved, setShowSaved] = useState(false);
  const wasSaving = useRef(saving);
  useEffect(() => {
    const finished = wasSaving.current && !saving;
    wasSaving.current = saving;
    if (!finished || failed) return undefined;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saving, failed]);
  return (
    <p aria-live="polite" className="h-4 text-xs text-muted-foreground/70">
      {saving ? "Saving…" : showSaved ? "Saved" : ""}
    </p>
  );
}
