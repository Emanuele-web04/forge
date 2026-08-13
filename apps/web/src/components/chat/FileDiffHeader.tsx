// FILE: FileDiffHeader.tsx
// Purpose: Synara-styled file header for @pierre/diffs cards in side panels
//          (PR Code tab, review DiffPanel, Git pane). Replaces Pierre's default
//          path/+N chrome with the same icon / filename+dir / DiffStat language
//          used by the jump menu and explorer rows.
// Layer: Chat/diff UI primitives

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { type ReactNode } from "react";

import {
  resolveFileDiffPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { DiffStat } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";

function stripPatchPathPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

export const FileDiffHeader = function FileDiffHeader(props: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  /** Optional trailing chrome (file-actions menu, collapse chevron, etc.). */
  trailing?: ReactNode;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const changeType = props.fileDiff.type;
  const isRename = changeType === "rename-pure" || changeType === "rename-changed";
  const prevLeaf =
    isRename && props.fileDiff.prevName
      ? splitRepoRelativePath(stripPatchPathPrefix(props.fileDiff.prevName)).name
      : null;
  const prevPath =
    isRename && props.fileDiff.prevName ? stripPatchPathPrefix(props.fileDiff.prevName) : null;
  const stat = summarizeFileDiffStats([props.fileDiff]);

  return (
    <div
      data-diff-file-header=""
      className={cn(
        "font-system-ui flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5",
        "text-[length:var(--app-font-size-ui,12px)] text-foreground",
      )}
      title={prevPath ? `${prevPath} → ${filePath}` : filePath}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/60">
        <FileEntryIcon
          pathValue={filePath}
          kind="file"
          theme={props.theme}
          className="size-3.5 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80"
        />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        {prevLeaf ? (
          <>
            <span className="shrink-0 truncate text-[11.5px] text-muted-foreground/65 line-through">
              {prevLeaf}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/45" aria-hidden>
              →
            </span>
          </>
        ) : null}
        <span className="shrink-0 truncate text-[11.5px] font-medium text-foreground/85">
          {name}
        </span>
        {dir ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">{dir}</span>
        ) : null}
      </div>
      <DiffStat
        additions={stat.additions}
        deletions={stat.deletions}
        className="shrink-0 text-[10px] tabular-nums"
      />
      {props.trailing ? (
        <span className="inline-flex shrink-0 items-center gap-0.5">{props.trailing}</span>
      ) : null}
    </div>
  );
};
