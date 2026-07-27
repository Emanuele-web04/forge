import type {
  PullRequestDetailInput,
  PullRequestReviewDraft,
  PullRequestReviewEvent,
} from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { GitPullRequestIcon, TriangleAlertIcon } from "~/lib/icons";
import { pullRequestReviewSubmitMutationOptions } from "~/lib/pullRequestReactQuery";

const REVIEW_EVENTS: ReadonlyArray<{
  value: PullRequestReviewEvent;
  label: string;
}> = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

export function PullRequestReviewSubmitBar(props: {
  target: PullRequestDetailInput;
  drafts: ReadonlyArray<PullRequestReviewDraft>;
  staleDrafts: ReadonlyArray<PullRequestReviewDraft>;
  loading: boolean;
  busy: boolean;
  onDeleteDraft: (draft: PullRequestReviewDraft) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(pullRequestReviewSubmitMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<PullRequestReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const result = mutation.data;
  const blockedIds = useMemo(
    () => new Set([...(result?.staleDraftIds ?? []), ...(result?.invalidDraftIds ?? [])]),
    [result],
  );
  const canSubmit =
    !props.loading &&
    props.staleDrafts.length === 0 &&
    (event !== "COMMENT" || body.trim().length > 0 || props.drafts.length > 0);

  const submit = () => {
    if (!canSubmit) return;
    mutation.mutate(
      {
        ...props.target,
        event,
        body: body.trim(),
        draftIds: props.drafts.map((draft) => draft.id),
      },
      {
        onSuccess: (next) => {
          if (next.status === "submitted") {
            setBody("");
            setOpen(false);
          }
        },
      },
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-background px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {props.staleDrafts.length > 0
          ? `${props.staleDrafts.length} stale review ${pluralize(props.staleDrafts.length, "comment")} must be removed or recreated.`
          : `${props.drafts.length} pending review ${pluralize(props.drafts.length, "comment")}`}
      </span>
      {props.staleDrafts.length > 0 ? (
        <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button size="sm" disabled={props.loading}>
              <GitPullRequestIcon className="size-3.5" />
              Review changes
            </Button>
          }
        />
        <PopoverPopup
          align="end"
          side="top"
          sideOffset={8}
          className="w-80 max-w-[calc(100vw-1rem)]"
        >
          <div className="space-y-3">
            <label className="block text-xs font-medium text-foreground">
              Decision
              <select
                value={event}
                disabled={mutation.isPending}
                onChange={(changeEvent) =>
                  setEvent(changeEvent.target.value as PullRequestReviewEvent)
                }
                className="mt-1.5 h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {REVIEW_EVENTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              aria-label="Review summary"
              value={body}
              disabled={mutation.isPending}
              placeholder="Optional review summary"
              onChange={(changeEvent) => setBody(changeEvent.target.value)}
              className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              {props.drafts.length} inline {pluralize(props.drafts.length, "comment")} will be
              included.
            </p>
            {props.staleDrafts.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[11px] text-warning">
                  Submission is blocked because the loaded patch no longer matches saved comments.
                </p>
                <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                  {props.staleDrafts.map((draft) => (
                    <li
                      key={draft.id}
                      className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/35 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium text-foreground">
                          {draft.path}:{draft.line}
                        </p>
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">
                          {draft.body}
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => props.onDeleteDraft(draft)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result?.status === "blocked" ? (
              <p className="text-[11px] text-destructive">
                GitHub received nothing. {blockedIds.size} {pluralize(blockedIds.size, "comment")}{" "}
                need action.
              </p>
            ) : null}
            {mutation.isError ? (
              <p className="text-[11px] text-destructive">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : "Could not submit the review."}
              </p>
            ) : null}
            <div className="flex justify-end gap-1.5">
              <PopoverClose
                render={
                  <Button size="xs" variant="ghost" disabled={mutation.isPending}>
                    Cancel
                  </Button>
                }
              />
              <Button
                size="xs"
                disabled={!canSubmit || mutation.isPending || props.busy}
                onClick={submit}
              >
                Submit review
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
