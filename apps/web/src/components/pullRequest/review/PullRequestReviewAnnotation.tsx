import type { PullRequestReviewDraft } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { CheckIcon, MessageCircleIcon, Trash2 } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { PullRequestReviewAnchor, PullRequestReviewAnnotationData } from "./reviewAnnotations";

const ANNOTATION_SHELL =
  "mx-2 my-1 overflow-hidden rounded-lg border border-border/60 bg-card text-foreground shadow-xs";

function CommentEditor(props: {
  initialBody?: string;
  busy: boolean;
  saveLabel: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(props.initialBody ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = body.trim();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className={cn(ANNOTATION_SHELL, "p-2.5")}>
      <textarea
        ref={textareaRef}
        aria-label="Inline review comment"
        value={body}
        disabled={props.busy}
        placeholder="Leave a review comment…"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onCancel();
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && trimmed) {
            event.preventDefault();
            props.onSave(trimmed);
          }
        }}
        className="min-h-24 w-full resize-y rounded-md border border-border/60 bg-background px-3 py-2 text-[13px] leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={props.busy || !trimmed} onClick={() => props.onSave(trimmed)}>
          {props.saveLabel}
        </Button>
      </div>
    </div>
  );
}

function SavedDraft(props: {
  draft: PullRequestReviewDraft;
  busy: boolean;
  onUpdate: (draft: PullRequestReviewDraft, body: string) => void;
  onDelete: (draft: PullRequestReviewDraft) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentEditor
        initialBody={props.draft.body}
        busy={props.busy}
        saveLabel="Update"
        onCancel={() => setEditing(false)}
        onSave={(body) => {
          props.onUpdate(props.draft, body);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className={ANNOTATION_SHELL}>
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <MessageCircleIcon className="size-3.5" />
        <span className="font-medium uppercase tracking-wide">Pending review</span>
        <div className="ms-auto flex gap-1">
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Delete review comment"
            disabled={props.busy}
            className="hover:text-destructive"
            onClick={() => props.onDelete(props.draft)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words px-3 py-2.5 text-[13px] leading-5">
        {props.draft.body}
      </p>
    </div>
  );
}

export function PullRequestReviewAnnotation(props: {
  data: PullRequestReviewAnnotationData;
  busy: boolean;
  onCreate: (anchor: PullRequestReviewAnchor, body: string) => void;
  onCancelCreate: () => void;
  onUpdate: (draft: PullRequestReviewDraft, body: string) => void;
  onDelete: (draft: PullRequestReviewDraft) => void;
}) {
  if (props.data.kind === "new-draft") {
    const anchor = props.data.anchor;
    return (
      <CommentEditor
        busy={props.busy}
        saveLabel="Add comment"
        onCancel={props.onCancelCreate}
        onSave={(body) => props.onCreate(anchor, body)}
      />
    );
  }

  if (props.data.kind === "draft") {
    return (
      <SavedDraft
        draft={props.data.draft}
        busy={props.busy}
        onUpdate={props.onUpdate}
        onDelete={props.onDelete}
      />
    );
  }

  const thread = props.data.thread;
  return (
    <div className={cn(ANNOTATION_SHELL, thread.isResolved && "opacity-70")}>
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <CheckIcon className="size-3" />
        <span className="font-medium uppercase tracking-wide">GitHub review</span>
        {thread.isResolved ? <span className="ms-auto text-success">Resolved</span> : null}
      </div>
      <div className="divide-y divide-border/40">
        {thread.comments.map((comment) => (
          <div key={comment.id} className="px-3 py-2.5">
            <div className="text-[11px] font-medium text-muted-foreground">
              {comment.author?.login ?? "Unknown reviewer"}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5">
              {comment.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
