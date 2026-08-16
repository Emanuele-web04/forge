// FILE: WorkspaceSearchPalette.tsx
// Purpose: Minimal command-style palette for searching the current project's
//          files by name and by content (grep-style snippet search): a plain
//          borderless input, a single group label, and rows that split the
//          match into basename (left) and parent directory (right).
// Layer: Web UI components

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  projectSearchContentQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { FileEntryIcon } from "./chat/FileEntryIcon";

export type WorkspaceSearchPaletteMode = "files" | "snippets";

const SEARCH_DEBOUNCE_MS = 200;
const SNIPPET_MIN_QUERY_LENGTH = 2;
const SEARCH_LIMIT = 50;
const SEARCH_STALE_TIME_MS = 10_000;

const POPUP_CLASS =
  "max-w-2xl -translate-y-[9vh] rounded-3xl border-transparent bg-white text-zinc-800 shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_24px_64px_rgba(0,0,0,0.2)] before:hidden dark:border-zinc-700/60 dark:bg-[#212121] dark:text-zinc-200 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_24px_64px_rgba(0,0,0,0.55)]";

const GROUP_LABEL_CLASS = "pb-1.5 pl-3 text-sm font-normal text-zinc-400 dark:text-zinc-500";

const ITEM_CLASS =
  "cursor-pointer rounded-xl px-3 py-2 text-zinc-800 data-highlighted:bg-zinc-500/8 data-highlighted:text-zinc-900 dark:text-zinc-200 dark:data-highlighted:bg-zinc-400/10 dark:data-highlighted:text-zinc-100";

const MUTED_TEXT_CLASS = "text-zinc-400 dark:text-zinc-500";

interface WorkspaceSearchPaletteProps {
  open: boolean;
  mode: WorkspaceSearchPaletteMode;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  onOpenFile: (relativePath: string) => void;
}

function splitPath(path: string): { base: string; dir: string } {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex === -1) return { base: path, dir: "" };
  return { base: path.slice(separatorIndex + 1), dir: path.slice(0, separatorIndex) };
}

function highlightRange(
  text: string,
  query: string,
): { prefix: string; match: string; suffix: string } | null {
  if (!query) return null;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return null;
  return {
    prefix: text.slice(0, index),
    match: text.slice(index, index + query.length),
    suffix: text.slice(index + query.length),
  };
}

// Minimal match emphasis: the matched substring reads in the foreground color
// while the rest of the text stays muted. When the query doesn't occur in the
// text (e.g. it matched the directory instead), the whole text stays readable.
function FileNameText(props: { text: string; query: string }) {
  const range = highlightRange(props.text, props.query);
  if (!range) {
    return <span className="text-zinc-700 dark:text-zinc-300">{props.text}</span>;
  }
  return (
    <span className={MUTED_TEXT_CLASS}>
      {range.prefix}
      <span className="font-medium text-zinc-900 dark:text-zinc-50">{range.match}</span>
      {range.suffix}
    </span>
  );
}

function SnippetLineText(props: { text: string; query: string }) {
  const range = highlightRange(props.text, props.query);
  if (!range) return <>{props.text}</>;
  return (
    <>
      {range.prefix}
      <span className="font-medium text-zinc-700 dark:text-zinc-200">{range.match}</span>
      {range.suffix}
    </>
  );
}

// Left-aligned empty/prompt state matching the results layout: the group label
// stays put and the message renders where the first row would be.
function EmptyState(props: { label: string; message: string }) {
  return (
    <CommandEmpty className="px-0 py-0 text-start">
      <div className={GROUP_LABEL_CLASS}>{props.label}</div>
      <div className="px-3 py-2 text-[15px] text-zinc-700 dark:text-zinc-300">{props.message}</div>
    </CommandEmpty>
  );
}

