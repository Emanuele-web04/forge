// FILE: GitPanel.tsx
// Purpose: Source-control staging pane for the right dock (staged/unstaged lists + per-file diff).
// Layer: Chat right-dock UI
// Depends on: gitReactQuery (diff queries + stage/unstage mutations), diffRendering (patch parsing),
//             @pierre/diffs FileDiff for the per-file viewer.
//
// The pane derives its cwd like DockTerminalPane (thread worktree or project cwd) and reads the
// staged/unstaged patches, parsing them into file lists. Stage/unstage are index mutations routed
// through GitCore; on settle we invalidate the per-cwd git caches so both lists stay in sync.

import { type FileDiffMetadata } from "@pierre/diffs/react";
import { type ProjectId, type ThreadId } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveFileDiffPath,
  sortFileDiffsByPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "~/lib/diffRendering";
import {
  gitQueryKeys,
  gitStageFilesMutationOptions,
  gitUnstageFilesMutationOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { PlusIcon, RefreshCwIcon, RotateCcwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createProjectSelector, createThreadSelector } from "~/storeSelectors";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chatHeaderControls";
import { DiffStat } from "./DiffStatLabel";
import { DockPaneHeader } from "./DockPaneHeader";
import { FileDiffCard, FileDiffSurface } from "./FileDiffView";
import { FileEntryIcon } from "./FileEntryIcon";
import { PanelStateMessage } from "./PanelStateMessage";

type GitPanelSection = "staged" | "unstaged";

// Selection is keyed by section + working-tree path (not the content-hashed
// render key) so it survives a file moving between the staged and unstaged
// lists after a stage/unstage action.
interface SelectedFile {
  section: GitPanelSection;
  path: string;
}

function parsePatchToSortedFiles(
  patch: string | undefined,
  cacheScope: string,
): FileDiffMetadata[] {
  const renderable = getRenderablePatch(patch, cacheScope);
  return renderable?.kind === "files" ? sortFileDiffsByPath(renderable.files) : [];
}

function GitFileRow(props: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  isSelected: boolean;
  actionLabel: string;
  actionIcon: "stage" | "unstage";
  actionDisabled: boolean;
  onSelect: (file: FileDiffMetadata) => void;
  onAction: (paths: string[]) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const stat = summarizeFileDiffStats([props.fileDiff]);
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
        props.isSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onClick={() => props.onSelect(props.fileDiff)}
        title={filePath}
      >
        <FileEntryIcon pathValue={filePath} kind="file" theme={props.theme} className="size-4" />
        <span className="min-w-0 truncate text-[12px] text-foreground">
          {dir ? <span className="text-muted-foreground/70">{dir}</span> : null}
          <span>{name}</span>
        </span>
      </button>
      <DiffStat
        additions={stat.additions}
        deletions={stat.deletions}
        className="shrink-0 text-[11px]"
      />
      <IconButton
        size="icon-xs"
        variant="ghost"
        className="shrink-0 opacity-0 group-hover:opacity-100 data-[disabled]:opacity-40"
        label={props.actionLabel}
        tooltip={props.actionLabel}
        disabled={props.actionDisabled}
        onClick={() => props.onAction([filePath])}
      >
        {props.actionIcon === "stage" ? (
          <PlusIcon className="size-3.5" />
        ) : (
          <RotateCcwIcon className="size-3.5" />
        )}
      </IconButton>
    </div>
  );
}

