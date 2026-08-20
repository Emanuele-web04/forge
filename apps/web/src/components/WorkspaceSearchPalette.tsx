// FILE: WorkspaceSearchPalette.tsx
// Purpose: Minimal command-style palette for searching the current project's
//          files/directories by name and its contents (grep-style snippets).
//          Deliberately compact: a bare 44px input row, 28px result rows, 13px
//          type, and a single 14px column inset shared by input, label, icons.
// Layer: Web UI components
//
// Structure: the exported component is a thin dialog shell; all query state
// lives in the inner content component mounted INSIDE the popup, so Base UI
// unmounting it after the 200ms exit transition resets state for free (no
// reset-on-close effect, no row teardown while the popup is fading out).
// Result rows are memoized and receive only stable props, so a keystroke
// re-render bails out at the row boundary.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import type { ProjectContentMatch, ProjectEntry } from "@synara/contracts";
import { PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH } from "@synara/contracts";
import { normalizeWorkspaceEntrySearchQuery } from "@synara/shared/searchQuery";

import {
  prewarmProjectSearchIndex,
  projectSearchContentQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import { buildMatchSegments } from "~/lib/matchHighlight";
import { cn } from "~/lib/utils";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandStatus,
} from "./ui/command";
import { FileEntryIcon } from "./chat/FileEntryIcon";

export type WorkspaceSearchPaletteMode = "files" | "snippets";

const SEARCH_DEBOUNCE_MS = 100;
// ~17 rows are visible at the list's max height; 30 keeps keyboard depth
// without paying mount/layout for rows nobody scrolls to.
const SEARCH_LIMIT = 30;
const SEARCH_STALE_TIME_MS = 10_000;

// Stock dialog surface minus its hairline border and the 1px inner top
// highlight — the palette reads as one clean slab. Only the width deviates
// from other dialogs.
const POPUP_CLASS = "max-w-lg border-transparent before:shadow-none dark:before:shadow-none";

// Bare Base UI input: no Input-component chrome, min-heights, or wrapper
// paddings to fight — the h-11 row IS the header. `font-system-ui` counters
// the global `input { font-family: mono }` rule.
const INPUT_CLASS =
  "font-system-ui h-11 w-full min-w-0 bg-transparent px-3.5 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-200 dark:placeholder:text-zinc-500";

// The list keeps AutocompleteList's built-in 4px frame; combined with the 10px
// paddings below, every piece of text lands on the same 14px column.
const LIST_CLASS = "max-h-[min(30rem,60vh)]";

const GROUP_LABEL_CLASS =
  "px-2.5 pt-1.5 pb-1 font-normal text-[11px] text-zinc-400 dark:text-zinc-500";

// Row text sizes live on the inner spans (the item base carries a sm:text-sm
// that would win over an item-level override).
const ITEM_CLASS =
  "cursor-pointer gap-2 rounded-lg px-2.5 py-1 text-zinc-800 data-highlighted:bg-zinc-500/8 data-highlighted:text-zinc-900 dark:text-zinc-200 dark:data-highlighted:bg-zinc-400/10 dark:data-highlighted:text-zinc-100";

const ICON_CLASS = "size-3.5 text-zinc-500 dark:text-zinc-400";

const MUTED_TEXT_CLASS = "text-zinc-400 dark:text-zinc-500";

// Stable empty results: keeps the entries identity (and everything memoized
// from it) unchanged across renders while a mode has no data.
const EMPTY_FILE_ENTRIES: readonly ProjectEntry[] = [];
const EMPTY_SNIPPET_MATCHES: readonly ProjectContentMatch[] = [];

const MODE_COPY: Record<
  WorkspaceSearchPaletteMode,
  {
    groupLabel: string;
    placeholder: string;
    prompt: string;
    noResults: string;
    error: string;
  }
