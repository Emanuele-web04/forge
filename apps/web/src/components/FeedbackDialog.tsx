// FILE: FeedbackDialog.tsx
// Purpose: Collects categorized Synara feedback with privacy-safe diagnostics.
// Layer: Shared UI component
// Depends on: Feedback delivery logic and the shared dialog primitives.

import { useEffect, useRef, useState } from "react";
import {
  buildFeedbackSubmission,
  FEEDBACK_CATEGORIES,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackThreadContext,
} from "../feedback";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

export interface FeedbackDialogProps {
  open: boolean;
  context: FeedbackThreadContext;
  initialCategory?: FeedbackCategory | null | undefined;
  onOpenChange: (open: boolean) => void;
  onDraftGithubIssue?: ((details: string) => Promise<void>) | undefined;
}

export function FeedbackDialog({
  open,
  context,
  initialCategory,
  onOpenChange,
  onDraftGithubIssue,
}: FeedbackDialogProps) {
  const [isSending, setIsSending] = useState(false);
  const [isDraftingIssue, setIsDraftingIssue] = useState(false);
  const isSendingRef = useRef(false);
  const isDraftingRef = useRef(false);

  const disabled = isSending || isDraftingIssue;

  const handleSubmit = async (category: FeedbackCategory | null, details: string) => {
    if (isSendingRef.current) {
      return;
    }
    isSendingRef.current = true;
    setIsSending(true);
    try {
      await submitFeedback(buildFeedbackSubmission({ category, details, context }));
      onOpenChange(false);
      toastManager.add({
        type: "success",
        title: "Feedback sent",
        description: "Thanks for helping make Synara better.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not send feedback",
        description:
          error instanceof Error ? error.message : "An unexpected delivery error occurred.",
      });
    } finally {
      setIsSending(false);
      isSendingRef.current = false;
    }
  };

  const handleDraftIssue = async (details: string) => {
    if (!onDraftGithubIssue || disabled || isDraftingRef.current) {
      return;
    }
    isDraftingRef.current = true;
    setIsDraftingIssue(true);
    try {
      await onDraftGithubIssue(details);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not draft a GitHub issue",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setIsDraftingIssue(false);
      isDraftingRef.current = false;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!disabled) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!disabled}>
        <DialogHeader className="gap-0 px-5 pt-5 pb-3">
          <DialogTitle className="text-xl tracking-[-0.01em]">Share feedback</DialogTitle>
        </DialogHeader>
        {/* The form state lives below DialogPopup, which unmounts its children
            once the close transition ends — every open starts from a blank
            form without a reset effect, and closing never flashes empty. */}
        <FeedbackDialogForm
          defaultDetails=""
          initialCategory={initialCategory}
          isSending={isSending}
          isDraftingIssue={isDraftingIssue}
          open={open}
          onSubmit={handleSubmit}
          onDraftGithubIssue={onDraftGithubIssue ? handleDraftIssue : undefined}
        />
      </DialogPopup>
    </Dialog>
  );
}

export interface FeedbackDialogFormProps {
  defaultDetails?: string;
  initialCategory?: FeedbackCategory | null | undefined;
  isSending: boolean;
  isDraftingIssue?: boolean;
  open?: boolean;
  onSubmit: (category: FeedbackCategory | null, details: string) => Promise<void>;
  onDraftGithubIssue?: ((details: string) => Promise<void>) | undefined;
}

export function FeedbackDialogForm({
  defaultDetails = "",
  initialCategory,
  isSending,
  isDraftingIssue = false,
  open = true,
  onSubmit,
  onDraftGithubIssue,
}: FeedbackDialogFormProps) {
  const [category, setCategory] = useState<FeedbackCategory | null>(initialCategory ?? null);
  const [details, setDetails] = useState(defaultDetails);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setCategory(initialCategory ?? null);
    setDetails(defaultDetails);
  }, [initialCategory, defaultDetails]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const disabled = isSending || isDraftingIssue;
  const canSubmit = details.trim().length > 0 && !disabled;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit(category, details);
  };

  const handleDraftIssue = async () => {
    if (!onDraftGithubIssue || disabled) return;
    await onDraftGithubIssue(details);
  };

  return (
    <form
      className="flex min-h-0 flex-col gap-3 px-5 pb-5"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div role="group" aria-label="Feedback category" className="flex flex-wrap gap-1.5">
        {FEEDBACK_CATEGORIES.map((option) => {
          const selected = category === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              variant={selected ? "secondary" : "outline"}
              size="sm"
              aria-pressed={selected}
              // Reference pills breathe at ~14px per side; the default `sm`
              // padding (10px) crams the label against the pill wall.
              className="rounded-full px-3.5 font-normal"
              disabled={disabled}
              // Keeps the caret (and the field's focus ring) in the details
              // textarea, so picking a category never interrupts typing.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setCategory(selected ? null : option.value)}
            >
              <span aria-hidden="true">{selected ? "−" : "+"}</span>
              {option.label}
            </Button>
          );
        })}
      </div>

      <Textarea
        ref={textareaRef}
        value={details}
        maxLength={5_000}
        placeholder="Share details (required)"
        aria-label="Feedback details"
        disabled={disabled}
        className="[&_[data-slot=textarea]]:min-h-32 [&_[data-slot=textarea]]:resize-y"
        onChange={(event) => setDetails(event.target.value)}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        Diagnostics include app version, OS, provider/model, modes, and session state — never
        prompts, messages, paths, or logs.
      </p>

      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {isSending ? (
          <>
            <Spinner />
            Sending…
          </>
        ) : (
          "Submit"
        )}
      </Button>

      {category === "bug" && onDraftGithubIssue && (
        <>
          <div className="border-t" />
          <p className="text-center text-xs text-muted-foreground">
            Opens a new thread. Your agent interviews you, then files the issue with your GitHub
            account — only after you confirm.
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={disabled}
            onClick={() => void handleDraftIssue()}
          >
            {isDraftingIssue ? (
              <>
                <Spinner />
                Opening thread…
              </>
            ) : (
              "Draft a GitHub issue with your agent"
            )}
          </Button>
        </>
      )}
    </form>
  );
}