function GitFileSection(props: {
  title: string;
  emptyLabel: string;
  files: FileDiffMetadata[];
  theme: "light" | "dark";
  section: GitPanelSection;
  selectedPath: string | null;
  actionLabel: string;
  actionAllLabel: string;
  actionIcon: "stage" | "unstage";
  actionDisabled: boolean;
  onSelect: (file: FileDiffMetadata) => void;
  onAction: (paths: string[]) => void;
}) {
  const stat = summarizeFileDiffStats(props.files);
  const allPaths = props.files.map((file) => resolveFileDiffPath(file));
  return (
    <section className="min-w-0">
      <header className="flex items-center gap-2 px-1.5 py-1">
        <span className="text-[11px] font-semibold text-muted-foreground">{props.title}</span>
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {props.files.length}
        </span>
        <DiffStat additions={stat.additions} deletions={stat.deletions} className="text-[10px]" />
        {props.files.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0"
            disabled={props.actionDisabled}
            onClick={() => props.onAction(allPaths)}
          >
            {props.actionAllLabel}
          </Button>
        ) : null}
      </header>
      {props.files.length === 0 ? (
        <p className="px-1.5 py-1 text-[11px] text-muted-foreground/70">{props.emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {props.files.map((file) => {
            const key = buildFileDiffRenderKey(file);
            const filePath = resolveFileDiffPath(file);
            return (
              <GitFileRow
                key={key}
                fileDiff={file}
                theme={props.theme}
                isSelected={props.selectedPath === filePath}
                actionLabel={props.actionLabel}
                actionIcon={props.actionIcon}
                actionDisabled={props.actionDisabled}
                onSelect={props.onSelect}
                onAction={props.onAction}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function SelectedFileDiff(props: { fileDiff: FileDiffMetadata; theme: "light" | "dark" }) {
  return (
    <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 py-2">
      <div className="diff-render-file rounded-md">
        <FileDiffCard fileDiff={props.fileDiff} theme={props.theme} />
      </div>
    </FileDiffSurface>
  );
}

export function GitPanel(props: {
  hostThreadId: ThreadId;
  projectId: ProjectId | null;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme as "light" | "dark";
  const thread = useStore(
    useMemo(() => createThreadSelector(props.hostThreadId), [props.hostThreadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const cwd = thread?.worktreePath ?? project?.cwd ?? null;

  const [selected, setSelected] = useState<SelectedFile | null>(null);

  // No fixed polling: turn-driven file changes already push-invalidate the
  // working-tree-diff cache (see __root.tsx), and focus + the Refresh button +
  // post-mutation invalidation cover the rest. This keeps the pane cheap.
  const stagedQuery = useQuery(gitWorkingTreeDiffQueryOptions({ cwd, scope: "staged" }));
  const unstagedQuery = useQuery(gitWorkingTreeDiffQueryOptions({ cwd, scope: "unstaged" }));

  const stagedFiles = parsePatchToSortedFiles(stagedQuery.data?.patch, `git-pane:staged:${theme}`);
  const unstagedFiles = parsePatchToSortedFiles(
    unstagedQuery.data?.patch,
    `git-pane:unstaged:${theme}`,
  );

  const stageMutation = useMutation(gitStageFilesMutationOptions({ cwd, queryClient }));
  const unstageMutation = useMutation(gitUnstageFilesMutationOptions({ cwd, queryClient }));
  const mutating = stageMutation.isPending || unstageMutation.isPending;

  const stage = (paths: string[]) => {
    if (!cwd || paths.length === 0) return;
    stageMutation.mutate(paths);
  };
  const unstage = (paths: string[]) => {
    if (!cwd || paths.length === 0) return;
    unstageMutation.mutate(paths);
  };

  const selectStaged = (file: FileDiffMetadata) => {
    setSelected({ section: "staged", path: resolveFileDiffPath(file) });
  };
  const selectUnstaged = (file: FileDiffMetadata) => {
    setSelected({ section: "unstaged", path: resolveFileDiffPath(file) });
  };

  const refresh = () => {
    if (!cwd) return;
    void queryClient.invalidateQueries({ queryKey: gitQueryKeys.workingTreeDiff(cwd, "staged") });
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiff(cwd, "unstaged"),
    });
  };

  // Resolve the selected file by path, preferring its stored section but falling
  // back to the other list so the diff (and row highlight) follow a file across a
  // stage/unstage move instead of silently clearing.
  let selectedResolved: { section: GitPanelSection; file: FileDiffMetadata } | null = null;
  if (selected) {
    const findInSection = (section: GitPanelSection) =>
      (section === "staged" ? stagedFiles : unstagedFiles).find(
        (file) => resolveFileDiffPath(file) === selected.path,
      ) ?? null;
    const preferred = findInSection(selected.section);
    if (preferred) {
      selectedResolved = { section: selected.section, file: preferred };
    } else {
      const otherSection: GitPanelSection = selected.section === "staged" ? "unstaged" : "staged";
      const fallback = findInSection(otherSection);
      selectedResolved = fallback ? { section: otherSection, file: fallback } : null;
    }
  }
  const selectedFileDiff = selectedResolved?.file ?? null;
  const selectedPath = selected?.path ?? null;

  const isLoading = stagedQuery.isLoading || unstagedQuery.isLoading;
  const error =
    stagedQuery.error instanceof Error
      ? stagedQuery.error.message
      : unstagedQuery.error instanceof Error
        ? unstagedQuery.error.message
        : null;
  const hasChanges = stagedFiles.length > 0 || unstagedFiles.length > 0;

  if (!cwd) {
    return <PanelStateMessage>Source control is unavailable for this thread.</PanelStateMessage>;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <DockPaneHeader
        title="Source control"
        onClose={props.onClose}
        closeLabel="Close source control"
        actions={
          <IconButton
            size="icon-xs"
            variant="ghost"
            label="Refresh changes"
            tooltip="Refresh changes"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            onClick={refresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </IconButton>
        }
      />

      <div className="flex max-h-[48%] min-h-0 shrink-0 flex-col gap-2 overflow-auto px-1.5 py-2">
        {error ? (
          <Alert variant="error" size="sm" className="text-destructive">
            {error}
          </Alert>
        ) : null}
        {!error && isLoading && !hasChanges ? (
          <p className="px-1.5 py-1 text-[11px] text-muted-foreground/70">Loading changes...</p>
        ) : null}
        {!error && !isLoading && !hasChanges ? (
          <p className="px-1.5 py-2 text-center text-[12px] text-muted-foreground/70">
            No changes in the working tree.
          </p>
        ) : null}
        {hasChanges ? (
          <>
            <GitFileSection
              title="Staged"
              emptyLabel="No staged changes."
              files={stagedFiles}
              theme={theme}
              section="staged"
              selectedPath={selectedResolved?.section === "staged" ? selectedPath : null}
              actionLabel="Unstage file"
              actionAllLabel="Unstage all"
              actionIcon="unstage"
              actionDisabled={mutating}
              onSelect={selectStaged}
              onAction={unstage}
            />
            <GitFileSection
              title="Changes"
              emptyLabel="No unstaged changes."
              files={unstagedFiles}
              theme={theme}
              section="unstaged"
              selectedPath={selectedResolved?.section === "unstaged" ? selectedPath : null}
              actionLabel="Stage file"
              actionAllLabel="Stage all"
              actionIcon="stage"
              actionDisabled={mutating}
              onSelect={selectUnstaged}
              onAction={stage}
            />
          </>
        ) : null}
      </div>

      <div className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden border-t border-border/70">
        {selectedFileDiff ? (
          <SelectedFileDiff
            key={`${buildFileDiffRenderKey(selectedFileDiff)}:${theme}`}
            fileDiff={selectedFileDiff}
            theme={theme}
          />
        ) : (
          <PanelStateMessage density="compact">Select a file to view its diff.</PanelStateMessage>
        )}
      </div>
    </div>
  );
}

export default GitPanel;