> = {
  files: {
    groupLabel: "Files",
    placeholder: "Search files",
    prompt: "Type to search for files",
    noResults: "No matching files",
    error: "File search failed. Try again.",
  },
  snippets: {
    groupLabel: "Matches",
    placeholder: "Search code",
    prompt: `Type at least ${PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH} characters to search code`,
    noResults: "No matches",
    error: "Code search failed. Try again.",
  },
};

interface WorkspaceSearchPaletteProps {
  open: boolean;
  mode: WorkspaceSearchPaletteMode;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  onOpenFile: (relativePath: string) => void;
  /** Directory results open in the right-dock explorer, revealed in its tree. */
  onOpenDirectory: (relativePath: string) => void;
}

function splitPath(path: string): { base: string; dir: string } {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex === -1) return { base: path, dir: "" };
  return { base: path.slice(separatorIndex + 1), dir: path.slice(0, separatorIndex) };
}

// Minimal match emphasis: the matched characters read in the foreground color
// while the rest of the text stays muted — including fuzzy subsequence hits,
// where the matched runs are non-contiguous. When the query doesn't occur in
// the text (e.g. it matched the directory instead), the whole text stays
// readable instead of dimming.
function FileNameText(props: { text: string; query: string }) {
  const segments = buildMatchSegments(props.text, props.query);
  if (!segments) {
    return <span className="text-zinc-700 dark:text-zinc-300">{props.text}</span>;
  }
  return (
    <span className={MUTED_TEXT_CLASS}>
      {segments.map((segment) =>
        segment.matched ? (
          <span className="font-medium text-zinc-900 dark:text-zinc-50" key={segment.start}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </span>
  );
}

function SnippetLineText(props: { text: string; query: string }) {
  const segments = buildMatchSegments(props.text, props.query);
  if (!segments) return <>{props.text}</>;
  return (
    <>
      {segments.map((segment) =>
        segment.matched ? (
          <span className="font-medium text-zinc-700 dark:text-zinc-200" key={segment.start}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

// Parent directory, clipped at the head rather than the tail: the deepest
// folder is what disambiguates two identically named files, so long paths read
// as `…/public/central-icons-reversed` instead of `apps/web/public/central-…`.
// The RTL container moves the ellipsis to the start while the `bdi` keeps the
// path itself laid out left to right.
function DirectoryText(props: { dir: string; className?: string }) {
  return (
    <span
      className={cn("truncate text-start text-[12px]", MUTED_TEXT_CLASS, props.className)}
      dir="rtl"
      title={props.dir}
    >
      <bdi dir="ltr">{props.dir}</bdi>
    </span>
  );
}

// Memoized rows: every prop is referentially stable across keystrokes (entries
// come from react-query's cache, query is a string, handlers are useCallback'd
// upstream), so intermediate renders bail out here. Base UI's ComboboxItem
// already prevents mousedown default (focus stays on the input) — no custom
// handler needed. Semantic keys are supplied by the caller; the explicit
// `index` prop lets Base UI skip DOM-position sorting of the composite list.

const FileResultRow = memo(function FileResultRow(props: {
  entry: ProjectEntry;
  index: number;
  highlightQuery: string;
  onOpenFile: (relativePath: string) => void;
  onOpenDirectory: (relativePath: string) => void;
}) {
  const { base, dir } = splitPath(props.entry.path);
  return (
    <CommandItem
      index={props.index}
      value={`${props.entry.kind}:${props.entry.path}`}
      className={`items-center ${ITEM_CLASS}`}
      onClick={() =>
        props.entry.kind === "directory"
          ? props.onOpenDirectory(props.entry.path)
          : props.onOpenFile(props.entry.path)
      }
    >
      <FileEntryIcon
        pathValue={props.entry.path}
        kind={props.entry.kind}
        colorMode="inherit"
        className={ICON_CLASS}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <FileNameText text={base} query={props.highlightQuery} />
      </span>
      {dir ? <DirectoryText className="max-w-[45%] shrink-0" dir={dir} /> : null}
    </CommandItem>
  );
});

const SnippetResultRow = memo(function SnippetResultRow(props: {
  match: ProjectContentMatch;
  index: number;
  highlightQuery: string;
  onOpenFile: (relativePath: string) => void;
}) {
  const { base, dir } = splitPath(props.match.path);
  return (
    <CommandItem
      index={props.index}
      value={`snippet:${props.match.path}:${props.match.lineNumber}`}
      className={`items-start py-1.5 ${ITEM_CLASS}`}
      onClick={() => props.onOpenFile(props.match.path)}
    >
      <FileEntryIcon
        pathValue={props.match.path}
        kind="file"
        colorMode="inherit"
        className={`mt-0.5 ${ICON_CLASS}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <FileNameText text={base} query={props.highlightQuery} />
          </span>
          <DirectoryText
            className="max-w-[45%] shrink-0"
            dir={dir ? `${dir}:${props.match.lineNumber}` : `:${props.match.lineNumber}`}
          />
        </div>
        <div className={`truncate font-mono text-[11px] leading-4 ${MUTED_TEXT_CLASS}`}>
          <SnippetLineText text={props.match.lineText} query={props.highlightQuery} />
        </div>
      </div>
    </CommandItem>
  );
});

// Thin shell: dialog + popup only. All state lives in the content component
// below, which Base UI keeps mounted through the exit transition and then
// unmounts — resetting the palette without ever blanking it mid-animation.
export function WorkspaceSearchPalette(props: WorkspaceSearchPaletteProps) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className={POPUP_CLASS}>
        <WorkspaceSearchPaletteContent
          open={props.open}
          mode={props.mode}
          onOpenChange={props.onOpenChange}
          cwd={props.cwd}
          onOpenFile={props.onOpenFile}
          onOpenDirectory={props.onOpenDirectory}
        />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function WorkspaceSearchPaletteContent(props: WorkspaceSearchPaletteProps) {
  const copy = MODE_COPY[props.mode];

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const [debouncedQuery] = useDebouncedValue(trimmedQuery, { wait: SEARCH_DEBOUNCE_MS });

  // The content component mounts once per open, so this fires before the
  // first keystroke — the server index build overlaps with the user typing.
  useEffect(() => {
    prewarmProjectSearchIndex(props.cwd);
  }, [props.cwd]);

  const hasUsableQuery =
    props.mode === "files"
      ? trimmedQuery.length > 0
      : trimmedQuery.length >= PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH;

  const fileSearchQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: props.cwd,
      query: debouncedQuery,
      limit: SEARCH_LIMIT,
      enabled: props.open && props.mode === "files" && debouncedQuery.length > 0,
      staleTime: SEARCH_STALE_TIME_MS,
    }),
  );

  const snippetSearchQuery = useQuery(
    projectSearchContentQueryOptions({
      cwd: props.cwd,
      query: debouncedQuery,
      limit: SEARCH_LIMIT,
      enabled:
        props.open &&
        props.mode === "snippets" &&
        debouncedQuery.length >= PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH,
      staleTime: SEARCH_STALE_TIME_MS,
    }),
  );

  const fileEntries =
    props.mode === "files" && hasUsableQuery
      ? (fileSearchQuery.data?.entries ?? EMPTY_FILE_ENTRIES)
      : EMPTY_FILE_ENTRIES;
  const snippetMatches =
    props.mode === "snippets" && hasUsableQuery
      ? (snippetSearchQuery.data?.matches ?? EMPTY_SNIPPET_MATCHES)
      : EMPTY_SNIPPET_MATCHES;

  // Exact item registry for Base UI, mirroring the rendered CommandItem
  // values in content and order. With it, the composite list clamps its
  // index-based highlight when the result count shrinks instead of leaving
  // the highlight pointing at a row that no longer exists.
  const itemValues = useMemo(
    () =>
      props.mode === "files"
        ? fileEntries.map((entry) => `${entry.kind}:${entry.path}`)
        : snippetMatches.map((match) => `snippet:${match.path}:${match.lineNumber}`),
    [props.mode, fileEntries, snippetMatches],
  );

  const activeQuery = props.mode === "files" ? fileSearchQuery : snippetSearchQuery;
  // While the debounce is pending or a fetch is in flight, the previous rows
  // keep rendering (react-query placeholderData carries them across query-key
  // changes). Only a settled response may claim "no results" — otherwise every
  // keystroke would flash the no-results state before data lands.
  const isSettled = trimmedQuery === debouncedQuery && !activeQuery.isFetching;
  const hasRows = fileEntries.length > 0 || snippetMatches.length > 0;

  // The server matches file entries against a normalized query (leading @ ./
  // stripped); highlighting must normalize the same way or rows that matched
  // server-side render with no emphasis. Content search does not strip
  // prefixes, so snippet rows highlight the raw trimmed query.
  const highlightQuery =
    props.mode === "files" ? normalizeWorkspaceEntrySearchQuery(debouncedQuery) : debouncedQuery;

  const { onOpenChange, onOpenFile, onOpenDirectory } = props;
  const handleOpenFile = useCallback(
    (relativePath: string) => {
      onOpenChange(false);
      onOpenFile(relativePath);
    },
    [onOpenChange, onOpenFile],
  );
  const handleOpenDirectory = useCallback(
    (relativePath: string) => {
      onOpenChange(false);
      onOpenDirectory(relativePath);
    },
    [onOpenChange, onOpenDirectory],
  );

  const statusMessage = !hasRows
    ? activeQuery.isError
      ? copy.error
      : hasUsableQuery && isSettled
        ? copy.noResults
        : copy.prompt
    : null;

  return (
    <Command items={itemValues} mode="none">
      {/* Hairline only while rows are showing, as a scroll boundary; the
          empty state reads as one uninterrupted surface. */}
      <div
        className={cn(
          "border-b",
          hasRows ? "border-zinc-950/5 dark:border-white/5" : "border-transparent",
        )}
      >
        <AutocompletePrimitive.Input
          autoFocus
          className={INPUT_CLASS}
          placeholder={copy.placeholder}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {/* Always-mounted polite live region, sibling of the listbox: prompt /
          no-results / error copy lives here so it is announced and never sits
          inside role="listbox". */}
      <CommandStatus>
        {statusMessage ? (
          <div className="text-start">
            <div className={GROUP_LABEL_CLASS}>{copy.groupLabel}</div>
            <div className="px-2.5 pt-0.5 pb-2 text-[13px] text-zinc-700 dark:text-zinc-300">
              {statusMessage}
            </div>
          </div>
        ) : null}
      </CommandStatus>

      <CommandList className={LIST_CLASS}>
        {props.mode === "files" && fileEntries.length > 0 ? (
          <CommandGroup>
            <CommandGroupLabel className={GROUP_LABEL_CLASS}>{copy.groupLabel}</CommandGroupLabel>
            {fileEntries.map((entry, index) => (
              <FileResultRow
                key={entry.path}
                entry={entry}
                index={index}
                highlightQuery={highlightQuery}
                onOpenFile={handleOpenFile}
                onOpenDirectory={handleOpenDirectory}
              />
            ))}
          </CommandGroup>
        ) : null}
        {props.mode === "snippets" && snippetMatches.length > 0 ? (
          <CommandGroup>
            <CommandGroupLabel className={GROUP_LABEL_CLASS}>{copy.groupLabel}</CommandGroupLabel>
            {snippetMatches.map((match, index) => (
              <SnippetResultRow
                key={`${match.path}:${match.lineNumber}`}
                match={match}
                index={index}
                highlightQuery={highlightQuery}
                onOpenFile={handleOpenFile}
              />
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}
