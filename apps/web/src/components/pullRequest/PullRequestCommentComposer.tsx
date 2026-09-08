// FILE: PullRequestCommentComposer.tsx
// Purpose: Inline "Leave a comment" pill at the bottom of the detail panel's Comments section.
//          Posts an issue comment through the gh-backed comment RPC as the authenticated GitHub
//          user (hence the GitHub glyph in the leading slot), then invalidates the detail query
//          so the new comment appears on the next refetch. Enter submits; Shift+Enter breaks a
//          line (comments accept markdown). Successful or ambiguous submissions revalidate both
//          the detail and repository list scopes so comment data and updated ordering converge.
// Layer: Pull request presentation
// Exports: PullRequestCommentComposer

import type { PullRequestDetail } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { ArrowUpIcon, GitHubIcon } from "~/lib/icons";
import { pullRequestCommentMutationOptions } from "~/lib/pullRequestReactQuery";
import { PR_BODY_TEXT_CLASS_NAME } from "./pullRequestText";
import { cn } from "~/lib/utils";

export function PullRequestCommentComposer({ detail }: { detail: PullRequestDetail }) {
  const queryClient = useQueryClient();
  const mutation = useMutation(pullRequestCommentMutationOptions(queryClient));
  const [body, setBody] = useState("");
  // Synchronous re-entrancy lock: mutation.isPending updates on React's schedule, which is
  // too late to stop a rapid double Enter from posting the comment twice.
  const submittingRef = useRef(false);
  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !mutation.isPending;

  // Promise chain instead of async/try-catch-finally: React Compiler does not
  // yet support try/finally, and it would skip optimizing this whole component.
  const submit = () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    void mutation
      .mutateAsync({
        projectId: detail.projectId,
        provider: detail.provider,
        repository: detail.repository,
        number: detail.number,
        body: trimmed,
      })
      .then(() => {
        setBody("");
      })
      .catch((error: unknown) => {
        // The draft stays in the field on failure — nothing to re-type.
        toastManager.add({
          type: "error",
          title: "Could not post comment",
          description: error instanceof Error ? error.message : "GitHub CLI comment failed.",
        });
      })
      .finally(() => {
        submittingRef.current = false;
      });
  };

  return (
    <div className="flex items-center gap-2 rounded-3xl border border-border/60 bg-background py-1 pl-3 pr-1.5 shadow-sm">
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-muted-foreground"
        title="Commenting as your GitHub account"
      >
        <GitHubIcon className="size-3" />
      </span>
      <textarea
        rows={Math.min(6, body.split("\n").length)}
        value={body}
        disabled={mutation.isPending}
        placeholder="Leave a comment"
        aria-label="Leave a comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // Enter during IME composition confirms the composition, not the comment.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        // font-system-ui overrides the global `textarea { font-family: mono }` reset — this is
        // UI chrome, not code, exactly like the chat composer's editor.
        className={cn(
          PR_BODY_TEXT_CLASS_NAME,
          "font-system-ui min-w-0 flex-1 resize-none bg-transparent py-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-60",
        )}
      />
      <button
        type="button"
        disabled={!canSubmit}
        aria-label="Post comment"
        title="Post comment"
        onClick={() => void submit()}
        className="flex size-7 shrink-0 items-center justify-center self-end rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-35"
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </div>
  );
}
