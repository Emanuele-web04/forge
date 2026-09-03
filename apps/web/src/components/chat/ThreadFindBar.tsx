// FILE: ThreadFindBar.tsx
// Purpose: Compact in-thread find panel floating at the top-right of the chat
//   column — field + close on top, prev/next + match count below.
// Layer: Chat transcript presentation
// Depends on: projected-message matching in threadFind.logic (not the DOM list).

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { type TimelineEntry } from "../../session-logic";
import {
  collectThreadFindDocuments,
  createThreadFindDocumentTextCache,
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
  onActiveMatchChange: (match: ThreadFindMatch | null) => void;
}

const FIND_QUERY_MAX_LENGTH = 200;

const FIND_STEP_BUTTON_CLASS_NAME =
  "size-6 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-6";

export function ThreadFindBar({
  open,
  focusNonce,
  timelineEntries,
  onClose,
  onJump,
  onHighlightChange,
  onActiveMatchChange,
}: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<ThreadFindMatch[]>([]);
  const activeIndexRef = useRef(0);
  const onJumpRef = useRef(onJump);
  const onHighlightChangeRef = useRef(onHighlightChange);
  const onActiveMatchChangeRef = useRef(onActiveMatchChange);
  onJumpRef.current = onJump;
  onHighlightChangeRef.current = onHighlightChange;
  onActiveMatchChangeRef.current = onActiveMatchChange;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [activeIndex, setActiveIndex] = useState(0);
  const [documentTextCache] = useState(createThreadFindDocumentTextCache);
  const documents = useMemo(
    () => (open ? collectThreadFindDocuments(timelineEntries, documentTextCache) : []),
    [documentTextCache, open, timelineEntries],
  );
  const matches = useMemo(
    () => findThreadMatches(documents, deferredQuery),
    [deferredQuery, documents],
  );
  matchesRef.current = matches;
  const matchCount = matches.length;
  const safeIndex = matchCount === 0 ? -1 : Math.min(Math.max(activeIndex, 0), matchCount - 1);
  const hasQuery = normalizeFindQuery(deferredQuery).length > 0;

  useEffect(() => {
    if (!open) {
      onHighlightChangeRef.current(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const currentIndex =
      matches.length === 0 ? -1 : Math.min(Math.max(activeIndexRef.current, 0), matches.length - 1);
    onHighlightChangeRef.current({
      query: deferredQuery,
      activeMatch: resolveThreadFindJump(matches, currentIndex),
    });
  }, [deferredQuery, matches, open]);

  // Query changes jump after their deferred match pass. Streaming transcript
  // rewrites only refresh matches and never yank the viewport mid-read.
  useEffect(() => {
    if (!open) {
      return;
    }
    const currentMatches = matchesRef.current;
    const currentIndex =
      currentMatches.length === 0
        ? -1
        : Math.min(Math.max(activeIndexRef.current, 0), currentMatches.length - 1);
    const match = currentMatches[currentIndex];
    onActiveMatchChangeRef.current(match ?? null);
    if (match) {
      onJumpRef.current(match);
    }
  }, [deferredQuery, open]);

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
        activeIndexRef.current = 0;
        setActiveIndex(0);
      }
    }
    input.focus();
    input.select();
  }, [focusNonce, open]);

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    activeIndexRef.current = 0;
    setActiveIndex(0);
  };

  const handleStep = (direction: "next" | "previous") => {
    if (deferredQuery !== query || matchCount === 0) {
      return;
    }
    const nextIndex = stepThreadFindIndex(matchCount, safeIndex, direction);
    const match = resolveThreadFindJump(matches, nextIndex);
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
    onActiveMatchChangeRef.current(match);
    if (match) {
      onJumpRef.current(match);
    }
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

  // The results row only exists while a query is typed, so the empty field is a
  // clean pill; visibility keys off the synchronous query so the row expands on
  // the first keystroke rather than after the deferred match pass.
  const resultsRowVisible = query.trim().length > 0;

  return (
    <div
      role="search"
      data-testid="thread-find-bar"
      data-thread-find-layout="panel"
      className="flex w-80 max-w-[calc(100vw-2rem)] flex-col rounded-3xl border border-border/60 bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
    >
      <div className="flex items-center gap-2.5 px-4">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search chat..."
          aria-label="Find in thread"
          autoComplete="off"
          spellCheck={false}
          // The unlayered utility overrides the global `input { font-family: mono }`
          // reset — find is a UI field, not a code field.
          className="font-system-ui h-11 min-w-0 flex-1 bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <div aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
        <IconButton
          onClick={onClose}
          className={FIND_STEP_BUTTON_CLASS_NAME}
          label="Close find (Esc)"
        >
          <XIcon className="size-4" />
        </IconButton>
      </div>
      <DisclosureRegion open={resultsRowVisible}>
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              onClick={() => handleStep("previous")}
              disabled={matchCount === 0}
              className={FIND_STEP_BUTTON_CLASS_NAME}
              label="Previous match (Shift+Enter)"
            >
              <ArrowUpIcon className="size-4" />
            </IconButton>
            <IconButton
              onClick={() => handleStep("next")}
              disabled={matchCount === 0}
              className={FIND_STEP_BUTTON_CLASS_NAME}
              label="Next match (Enter)"
            >
              <ArrowDownIcon className="size-4" />
            </IconButton>
          </div>
          <span
            className={cn(
              "min-w-0 truncate pr-1 text-right text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums",
              MUTED_LABEL_TEXT_CLASS_NAME,
            )}
            aria-live="polite"
          >
            {hasQuery
              ? matchCount === 0
                ? "No results"
                : `${safeIndex + 1} / ${matchCount} results`
              : ""}
          </span>
        </div>
      </DisclosureRegion>
    </div>
  );
}

export function ChatThreadFindHost({
  open,
  focusNonce,
  timelineEntries,
  threadId,
  className,
  onClose,
  onJump,
  onHighlightChange,
  onActiveMatchChange,
}: ThreadFindBarProps & {
  threadId: string;
  className?: string;
}) {
  return (
    // Mounted at the chat pane root so the panel overlays the header and the
    // docked Environment overlay (z-20) alike, pinned to the top-right corner.
    <div
      data-thread-find-host="true"
      className={cn("pointer-events-none absolute right-0 top-0 z-40", className)}
    >
      {/* Content padding keeps the panel shadow inside the disclosure clip box
          and keeps the card off the pane borders. */}
      <DisclosureRegion open={open} contentClassName="pointer-events-auto p-3">
        <ThreadFindBar
          key={threadId}
          open={open}
          focusNonce={focusNonce}
          timelineEntries={timelineEntries}
          onClose={onClose}
          onJump={onJump}
          onHighlightChange={onHighlightChange}
          onActiveMatchChange={onActiveMatchChange}
        />
      </DisclosureRegion>
    </div>
  );
}
