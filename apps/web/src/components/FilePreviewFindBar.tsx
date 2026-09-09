// FILE: FilePreviewFindBar.tsx
// Purpose: Compact in-file-preview find panel — field + close on top, prev/next
//   + match count below. Mirrors ThreadFindBar layout for a consistent find UX.
// Layer: File preview presentation

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import {
  FILE_PREVIEW_FIND_MAX_MATCHES,
  FILE_PREVIEW_FIND_QUERY_MAX_LENGTH,
  anchorFilePreviewMatchIndex,
  collectFilePreviewMatches,
  filePreviewMatchCountLabel,
  stepFilePreviewFindIndex,
  type FilePreviewFindMatch,
} from "./filePreviewFind.logic";

interface FilePreviewFindBarProps {
  open: boolean;
  focusNonce: number;
  contents: string;
  onClose: () => void;
  onMatchesChange: (
    matches: readonly FilePreviewFindMatch[],
    query: string,
    activeIndex: number,
  ) => void;
  onActiveMatchChange: (
    match: FilePreviewFindMatch | null,
    query: string,
    activeIndex: number,
  ) => void;
}

const FIND_STEP_BUTTON_CLASS_NAME =
  "size-6 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted-foreground/15 hover:text-foreground sm:size-6";

export function FilePreviewFindBar({
  open,
  focusNonce,
  contents,
  onClose,
  onMatchesChange,
  onActiveMatchChange,
}: FilePreviewFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<FilePreviewFindMatch[]>([]);
  const activeIndexRef = useRef(0);
  const previousMatchRef = useRef<FilePreviewFindMatch | null>(null);
  const contentsEpochRef = useRef(contents);
  const onMatchesChangeRef = useRef(onMatchesChange);
  const onActiveMatchChangeRef = useRef(onActiveMatchChange);
  onMatchesChangeRef.current = onMatchesChange;
  onActiveMatchChangeRef.current = onActiveMatchChange;

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [activeIndex, setActiveIndex] = useState(0);

  const matchPass = useMemo(() => {
    if (!open) {
      return { matches: [] as FilePreviewFindMatch[], capped: false };
    }
    const all = collectFilePreviewMatches(
      contents,
      deferredQuery,
      FILE_PREVIEW_FIND_MAX_MATCHES + 1,
    );
    const capped = all.length > FILE_PREVIEW_FIND_MAX_MATCHES;
    return {
      matches: capped ? all.slice(0, FILE_PREVIEW_FIND_MAX_MATCHES) : all,
      capped,
    };
  }, [contents, deferredQuery, open]);

  const matches = matchPass.matches;
  matchesRef.current = matches;
  const matchCount = matches.length;
  const safeIndex = matchCount === 0 ? -1 : Math.min(Math.max(activeIndex, 0), matchCount - 1);

  // Live reload: re-anchor the active hit by offset instead of yanking to zero.
  useEffect(() => {
    if (!open) {
      return;
    }
    const contentsChanged = contentsEpochRef.current !== contents;
    contentsEpochRef.current = contents;
    if (!contentsChanged) {
      return;
    }
    const nextIndex = anchorFilePreviewMatchIndex(matches, previousMatchRef.current);
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex < 0 ? 0 : nextIndex);
  }, [contents, matches, open]);

  useEffect(() => {
    if (!open) {
      onMatchesChangeRef.current([], "", -1);
      onActiveMatchChangeRef.current(null, "", -1);
      previousMatchRef.current = null;
      return;
    }
    const currentIndex =
      matches.length === 0 ? -1 : Math.min(Math.max(activeIndexRef.current, 0), matches.length - 1);
    const match = currentIndex >= 0 ? (matches[currentIndex] ?? null) : null;
    previousMatchRef.current = match;
    onMatchesChangeRef.current(matches, deferredQuery, currentIndex);
    onActiveMatchChangeRef.current(match, deferredQuery, currentIndex);
  }, [deferredQuery, matches, open]);

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
        setQuery(selected.slice(0, FILE_PREVIEW_FIND_QUERY_MAX_LENGTH));
        activeIndexRef.current = 0;
        setActiveIndex(0);
      }
    }
    input.focus();
    input.select();
  }, [focusNonce, open]);

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery.slice(0, FILE_PREVIEW_FIND_QUERY_MAX_LENGTH));
    activeIndexRef.current = 0;
    setActiveIndex(0);
  };

  const handleStep = (direction: "next" | "previous") => {
    if (deferredQuery !== query || matchCount === 0) {
      return;
    }
    const nextIndex = stepFilePreviewFindIndex(matchCount, safeIndex, direction);
    const match = matches[nextIndex] ?? null;
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
    previousMatchRef.current = match;
    onActiveMatchChangeRef.current(match, deferredQuery, nextIndex);
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

  const resultsRowVisible = query.trim().length > 0;

  return (
    <div
      role="search"
      data-testid="file-preview-find-bar"
      data-file-preview-find-layout="panel"
      className="flex w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-3xl border border-border/60 bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
    >
      <div className="flex items-center gap-2.5 px-4">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in file..."
          aria-label="Find in file"
          autoComplete="off"
          spellCheck={false}
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
            {filePreviewMatchCountLabel({
              query: deferredQuery,
              matchCount,
              activeIndex: safeIndex,
              capped: matchPass.capped,
            })}
          </span>
        </div>
      </DisclosureRegion>
    </div>
  );
}

export function FilePreviewFindHost({
  open,
  focusNonce,
  contents,
  className,
  onClose,
  onMatchesChange,
  onActiveMatchChange,
}: FilePreviewFindBarProps & { className?: string }) {
  return (
    <div
      data-file-preview-find-host="true"
      className={cn("pointer-events-none absolute right-0 top-0 z-40", className)}
    >
      <DisclosureRegion open={open} contentClassName="pointer-events-auto p-3">
        <FilePreviewFindBar
          open={open}
          focusNonce={focusNonce}
          contents={contents}
          onClose={onClose}
          onMatchesChange={onMatchesChange}
          onActiveMatchChange={onActiveMatchChange}
        />
      </DisclosureRegion>
    </div>
  );
}
