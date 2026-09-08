import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";

import type { TimestampFormat } from "~/appSettings";
import { gitBlameLineQueryOptions } from "~/lib/gitReactQuery";
import { CopyIcon, MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { formatShortDateTimestamp } from "~/timestampFormat";
import { resolveTranscriptSelectionActionLayout } from "./chat/chatSelectionActions";
import type { DiffLineClickProps } from "./chat/FileDiffView";
import type { DiffEditBaseRev } from "~/lib/diffEditBaseRev";

const BLAME_POPOVER_WIDTH_PX = 288;
const BLAME_POPOVER_HEIGHT_PX = 116;

export interface DiffLineBlameTarget {
  filePath: string;
  line: number;
  /** Deleted lines live in the diff's base tree; everything else is the working tree. */
  side: "base" | "workingTree";
  left: number;
  top: number;
}

function resolveBlameBaseInput(base: DiffEditBaseRev): { rev: string } | { base: "branch" } | {} {
  if ("rev" in base) {
    return { rev: base.rev };
  }
  // Blame cannot read the index; index-backed scopes never enable it.
  return base.base === "branch" ? { base: "branch" } : {};
}

function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed;
}

export function resolveDiffLineBlameTarget(
  filePath: string,
  line: DiffLineClickProps,
): DiffLineBlameTarget | null {
  if (!Number.isFinite(line.lineNumber) || line.lineNumber < 1) {
    return null;
  }
  if (hasActiveTextSelection()) {
    return null;
  }
  const lineRect = line.lineElement.getBoundingClientRect();
  const layout = resolveTranscriptSelectionActionLayout({
    selectionRect: new DOMRect(line.event.clientX, lineRect.top, 0, lineRect.height),
    pointer: { x: line.event.clientX, y: line.event.clientY },
    size: { width: BLAME_POPOVER_WIDTH_PX, height: BLAME_POPOVER_HEIGHT_PX },
  });
  return {
    filePath,
    line: line.lineNumber,
    side: line.lineType === "change-deletion" ? "base" : "workingTree",
    left: layout.left,
    top: layout.top,
  };
}

function BlameActionButton(props: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground",
        ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME,
      )}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

export function DiffLineBlamePopover(props: {
  target: DiffLineBlameTarget;
  cwd: string | null;
  /** The diff's base revision, used to blame deleted lines where they still exist. */
  base: DiffEditBaseRev;
  timestampFormat: TimestampFormat;
  onReferenceInChat: ((target: DiffLineBlameTarget) => void) | undefined;
  onClose: () => void;
}) {
  const { onClose } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blameQuery = useQuery(
    gitBlameLineQueryOptions({
      cwd: props.cwd,
      filePath: props.target.filePath,
      line: props.target.line,
      ...(props.target.side === "base" ? resolveBlameBaseInput(props.base) : {}),
    }),
  );

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const blame = props.cwd === null ? undefined : blameQuery.data;
  const isLoadingBlame = props.cwd !== null && blameQuery.isPending;
  const referenceInChat = props.onReferenceInChat;
  const handleReferenceInChat = referenceInChat
    ? () => {
        referenceInChat(props.target);
        onClose();
      }
    : undefined;

  return (
    <div
      ref={containerRef}
      data-diff-line-blame="true"
      role="dialog"
      aria-label={`Blame for line ${props.target.line}`}
      className="fixed z-50 flex flex-col gap-1.5 rounded-md border border-border bg-[var(--color-background-elevated-primary-opaque)] p-2 shadow-xl backdrop-blur-xl"
      style={{ left: props.target.left, top: props.target.top, width: BLAME_POPOVER_WIDTH_PX }}
    >
      {isLoadingBlame ? (
        <p className="text-[11px] text-muted-foreground">Loading blame...</p>
      ) : !blame ? (
        <p className="text-[11px] text-muted-foreground">Blame unavailable</p>
      ) : blame.uncommitted ? (
        <p className="text-[12px] text-foreground">Not committed yet</p>
      ) : (
        <>
          <p className="line-clamp-2 text-[12px] leading-snug text-foreground">{blame.summary}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{blame.author}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{blame.shortSha}</span>
          </p>
          {blame.authorTime.length > 0 ? (
            <p className="text-[11px] text-muted-foreground/75">
              {formatShortDateTimestamp(blame.authorTime, props.timestampFormat)}
            </p>
          ) : null}
        </>
      )}
      {handleReferenceInChat || (blame && !blame.uncommitted) ? (
        <div className="flex items-center gap-1 border-t border-border/60 pt-1.5">
          {blame && !blame.uncommitted ? (
            <BlameActionButton
              label="Copy sha"
              icon={<CopyIcon className="size-3.5 shrink-0" />}
              onClick={() => {
                void navigator.clipboard?.writeText(blame.sha);
                onClose();
              }}
            />
          ) : null}
          {handleReferenceInChat ? (
            <BlameActionButton
              label="Reference line in chat"
              icon={<MessageCircleIcon className="size-3.5 shrink-0" />}
              onClick={handleReferenceInChat}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
