// FILE: ThreadFindBar.tsx
// Purpose: Dedicated in-thread find bar — match count, prev/next, and Esc to close.
// Layer: Chat transcript presentation
// Depends on: projected-message matching in threadFind.logic (not the DOM list).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { type TimelineEntry } from "../../session-logic";
import {
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./composerPickerStyles";
import {
  collectThreadFindDocuments,
  findThreadMatches,
  normalizeFindQuery,
  resolveThreadFindJump,
  stepThreadFindIndex,
  type ThreadFindHighlight,
  type ThreadFindMatch,
} from "./threadFind.logic";

interface ThreadFindBarProps {
  open: boolean;
  focusNonce: number;
  timelineEntries: readonly TimelineEntry[];
  onClose: () => void;
  onJump: (match: ThreadFindMatch) => void;
  onHighlightChange: (highlight: ThreadFindHighlight | null) => void;
}

const FIND_QUERY_MAX_LENGTH = 200;

export function ThreadFindBar({
  open,
  focusNonce,
  timelineEntries,
  onClose,
  onJump,
  onHighlightChange,
}: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<ThreadFindMatch[]>([]);
  const onJumpRef = useRef(onJump);
  const onHighlightChangeRef = useRef(onHighlightChange);
  onJumpRef.current = onJump;
  onHighlightChangeRef.current = onHighlightChange;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const documents = useMemo(
    () => (open ? collectThreadFindDocuments(timelineEntries) : []),
    [open, timelineEntries],
  );
  const matches = useMemo(() => findThreadMatches(documents, query), [documents, query]);
  matchesRef.current = matches;
  const matchCount = matches.length;
  const safeIndex = matchCount === 0 ? -1 : Math.min(Math.max(activeIndex, 0), matchCount - 1);
  const hasQuery = normalizeFindQuery(query).length > 0;

  useEffect(() => {
    if (!open) {
      onHighlightChangeRef.current(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    onHighlightChangeRef.current({
      query,
      activeMatch: resolveThreadFindJump(matches, safeIndex),
    });
  }, [matches, open, query, safeIndex]);

  // Jump only when the user changes the query or steps matches — not on every
  // streaming transcript rewrite, which would yank the viewport mid-read.
  useEffect(() => {
    if (!open || safeIndex < 0) {
      return;
    }
    const match = matchesRef.current[safeIndex];
    if (match) {
      onJumpRef.current(match);
    }
  }, [open, query, safeIndex]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (document.activeElement !== input && input.value.trim().length === 0) {
      const selected = window.getSelection()?.toString().trim() ?? "";
      if (selected.length > 0) {
        setQuery(selected.slice(0, FIND_QUERY_MAX_LENGTH));
        setActiveIndex(0);
      }
    }
    input.focus();
    input.select();
  }, [focusNonce, open]);

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    setActiveIndex(0);
  };

  const handleStep = (direction: "next" | "previous") => {
    if (matchCount === 0) {
      return;
    }
    setActiveIndex((current) => stepThreadFindIndex(matchCount, current, direction));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      handleStep(event.shiftKey ? "previous" : "next");
    }
  };

  return (
    <div
      role="search"
      data-testid="thread-find-bar"
      data-thread-find-layout="bar"
      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-[var(--color-background-elevated-primary-opaque)] px-2.5 py-1.5 shadow-sm"
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in thread"
        aria-label="Find in thread"
        autoComplete="off"
        spellCheck={false}
        className="h-8 min-w-0 flex-1 bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <span
        className={cn(
          "min-w-16 shrink-0 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
        aria-live="polite"
      >
        {hasQuery ? (matchCount === 0 ? "No results" : `${safeIndex + 1} / ${matchCount}`) : ""}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          onClick={() => handleStep("previous")}
          disabled={matchCount === 0}
          className="size-7 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-7"
          label="Previous match (Shift+Enter)"
        >
          <ChevronUpIcon className="size-4" />
        </IconButton>
        <IconButton
          onClick={() => handleStep("next")}
          disabled={matchCount === 0}
          className="size-7 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-7"
          label="Next match (Enter)"
        >
          <ChevronDownIcon className="size-4" />
        </IconButton>
        <IconButton
          onClick={onClose}
          className="size-7 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-7"
          label="Close find (Esc)"
        >
          <XIcon className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

export function ChatThreadFindHost({
  open,
  focusNonce,
  timelineEntries,
  threadId,
  contentInsetRightPx,
  onClose,
  onJump,
  onHighlightChange,
}: ThreadFindBarProps & {
  threadId: string;
  contentInsetRightPx?: number;
}) {
  return (
    <DisclosureRegion open={open} className="shrink-0">
      <div
        data-thread-find-host="true"
        className={cn(
          "border-b border-border bg-[var(--color-background-elevated-primary-opaque)]",
          CHAT_COLUMN_GUTTER_CLASS_NAME,
          ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
        )}
        style={contentInsetRightPx ? { paddingRight: contentInsetRightPx } : undefined}
      >
        <div className="w-full min-w-0 py-2">
          <ThreadFindBar
            key={threadId}
            open={open}
            focusNonce={focusNonce}
            timelineEntries={timelineEntries}
            onClose={onClose}
            onJump={onJump}
            onHighlightChange={onHighlightChange}
          />
        </div>
      </div>
    </DisclosureRegion>
  );
}
