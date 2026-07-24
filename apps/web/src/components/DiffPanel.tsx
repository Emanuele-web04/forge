// FILE: DiffPanel.tsx
// Purpose: Coordinates diff-panel data sources, toolbar state, and patch body rendering.
// Layer: Diff panel container

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@synara/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { Columns2Icon, CopyIcon, EllipsisIcon, FolderIcon, Rows3Icon, XIcon } from "~/lib/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  gitBranchesQueryOptions,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import {
  checkpointDiffQueryOptions,
  resolveCheckpointDiffQueryDisplayState,
} from "~/lib/providerReactQuery";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffCopyText,
  sortFileDiffsByPath,
  summarizePatchTotals,
  summarizeRenderablePatchStats,
} from "../lib/diffRendering";
import {
  appendChatFileReference,
  appendComposerPromptText,
  buildDiffSelectionReference,
  buildWhyChangedPrompt,
} from "../lib/chatReferences";
import { resolveDiffEnvironmentState } from "../lib/threadEnvironment";
import { disclosureWidthClassName } from "../lib/disclosureMotion";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { type RepoDiffScope, useRepoDiffScopeStore } from "../repoDiffScopeStore";
import { useStore } from "../store";
import { createProjectSelector } from "../storeSelectors";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import { type TimestampFormat, useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { DOCK_HEADER_ICON_BUTTON_CLASS, type DiffRenderMode } from "./chat/chatHeaderControls";
import {
  areAllRenderableFilesCollapsed,
  DIFF_PANEL_PICKER_SCOPE_OPTIONS,
  isStaleDiffTurnSelection,
  resolveConversationCacheScope,
  resolveDiffPanelGitStatusQueriesEnabled,
  resolveDiffPanelQueriesEnabled,
  resolveDiffPanelScopeCountQueriesEnabled,
  resolveDiffPanelRepoLiveRefetchIntervalMs,
  resolveDiffPanelScopeFileCounts,
  resolveDiffPanelScopePickerValue,
  resolveDiffPanelThread,
  resolveDiffPanelViewSource,
  resolveDiffSelectAllArmed,
  resolveDiffSelectAllWithinViewport,
  resolveInitialDiffViewKind,
  resolveSelectedTurnSummary,
  type DiffPanelTurnScopeIntent,
  type DiffViewKind,
} from "./DiffPanel.logic";
import { DiffPanelPatchViewport } from "./DiffPanelPatchViewport";
import { DiffPanelToolbar } from "./DiffPanelToolbar";
import { ReviewFileTreePanel } from "./ReviewFileTreePanel";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { closestThroughShadow } from "./chat/chatSelectionActions";
import { TranscriptSelectionAction } from "./chat/TranscriptSelectionAction";
import { useCodeSelectionAction } from "./chat/useCodeSelectionAction";
import {
  createDiffPanelRepoLiveRefreshSelector,
  createDiffPanelThreadCatalogSelector,
  toDiffPanelThreadCatalog,
  type DiffPanelThreadCatalog,
} from "./diffPanelSelectors";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { IconButton } from "./ui/icon-button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { REPO_DIFF_SCOPE_LABELS } from "../repoDiffScopeStore";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { type SplitViewPanePanelState } from "../splitViewStore";
import { formatShortTimestamp } from "../timestampFormat";
import type { TurnDiffSummary } from "../types";

const EDITOR_DIFF_OPTIONS_MENU_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";

function EditorDiffOptionsCountBadge(props: { count: number | undefined }) {
  if (typeof props.count !== "number" || props.count <= 0) {
    return null;
  }
  return (
    <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
      {props.count}
    </span>
  );
}

function EditorDiffOptionsMenu(props: {
  scopePickerValue: string | null;
  scopeFileCounts: Partial<Record<RepoDiffScope, number>>;
  selectedTurnId: TurnId | null;
  orderedTurnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Record<string, number>;
  timestampFormat: TimestampFormat;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  diffWordWrap: boolean;
  diffIgnoreWhitespace: boolean;
  diffCopyText: string | null;
  isDiffCopied: boolean;
  allFilesCollapsed: boolean;
  diffRenderMode: DiffRenderMode;
  onSelectRepoScope: (scope: RepoDiffScope) => void;
  onSelectAllTurns: () => void;
  onSelectLastTurn: () => void;
  onSelectTurn: (turnId: TurnId | null) => void;
  onDiffRenderModeChange: (mode: DiffRenderMode) => void;
  onDiffWordWrapChange: (enabled: boolean) => void;
  onDiffIgnoreWhitespaceChange: (enabled: boolean) => void;
  onCopyDiff: () => void;
  onToggleCollapseAll: () => void;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);

  return (
    <Menu open={optionsOpen} onOpenChange={setOptionsOpen}>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            label="Diff options"
            title="Diff options"
            onClick={() => {
              setOptionsOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                setOptionsOpen(true);
              }
            }}
            onPointerDown={() => {
              setOptionsOpen(true);
            }}
          >
            <EllipsisIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-64 min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Source</MenuGroupLabel>
          <MenuRadioGroup
            value={props.scopePickerValue ?? ""}
            onValueChange={(value) => {
              if (value === "allTurns") {
                props.onSelectAllTurns();
                return;
              }
              if (value === "lastTurn") {
                props.onSelectLastTurn();
                return;
              }
              if (
                value === "workingTree" ||
                value === "unstaged" ||
                value === "staged" ||
                value === "branch"
              ) {
                props.onSelectRepoScope(value);
              }
            }}
          >
            {DIFF_PANEL_PICKER_SCOPE_OPTIONS.map((scope) => (
              <MenuRadioItem key={scope} value={scope}>
                <span className="min-w-0 flex-1 truncate">{REPO_DIFF_SCOPE_LABELS[scope]}</span>
                <EditorDiffOptionsCountBadge count={props.scopeFileCounts[scope]} />
              </MenuRadioItem>
            ))}
            <MenuRadioItem value="allTurns">
              <span className="min-w-0 flex-1 truncate">All turns</span>
            </MenuRadioItem>
            <MenuRadioItem value="lastTurn">
              <span className="min-w-0 flex-1 truncate">Last turn</span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>

        {props.orderedTurnDiffSummaries.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Turns</MenuGroupLabel>
            <MenuRadioGroup
              value={props.selectedTurnId ?? "all-turns"}
              onValueChange={(value) => {
                props.onSelectTurn(value === "all-turns" ? null : (value as TurnId));
              }}
            >
              <MenuRadioItem value="all-turns">
                <span className="min-w-0 flex-1 truncate">All turns</span>
              </MenuRadioItem>
              {props.orderedTurnDiffSummaries.map((summary) => {
                const turnNumber =
                  summary.checkpointTurnCount ??
                  props.inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                  "?";
                return (
                  <MenuRadioItem key={summary.turnId} value={summary.turnId}>
                    <span className="min-w-0 flex-1 truncate">Turn {turnNumber}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {formatShortTimestamp(summary.completedAt, props.timestampFormat)}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}

        <MenuGroup>
          <MenuGroupLabel>View</MenuGroupLabel>
          <MenuRadioGroup
            value={props.diffRenderMode}
            onValueChange={(value) => {
              if (value === "stacked" || value === "split") {
                props.onDiffRenderModeChange(value);
              }
            }}
          >
            <MenuRadioItem value="stacked">
              <Rows3Icon className={EDITOR_DIFF_OPTIONS_MENU_ICON_CLASS_NAME} />
              <span>Stacked diff</span>
            </MenuRadioItem>
            <MenuRadioItem value="split">
              <Columns2Icon className={EDITOR_DIFF_OPTIONS_MENU_ICON_CLASS_NAME} />
              <span>Split diff</span>
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuCheckboxItem
            checked={props.diffIgnoreWhitespace}
            variant="switch"
            onCheckedChange={(checked) => {
              props.onDiffIgnoreWhitespaceChange(checked === true);
            }}
          >
            Ignore whitespace-only changes
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={props.diffWordWrap}
            variant="switch"
            onCheckedChange={(checked) => {
              props.onDiffWordWrapChange(checked === true);
            }}
          >
            Wrap long lines
          </MenuCheckboxItem>
          {props.diffCopyText ? (
            <MenuItem
              onClick={() => {
                props.onCopyDiff();
              }}
            >
              <CopyIcon className={EDITOR_DIFF_OPTIONS_MENU_ICON_CLASS_NAME} />
              <span>{props.isDiffCopied ? "Copied diff" : "Copy diff"}</span>
            </MenuItem>
          ) : null}
          {props.renderableFiles.length > 0 ? (
            <MenuItem
              onClick={() => {
                props.onToggleCollapseAll();
              }}
            >
              <FolderIcon className={EDITOR_DIFF_OPTIONS_MENU_ICON_CLASS_NAME} />
              <span>{props.allFilesCollapsed ? "Expand all files" : "Collapse all files"}</span>
            </MenuItem>
          ) : null}
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function EditorDiffControls(props: {
  scopePickerValue: string | null;
  scopeFileCounts: Partial<Record<RepoDiffScope, number>>;
  selectedTurnId: TurnId | null;
  orderedTurnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Record<string, number>;
  timestampFormat: TimestampFormat;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  diffIgnoreWhitespace: boolean;
  diffCopyText: string | null;
  isDiffCopied: boolean;
  allFilesCollapsed: boolean;
  onSelectRepoScope: (scope: RepoDiffScope) => void;
  onSelectAllTurns: () => void;
  onSelectLastTurn: () => void;
  onSelectTurn: (turnId: TurnId | null) => void;
  onDiffRenderModeChange: (mode: DiffRenderMode) => void;
  onDiffWordWrapChange: (enabled: boolean) => void;
  onDiffIgnoreWhitespaceChange: (enabled: boolean) => void;
  onCopyDiff: () => void;
  onToggleCollapseAll: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <EditorDiffOptionsMenu
        scopePickerValue={props.scopePickerValue}
        scopeFileCounts={props.scopeFileCounts}
        selectedTurnId={props.selectedTurnId}
        orderedTurnDiffSummaries={props.orderedTurnDiffSummaries}
        inferredCheckpointTurnCountByTurnId={props.inferredCheckpointTurnCountByTurnId}
        timestampFormat={props.timestampFormat}
        renderableFiles={props.renderableFiles}
        diffWordWrap={props.diffWordWrap}
        diffIgnoreWhitespace={props.diffIgnoreWhitespace}
        diffCopyText={props.diffCopyText}
        isDiffCopied={props.isDiffCopied}
        allFilesCollapsed={props.allFilesCollapsed}
        diffRenderMode={props.diffRenderMode}
        onSelectRepoScope={props.onSelectRepoScope}
        onSelectAllTurns={props.onSelectAllTurns}
        onSelectLastTurn={props.onSelectLastTurn}
        onSelectTurn={props.onSelectTurn}
        onDiffRenderModeChange={props.onDiffRenderModeChange}
        onDiffWordWrapChange={props.onDiffWordWrapChange}
        onDiffIgnoreWhitespaceChange={props.onDiffIgnoreWhitespaceChange}
        onCopyDiff={props.onCopyDiff}
        onToggleCollapseAll={props.onToggleCollapseAll}
      />
    </div>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  threadId?: ThreadId | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
  liveRefreshEnabled?: boolean;
  /** When false, skip git/diff fetches (e.g. right dock collapsed or pane hidden). */
  queriesEnabled?: boolean;
  hideHeader?: boolean;
  onRenderableFilesChange?: (files: ReadonlyArray<FileDiffMetadata>, isLoading: boolean) => void;
  onEditorDiffOptionsChange?: (control: ReactNode | null) => void;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  threadId: controlledThreadId,
  panelState,
  onUpdatePanelState,
  onClosePanel,
  liveRefreshEnabled = true,
  queriesEnabled = true,
  hideHeader = false,
  onRenderableFilesChange,
  onEditorDiffOptionsChange,
}: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("split");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(true);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const handleScopePickerOpenChange = useCallback((open: boolean) => {
    setScopePickerOpen((previous) => (previous === open ? previous : open));
  }, []);
  const repoDiffScope = useRepoDiffScopeStore((store) => store.scope);
  const setRepoDiffScope = useRepoDiffScopeStore((store) => store.setScope);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  // Lazy-mount the review file tree on first open so a closed diff panel never
  // pays to filter/build/render the side tree (the common case). Keep it mounted
  // afterward so the open/close animation plays and the filter + expand state
  // persist across toggles.
  const [fileTreeMounted, setFileTreeMounted] = useState(false);
  const toggleFileTree = useCallback(() => {
    setFileTreeOpen((previous) => !previous);
    setFileTreeMounted(true);
  }, []);
  const closeFileTree = useCallback(() => {
    setFileTreeOpen(false);
  }, []);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const diffSelectAllArmedRef = useRef(false);
  // Cmd/Ctrl+A keydown targets document.activeElement; clicks on non-focusable diff
  // chrome leave focus outside the viewport. Remember the last pointer hit so a
  // subsequent select-all still counts as "inside the diff".
  const lastPointerInDiffViewportRef = useRef(false);
  const previousDiffOpenRef = useRef(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useDiffRouteSearch();
  const diffOpen = panelState ? panelState.panel === "diff" : diffSearch.diff === "1";
  const diffQueriesEnabled = useMemo(
    () =>
      resolveDiffPanelQueriesEnabled({
        diffOpen,
        queriesEnabled,
      }),
    [diffOpen, queriesEnabled],
  );
  const scopeCountQueriesEnabled = useMemo(
    () =>
      resolveDiffPanelScopeCountQueriesEnabled({
        queriesEnabled: diffQueriesEnabled,
        scopePickerOpen,
      }),
    [diffQueriesEnabled, scopePickerOpen],
  );
  const activeThreadId = controlledThreadId ?? routeThreadId;
  const serverThreadCatalog = useStore(
    useMemo(() => createDiffPanelThreadCatalogSelector(activeThreadId), [activeThreadId]),
  );
  const shouldPollRepoDiff = useStore(
    useMemo(() => createDiffPanelRepoLiveRefreshSelector(activeThreadId), [activeThreadId]),
  );
  const draftThread = useComposerDraftStore((store) =>
    activeThreadId ? (store.draftThreadsByThreadId[activeThreadId] ?? null) : null,
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  // Keep draft-backed thread context available before the first server turn exists.
  const activeThreadContext = useMemo((): DiffPanelThreadCatalog | undefined => {
    if (serverThreadCatalog) {
      return serverThreadCatalog;
    }
    const draftBackedThread = resolveDiffPanelThread({
      threadId: activeThreadId,
      serverThread: undefined,
      draftThread,
      fallbackModelSelection: fallbackDraftProject?.defaultModelSelection ?? null,
    });
    return draftBackedThread ? toDiffPanelThreadCatalog(draftBackedThread) : undefined;
  }, [
    activeThreadId,
    draftThread,
    fallbackDraftProject?.defaultModelSelection,
    serverThreadCatalog,
  ]);
  const activeProjectId = activeThreadContext?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const resolvedThreadEnvMode =
    serverThreadCatalog?.envMode ?? draftThread?.envMode ?? activeThreadContext?.envMode;
  const resolvedThreadWorktreePath =
    serverThreadCatalog?.worktreePath ??
    draftThread?.worktreePath ??
    activeThreadContext?.worktreePath ??
    null;
  const diffEnvironmentState = resolveDiffEnvironmentState({
    projectCwd: activeProject?.cwd ?? null,
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const diffEnvironmentPending = diffEnvironmentState.pending;
  const activeCwd = diffEnvironmentState.cwd;
  const selectedTurnId = panelState
    ? (panelState.diffTurnId ?? null)
    : (diffSearch.diffTurnId ?? null);
  const [diffViewKind, setDiffViewKind] = useState<DiffViewKind>(() =>
    resolveInitialDiffViewKind(selectedTurnId),
  );
  const [turnScopeIntent, setTurnScopeIntent] = useState<DiffPanelTurnScopeIntent>(() =>
    selectedTurnId === null ? "all" : "last",
  );
  const gitStatusQueriesEnabled = useMemo(
    () =>
      resolveDiffPanelGitStatusQueriesEnabled({
        queriesEnabled: diffQueriesEnabled,
        activeCwd,
        diffViewKind,
      }),
    [activeCwd, diffQueriesEnabled, diffViewKind],
  );
  const gitBranchesQuery = useQuery({
    ...gitBranchesQueryOptions(activeCwd ?? null),
    enabled: diffQueriesEnabled && activeCwd !== null,
  });
  const gitStatusQuery = useQuery({
    ...gitStatusQueryOptions(activeCwd ?? null),
    enabled: gitStatusQueriesEnabled,
  });
  const gitRepoStatus = gitBranchesQuery.isSuccess ? gitBranchesQuery.data.isRepo : undefined;
  const gitRepoStatusError =
    gitBranchesQuery.error instanceof Error
      ? gitBranchesQuery.error.message
      : gitBranchesQuery.error
        ? "Failed to check git repository."
        : null;
  const isGitRepo = gitRepoStatus === true;
  const turnDiffSummaries = activeThreadContext?.turnDiffSummaries ?? [];
  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );
  const repoDiffLiveRefreshIntervalMs = useMemo(
    () =>
      resolveDiffPanelRepoLiveRefetchIntervalMs({
        queriesEnabled: diffQueriesEnabled,
        liveRefreshEnabled,
        diffViewKind,
        shouldPollRepoDiff,
      }),
    [diffQueriesEnabled, diffViewKind, liveRefreshEnabled, shouldPollRepoDiff],
  );
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedFilePath = panelState
    ? (panelState.diffFilePath ?? null)
    : (diffSearch.diffFilePath ?? null);
  const selectedTurn = useMemo(
    () => resolveSelectedTurnSummary(selectedTurnId, orderedTurnDiffSummaries),
    [orderedTurnDiffSummaries, selectedTurnId],
  );
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn &&
      turnScopeIntent !== "last" &&
      typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn, turnScopeIntent],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(
    () =>
      selectedTurn || orderedTurnDiffSummaries.length === 0
        ? null
        : resolveConversationCacheScope(conversationCheckpointTurnCount),
    [conversationCheckpointTurnCount, orderedTurnDiffSummaries.length, selectedTurn],
  );
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled:
        diffQueriesEnabled && isGitRepo && !diffEnvironmentPending && diffViewKind === "turn",
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const checkpointDiffDisplay = resolveCheckpointDiffQueryDisplayState({
    isLoading: activeCheckpointDiffQuery.isLoading,
    isFetching: activeCheckpointDiffQuery.isFetching,
    data: activeCheckpointDiffQuery.data,
    error: activeCheckpointDiffQuery.error,
  });
  const isLoadingCheckpointDiff = checkpointDiffDisplay.isLoading;
  const checkpointDiffError = checkpointDiffDisplay.error;

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const unstagedDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "unstaged",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const stagedDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "staged",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const branchDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "branch",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const repoDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: repoDiffScope,
      enabled: diffQueriesEnabled && !diffEnvironmentPending && diffViewKind === "repo",
      refetchInterval: repoDiffLiveRefreshIntervalMs,
    }),
  );
  const repoPatch = repoDiffQuery.data?.patch;
  const hasResolvedRepoPatch = typeof repoPatch === "string";
  const hasNoRepoChanges = hasResolvedRepoPatch && repoPatch.trim().length === 0;
  const repoDiffError =
    repoDiffQuery.error instanceof Error
      ? repoDiffQuery.error.message
      : repoDiffQuery.error
        ? "Failed to load repo diff."
        : null;
  const branchHasCommittedChanges = (gitStatusQuery.data?.aheadCount ?? 0) > 0;

  useEffect(() => {
    if (
      diffOpen &&
      diffViewKind === "repo" &&
      repoDiffScope === "workingTree" &&
      hasResolvedRepoPatch &&
      hasNoRepoChanges &&
      branchHasCommittedChanges
    ) {
      setRepoDiffScope("branch");
    }
  }, [
    branchHasCommittedChanges,
    diffOpen,
    diffViewKind,
    hasNoRepoChanges,
    hasResolvedRepoPatch,
    repoDiffScope,
    setRepoDiffScope,
  ]);

  const viewSource = useMemo(
    () =>
      resolveDiffPanelViewSource({
        diffViewKind,
        repoDiffScope,
        selectedTurnId,
      }),
    [diffViewKind, repoDiffScope, selectedTurnId],
  );
  const activeReviewPatch = diffViewKind === "repo" ? repoPatch : selectedPatch;
  const activeReviewError = diffViewKind === "repo" ? repoDiffError : checkpointDiffError;
  const activeReviewIsLoading =
    diffViewKind === "repo" ? repoDiffQuery.isLoading : isLoadingCheckpointDiff;
  const activeReviewHasNoChanges = diffViewKind === "repo" ? hasNoRepoChanges : hasNoNetChanges;
  const { copyToClipboard: copyDiffToClipboard, isCopied: isDiffCopied } = useCopyToClipboard();
  // The parsed patch is structural and theme-agnostic — theming is applied
  // separately via the themed row key and buildDiffPanelUnsafeCSS (cached per
  // theme). Keeping `resolvedTheme` out of the parse cache scope and these deps
  // avoids re-parsing the whole patch on every light/dark toggle.
  const renderablePatch = useMemo(() => getRenderablePatch(activeReviewPatch), [activeReviewPatch]);
  const diffCopyText = useMemo(() => resolveDiffCopyText(activeReviewPatch), [activeReviewPatch]);
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return sortFileDiffsByPath(renderablePatch.files);
  }, [renderablePatch]);
  useEffect(() => {
    onRenderableFilesChange?.(renderableFiles, activeReviewIsLoading);
  }, [activeReviewIsLoading, onRenderableFilesChange, renderableFiles]);

  // Virtualized shadow-DOM diffs only mount ~150 rows. Arm on Cmd/Ctrl+A inside
  // the viewport, then hijack the document `copy` event to write the full raw patch.
  useEffect(() => {
    const isEventWithinDiffViewport = (event: Event) => {
      const viewport = patchViewportRef.current;
      return viewport ? event.composedPath().includes(viewport) : false;
    };
    const isTextEditingEvent = (event: Event) =>
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement &&
              (target.isContentEditable || target.getAttribute("role") === "textbox")),
        );
    const handleKeyDown = (event: KeyboardEvent) => {
      const isWithinDiffViewport = resolveDiffSelectAllWithinViewport(
        isEventWithinDiffViewport(event),
        lastPointerInDiffViewportRef.current,
        isTextEditingEvent(event),
      );
      diffSelectAllArmedRef.current = resolveDiffSelectAllArmed(
        diffSelectAllArmedRef.current,
        event,
        isWithinDiffViewport,
      );
    };
    const handlePointerDown = (event: PointerEvent) => {
      lastPointerInDiffViewportRef.current = isEventWithinDiffViewport(event);
      diffSelectAllArmedRef.current = false;
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (isEventWithinDiffViewport(event)) {
        return;
      }
      lastPointerInDiffViewportRef.current = false;
      diffSelectAllArmedRef.current = false;
    };
    const handleCopy = (event: ClipboardEvent) => {
      if (!diffSelectAllArmedRef.current) {
        return;
      }
      diffSelectAllArmedRef.current = false;
      if (!diffCopyText || !event.clipboardData) {
        return;
      }
      event.preventDefault();
      event.clipboardData.setData("text/plain", diffCopyText);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("copy", handleCopy, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("copy", handleCopy, true);
    };
  }, [diffCopyText]);

  const activePatchStat = useMemo(
    () => summarizeRenderablePatchStats(renderablePatch),
    [renderablePatch],
  );
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "workingTree",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const pickerScopeFileCounts = useMemo(() => {
    const counts: Partial<Record<RepoDiffScope, number>> = {};
    const workingTreeCount = summarizePatchTotals(workingTreeDiffQuery.data?.patch)?.fileCount;
    const unstagedCount = summarizePatchTotals(unstagedDiffQuery.data?.patch)?.fileCount;
    const stagedCount = summarizePatchTotals(stagedDiffQuery.data?.patch)?.fileCount;
    const branchCount = summarizePatchTotals(branchDiffQuery.data?.patch)?.fileCount;
    if (typeof workingTreeCount === "number") counts.workingTree = workingTreeCount;
    if (typeof unstagedCount === "number") counts.unstaged = unstagedCount;
    if (typeof stagedCount === "number") counts.staged = stagedCount;
    if (typeof branchCount === "number") counts.branch = branchCount;
    return counts;
  }, [
    branchDiffQuery.data?.patch,
    stagedDiffQuery.data?.patch,
    unstagedDiffQuery.data?.patch,
    workingTreeDiffQuery.data?.patch,
  ]);
  const scopeFileCounts = useMemo(
    () =>
      resolveDiffPanelScopeFileCounts({
        viewSource,
        activeScopeFileCount: activePatchStat?.fileCount,
        scopePickerOpen,
        pickerScopeCounts: pickerScopeFileCounts,
      }),
    [activePatchStat?.fileCount, pickerScopeFileCounts, scopePickerOpen, viewSource],
  );
  const allFilesCollapsed = useMemo(
    () => areAllRenderableFilesCollapsed(renderableFiles, collapsedFiles),
    [collapsedFiles, renderableFiles],
  );
  // Timeout-0 keeps these two sync writes asynchronous (no wasted pre-paint
  // render), which also keeps this component eligible for React Compiler; the
  // panel opens behind a 300ms slide, so one tick is invisible.
  useEffect(() => {
    const wasOpen = previousDiffOpenRef.current;
    previousDiffOpenRef.current = diffOpen;
    if (!diffOpen || wasOpen) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffViewKind(resolveInitialDiffViewKind(selectedTurnId));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [diffOpen, selectedTurnId, settings.diffWordWrap]);

  useEffect(() => {
    if (selectedTurnId === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setDiffViewKind((current) => (current === "turn" ? current : "turn"));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [selectedTurnId]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const toggleFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  }, []);

  // Per-file header actions that talk to the active thread's composer draft.
  const diffFileChatActions = useMemo(
    () =>
      activeThreadId
        ? {
            onReferenceInChat: (filePath: string) => {
              appendChatFileReference(activeThreadId, { path: filePath });
            },
            onAskWhyChanged: (filePath: string) => {
              appendComposerPromptText(activeThreadId, buildWhyChangedPrompt(filePath));
            },
          }
        : undefined,
    [activeThreadId],
  );

  // Highlight diff code -> floating "Add to chat" -> mention + quoted snippet.
  // The diff body renders inside the @pierre/diffs shadow root, so selection
  // ancestors are resolved through shadow boundaries.
  const readDiffSelection = useCallback((container: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const anchorRow = closestThroughShadow(selection.anchorNode, "[data-diff-file-path]");
    const focusRow = closestThroughShadow(selection.focusNode, "[data-diff-file-path]");
    if (!anchorRow || anchorRow !== focusRow || !container.contains(anchorRow)) {
      return null;
    }
    const filePath = anchorRow.getAttribute("data-diff-file-path") ?? "";
    const text = selection
      .toString()
      .replace(/\r\n/g, "\n")
      .replace(/^\n+|\n+$/g, "")
      .trim();
    if (filePath.length === 0 || text.length === 0) {
      return null;
    }
    return { filePath, text };
  }, []);
  const commitDiffSelection = useCallback(
    (payload: { filePath: string; text: string }) => {
      if (activeThreadId) {
        appendComposerPromptText(
          activeThreadId,
          buildDiffSelectionReference(payload.filePath, payload.text),
        );
      }
    },
    [activeThreadId],
  );
  const diffSelectionAction = useCodeSelectionAction({
    enabled: activeThreadId !== null,
    readSelection: readDiffSelection,
    onCommit: commitDiffSelection,
  });

  const updateDiffSelection = useCallback(
    (input: { turnId: TurnId | null; filePath?: string | null }) => {
      if (!activeThreadContext) return;
      if (onUpdatePanelState) {
        onUpdatePanelState({
          panel: "diff",
          diffTurnId: input.turnId,
          diffFilePath: input.filePath ?? null,
        });
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: activeThreadContext.id },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return {
            ...rest,
            panel: "diff",
            diff: "1",
            ...(input.turnId ? { diffTurnId: input.turnId } : {}),
            ...(input.filePath ? { diffFilePath: input.filePath } : {}),
          };
        },
      });
    },
    [activeThreadContext, navigate, onUpdatePanelState],
  );
  useEffect(() => {
    if (!diffOpen || !activeThreadContext) {
      return;
    }
    if (!isStaleDiffTurnSelection(selectedTurnId, orderedTurnDiffSummaries)) {
      return;
    }
    updateDiffSelection({ turnId: null, filePath: null });
  }, [
    activeThreadContext,
    diffOpen,
    orderedTurnDiffSummaries,
    selectedTurnId,
    updateDiffSelection,
  ]);
  const selectTurn = useCallback(
    (turnId: TurnId | null) => {
      setDiffViewKind("turn");
      setTurnScopeIntent(turnId === null ? "all" : "last");
      updateDiffSelection({ turnId, filePath: null });
    },
    [updateDiffSelection],
  );
  const selectRepoScope = useCallback(
    (scope: typeof repoDiffScope) => {
      setDiffViewKind("repo");
      setRepoDiffScope(scope);
      if (selectedTurnId !== null) {
        updateDiffSelection({ turnId: null, filePath: null });
      }
    },
    [selectedTurnId, setRepoDiffScope, updateDiffSelection],
  );
  const selectAllTurns = useCallback(() => {
    setTurnScopeIntent("all");
    selectTurn(null);
  }, [selectTurn]);
  const selectLastTurn = useCallback(() => {
    const latestTurn = orderedTurnDiffSummaries[0];
    setTurnScopeIntent("last");
    setDiffViewKind("turn");
    if (!latestTurn) {
      if (selectedTurnId !== null) {
        updateDiffSelection({ turnId: null, filePath: null });
      }
      return;
    }
    selectTurn(latestTurn.turnId);
  }, [orderedTurnDiffSummaries, selectTurn, selectedTurnId, updateDiffSelection]);
  const toggleCollapseAll = useCallback(() => {
    setCollapsedFiles((previous) => {
      if (areAllRenderableFilesCollapsed(renderableFiles, previous)) {
        return new Set();
      }
      return new Set(renderableFiles.map((fileDiff) => buildFileDiffRenderKey(fileDiff)));
    });
  }, [renderableFiles]);
  const selectFile = useCallback(
    (filePath: string) => {
      updateDiffSelection({ turnId: selectedTurnId, filePath });
    },
    [selectedTurnId, updateDiffSelection],
  );
  const showDiffToolbar = Boolean(activeThreadContext && isGitRepo && !diffEnvironmentPending);
  const copyDiff = useCallback(() => {
    if (diffCopyText) {
      copyDiffToClipboard(diffCopyText, undefined);
    }
  }, [copyDiffToClipboard, diffCopyText]);
  const latestTurnId = orderedTurnDiffSummaries[0]?.turnId ?? null;
  const scopePickerValue = useMemo(
    () =>
      resolveDiffPanelScopePickerValue({
        viewSource,
        latestTurnId,
        turnScopeIntent,
      }),
    [latestTurnId, turnScopeIntent, viewSource],
  );
  const editorDiffOptionsControl = useMemo(
    () =>
      hideHeader ? (
        <EditorDiffControls
          scopePickerValue={scopePickerValue}
          scopeFileCounts={scopeFileCounts}
          selectedTurnId={selectedTurnId}
          orderedTurnDiffSummaries={orderedTurnDiffSummaries}
          inferredCheckpointTurnCountByTurnId={inferredCheckpointTurnCountByTurnId}
          timestampFormat={settings.timestampFormat}
          renderableFiles={renderableFiles}
          diffRenderMode={diffRenderMode}
          diffWordWrap={diffWordWrap}
          diffIgnoreWhitespace={diffIgnoreWhitespace}
          diffCopyText={diffCopyText}
          isDiffCopied={isDiffCopied}
          allFilesCollapsed={allFilesCollapsed}
          onSelectRepoScope={selectRepoScope}
          onSelectAllTurns={selectAllTurns}
          onSelectLastTurn={selectLastTurn}
          onSelectTurn={selectTurn}
          onDiffRenderModeChange={setDiffRenderMode}
          onDiffWordWrapChange={setDiffWordWrap}
          onDiffIgnoreWhitespaceChange={setDiffIgnoreWhitespace}
          onCopyDiff={copyDiff}
          onToggleCollapseAll={toggleCollapseAll}
        />
      ) : null,
    [
      allFilesCollapsed,
      copyDiff,
      diffCopyText,
      diffIgnoreWhitespace,
      diffRenderMode,
      diffWordWrap,
      hideHeader,
      inferredCheckpointTurnCountByTurnId,
      isDiffCopied,
      orderedTurnDiffSummaries,
      renderableFiles,
      scopeFileCounts,
      scopePickerValue,
      selectAllTurns,
      selectLastTurn,
      selectRepoScope,
      selectTurn,
      selectedTurnId,
      settings.timestampFormat,
      toggleCollapseAll,
    ],
  );
  useEffect(() => {
    onEditorDiffOptionsChange?.(editorDiffOptionsControl);
  }, [editorDiffOptionsControl, onEditorDiffOptionsChange]);
  useEffect(
    () => () => {
      onEditorDiffOptionsChange?.(null);
    },
    [onEditorDiffOptionsChange],
  );

  const shellHeader = useMemo(
    () =>
      hideHeader ? null : showDiffToolbar ? (
        <DiffPanelToolbar
          // Remount per thread so per-thread view state (e.g. the expanded
          // turn-list page size) does not leak across thread navigations.
          key={activeThreadId ?? "no-thread"}
          activeCwd={activeCwd}
          activeThreadId={activeThreadId}
          viewSource={viewSource}
          turnScopeIntent={turnScopeIntent}
          scopeFileCounts={scopeFileCounts}
          activeStats={
            activePatchStat
              ? {
                  additions: activePatchStat.additions,
                  deletions: activePatchStat.deletions,
                }
              : null
          }
          orderedTurnDiffSummaries={orderedTurnDiffSummaries}
          inferredCheckpointTurnCountByTurnId={inferredCheckpointTurnCountByTurnId}
          selectedTurnId={selectedTurnId}
          timestampFormat={settings.timestampFormat}
          renderableFiles={renderableFiles}
          selectedFilePath={selectedFilePath}
          fileTreeOpen={fileTreeOpen}
          resolvedTheme={resolvedTheme}
          diffRenderMode={diffRenderMode}
          diffWordWrap={diffWordWrap}
          diffIgnoreWhitespace={diffIgnoreWhitespace}
          diffCopyText={diffCopyText}
          isDiffCopied={isDiffCopied}
          allFilesCollapsed={allFilesCollapsed}
          onSelectRepoScope={selectRepoScope}
          onSelectAllTurns={selectAllTurns}
          onSelectLastTurn={selectLastTurn}
          onSelectTurn={selectTurn}
          onSelectFile={selectFile}
          onToggleFileTree={toggleFileTree}
          onDiffRenderModeChange={setDiffRenderMode}
          onDiffWordWrapChange={setDiffWordWrap}
          onDiffIgnoreWhitespaceChange={setDiffIgnoreWhitespace}
          onCopyDiff={copyDiff}
          onToggleCollapseAll={toggleCollapseAll}
          scopePickerOpen={scopePickerOpen}
          onScopePickerOpenChange={handleScopePickerOpenChange}
          {...(onClosePanel ? { onClosePanel } : {})}
        />
      ) : onClosePanel ? (
        <div className="flex h-full w-full items-center justify-end px-3 [-webkit-app-region:no-drag]">
          <IconButton
            variant="chrome"
            size="icon-xs"
            label="Close file view"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            onClick={(event) => {
              event.stopPropagation();
              onClosePanel();
            }}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      ) : null,
    [
      activeCwd,
      activePatchStat,
      activeThreadId,
      allFilesCollapsed,
      copyDiff,
      diffCopyText,
      diffIgnoreWhitespace,
      diffRenderMode,
      diffWordWrap,
      fileTreeOpen,
      hideHeader,
      inferredCheckpointTurnCountByTurnId,
      isDiffCopied,
      handleScopePickerOpenChange,
      onClosePanel,
      orderedTurnDiffSummaries,
      scopePickerOpen,
      renderableFiles,
      resolvedTheme,
      scopeFileCounts,
      selectAllTurns,
      selectFile,
      selectLastTurn,
      selectRepoScope,
      selectTurn,
      selectedFilePath,
      selectedTurnId,
      settings.timestampFormat,
      showDiffToolbar,
      toggleCollapseAll,
      toggleFileTree,
      turnScopeIntent,
      viewSource,
    ],
  );

  return (
    <DiffPanelShell mode={mode} header={shellHeader}>
      {!activeThreadContext ? (
        <PanelStateMessage density="compact" fill="flex">
          Select a thread to inspect turn diffs.
        </PanelStateMessage>
      ) : gitRepoStatus === false ? (
        <PanelStateMessage density="compact" fill="flex">
          Turn diffs are unavailable because this project is not a git repository.
        </PanelStateMessage>
      ) : gitRepoStatusError ? (
        <PanelStateMessage density="compact" fill="flex">
          {gitRepoStatusError}
        </PanelStateMessage>
      ) : gitRepoStatus === undefined && diffQueriesEnabled && activeCwd ? (
        <DiffPanelLoadingState label="Checking git repository..." />
      ) : diffEnvironmentPending ? (
        <PanelStateMessage density="compact" fill="flex">
          This chat environment is still being prepared. Diffs will be available once the worktree
          is ready.
        </PanelStateMessage>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            onMouseUp={diffSelectionAction.onContainerMouseUp}
          >
            <DiffPanelPatchViewport
              renderablePatch={renderablePatch}
              renderableFiles={renderableFiles}
              resolvedTheme={resolvedTheme}
              diffRenderMode={diffRenderMode}
              diffWordWrap={diffWordWrap}
              workspaceRoot={activeCwd ?? null}
              collapsedFiles={collapsedFiles}
              onToggleFileCollapsed={toggleFileCollapsed}
              chatActions={diffFileChatActions}
              isLoading={activeReviewIsLoading}
              hasNoChanges={activeReviewHasNoChanges}
              error={activeReviewError}
              viewKind={diffViewKind}
              loadingLabel={
                diffViewKind === "repo"
                  ? `Loading ${REPO_DIFF_SCOPE_LABELS[repoDiffScope].toLowerCase()} diff...`
                  : "Loading checkpoint diff..."
              }
              emptyLabel={
                diffViewKind === "repo"
                  ? "No changes in the selected diff source."
                  : orderedTurnDiffSummaries.length === 0
                    ? "No turn diffs are available yet."
                    : "No net changes in this selection."
              }
              unavailableLabel="No repo diff is available right now."
            />
            {diffSelectionAction.pendingAction ? (
              <TranscriptSelectionAction
                left={diffSelectionAction.pendingAction.left}
                top={diffSelectionAction.pendingAction.top}
                placement={diffSelectionAction.pendingAction.placement}
                onAddToChat={diffSelectionAction.commit}
              />
            ) : null}
          </div>
          {hideHeader ? null : (
            <div
              className={disclosureWidthClassName(fileTreeOpen, "w-[min(42%,28rem)]", "shrink-0")}
              aria-hidden={!fileTreeOpen}
              inert={!fileTreeOpen}
            >
              {/* Empty until first open: the wrapper stays mounted (free) so the
                  width reveal animates, but the tree only filters/builds once the
                  user actually opens it. */}
              {fileTreeMounted ? (
                <ReviewFileTreePanel
                  files={renderableFiles}
                  selectedFilePath={selectedFilePath}
                  resolvedTheme={resolvedTheme}
                  isLoading={activeReviewIsLoading}
                  onSelectFile={selectFile}
                  onClose={closeFileTree}
                />
              ) : null}
            </div>
          )}
        </div>
      )}
    </DiffPanelShell>
  );
}