export function WorkspaceSearchPalette(props: WorkspaceSearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    if (!props.open) {
      const timeoutId = window.setTimeout(() => {
        setQuery("");
        setDebouncedQuery("");
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
    return undefined;
  }, [props.open]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  const trimmedQuery = query.trim();
  const hasUsableQuery =
    props.mode === "files"
      ? trimmedQuery.length > 0
      : trimmedQuery.length >= SNIPPET_MIN_QUERY_LENGTH;

  const fileSearchQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: props.cwd,
      query: debouncedQuery,
      kind: "file",
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
        debouncedQuery.length >= SNIPPET_MIN_QUERY_LENGTH,
      staleTime: SEARCH_STALE_TIME_MS,
    }),
  );

  const fileEntries =
    props.mode === "files" && hasUsableQuery ? (fileSearchQuery.data?.entries ?? []) : [];
  const snippetMatches =
    props.mode === "snippets" && hasUsableQuery ? (snippetSearchQuery.data?.matches ?? []) : [];

  const isFetching =
    props.mode === "files" ? fileSearchQuery.isFetching : snippetSearchQuery.isFetching;

  const handleOpenFile = (relativePath: string) => {
    props.onOpenChange(false);
    props.onOpenFile(relativePath);
  };

  const groupLabel = props.mode === "files" ? "Files" : "Matches";
  const placeholder = props.mode === "files" ? "Search files" : "Search code";
  const promptMessage =
    props.mode === "files"
      ? "Type to search for files"
      : `Type at least ${SNIPPET_MIN_QUERY_LENGTH} characters to search code`;
  const noResultsMessage = props.mode === "files" ? "No matching files" : "No matches";

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className={POPUP_CLASS}>
        <Command mode="none">
          <div className="px-2.5 pt-2.5">
            <CommandInput
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              startAddon={null}
              className="px-2.5 py-2 text-[16px] placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
            />
          </div>

          <CommandList className="max-h-[min(24rem,60vh)] px-2 pt-1 pb-2.5">
            {!hasUsableQuery ? (
              <EmptyState label={groupLabel} message={promptMessage} />
            ) : props.mode === "files" ? (
              fileEntries.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel className={GROUP_LABEL_CLASS}>{groupLabel}</CommandGroupLabel>
                  {fileEntries.map((entry) => {
                    const { base, dir } = splitPath(entry.path);
                    return (
                      <CommandItem
                        key={entry.path}
                        value={`file:${entry.path}`}
                        className={`items-center gap-2.5 ${ITEM_CLASS}`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => handleOpenFile(entry.path)}
                      >
                        <FileEntryIcon
                          pathValue={entry.path}
                          kind="file"
                          colorMode="inherit"
                          className="text-zinc-500 dark:text-zinc-400"
                        />
                        <span className="min-w-0 flex-1 truncate text-[15px]">
                          <FileNameText text={base} query={debouncedQuery} />
                        </span>
                        {dir ? (
                          <span
                            className={`max-w-[45%] shrink-0 truncate text-sm ${MUTED_TEXT_CLASS}`}
                          >
                            {dir}
                          </span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : !isFetching ? (
                <EmptyState label={groupLabel} message={noResultsMessage} />
              ) : null
            ) : snippetMatches.length > 0 ? (
              <CommandGroup>
                <CommandGroupLabel className={GROUP_LABEL_CLASS}>{groupLabel}</CommandGroupLabel>
                {snippetMatches.map((match) => {
                  const { base, dir } = splitPath(match.path);
                  return (
                    <CommandItem
                      key={`${match.path}:${match.lineNumber}`}
                      value={`snippet:${match.path}:${match.lineNumber}`}
                      className={`items-start ${ITEM_CLASS}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => handleOpenFile(match.path)}
                    >
                      <FileEntryIcon
                        pathValue={match.path}
                        kind="file"
                        colorMode="inherit"
                        className="mt-0.5 text-zinc-500 dark:text-zinc-400"
                      />
                      <div className="ml-2.5 min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[15px]">
                            <FileNameText text={base} query={debouncedQuery} />
                          </span>
                          <span
                            className={`max-w-[45%] shrink-0 truncate text-sm ${MUTED_TEXT_CLASS}`}
                          >
                            {dir ? `${dir}:${match.lineNumber}` : `:${match.lineNumber}`}
                          </span>
                        </div>
                        <div
                          className={`mt-0.5 truncate font-mono text-[11px] leading-5 ${MUTED_TEXT_CLASS}`}
                        >
                          <SnippetLineText text={match.lineText} query={debouncedQuery} />
                        </div>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : !isFetching ? (
              <EmptyState label={groupLabel} message={noResultsMessage} />
            ) : null}
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
