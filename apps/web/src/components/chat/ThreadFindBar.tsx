// FILE: ThreadFindBar.tsx
// Purpose: In-thread find field — match count, prev/next, and Esc to close.
// Layer: Chat transcript presentation
// Depends on: projected-message matching in threadFind.logic (not the DOM list).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type TimelineEntry } from "../../session-logic";
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
  const documents = useMemo(() => collectThreadFindDocuments(timelineEntries), [timelineEntries]);
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
      className="flex max-w-[calc(100%-0.5rem)] items-center rounded-md bg-popover/95 pl-2 pr-0.5 shadow-lg ring-1 ring-border/40 backdrop-blur"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label="Find in thread"
        autoComplete="off"
        spellCheck={false}
        className="h-7 w-36 min-w-0 flex-shrink bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      <span
        className={cn(
          "whitespace-nowrap px-1.5 text-[11px] tabular-nums text-muted-foreground",
          hasQuery && matchCount === 0 ? "text-muted-foreground" : "",
        )}
        aria-live="polite"
      >
        {hasQuery ? (matchCount === 0 ? "No results" : `${safeIndex + 1}/${matchCount}`) : ""}
      </span>
      <div className="flex shrink-0 items-center">
        <IconButton
          onClick={() => handleStep("previous")}
          disabled={matchCount === 0}
          className="size-6 rounded-sm border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/20 hover:text-foreground sm:size-6"
          label="Previous match (Shift+Enter)"
        >
          <ChevronUpIcon className="size-3.5" />
        </IconButton>
        <IconButton
          onClick={() => handleStep("next")}
          disabled={matchCount === 0}
          className="size-6 rounded-sm border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/20 hover:text-foreground sm:size-6"
          label="Next match (Enter)"
        >
          <ChevronDownIcon className="size-3.5" />
        </IconButton>
        <IconButton
          onClick={onClose}
          className="size-6 rounded-sm border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/20 hover:text-foreground sm:size-6"
          label="Close find (Esc)"
        >
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
