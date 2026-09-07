// FILE: SidebarActivityView.tsx
// Purpose: Task-feed sidebar surface — every thread is a 2-line task row
//          (provider + title / project + branch) grouped by status, with settle.
// Layer: Sidebar UI component
// Exports: SidebarActivityView

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type { OrchestrationThreadPullRequest, ProjectId, ThreadId } from "@synara/contracts";
import { resolveThreadEnvironmentMode } from "@synara/shared/threadEnvironment";

import {
  AddPlusIcon,
  CircleCheckIcon,
  GitBranchIcon,
  NewThreadIcon,
  SortIcon,
  Undo2Icon,
  WorktreeIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { splitShortcutLabel } from "../keybindings";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  sidebarHoverRevealHideClassName,
} from "../sidebarRowStyles";
import { resolveThreadPullRequestFallback } from "../hooks/useThreadPullRequests";
import type { Project, SidebarThreadSummary } from "../types";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon } from "./ProviderIcon";
import { PrStateChip } from "./pullRequest/PrStateChip";
import {
  buildProjectThreadTree,
  createSidebarThreadHoverAnchorId,
  resolveJumpHintReserveClass,
  resolveSidebarThreadListPaging,
  resolveThreadDisplayBranch,
  resolveThreadProjectLabel,
  resolveThreadStatusTrailingIndicator,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityFamilyThreads,
  collectVisibleActivityThreadIds,
  formatActivityRowTime,
  groupActivityThreadsByProject,
  isThreadSettledForActivity,
  resolveActivityScope,
  splitActivityThreadsByDateBucket,
  splitPriorityActivityThreads,
  splitRecentActivityThreads,
  type ActivityFamily,
  type ActivityGroupMode,
  type ActivityProjectGroup,
  type ActivityScopeOption,
  type ActivityScopeSelection,
} from "./SidebarActivityView.logic";
import {
  DEFAULT_TIMESTAMP_FORMAT,
  type SidebarThreadSortOrder,
  type TimestampFormat,
} from "../appSettings";
import { SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE } from "./sidebarThreadHierarchy";
import {
  nestSidebarEntriesByDepth,
  SidebarThreadHierarchyBranch,
  type NestedSidebarEntry,
} from "./SidebarThreadBranch";
import { SIDEBAR_TRAILING_ICON_CLASS, sidebarGlyphClass } from "./sidebarGlyphs";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import {
  createSidebarThreadRowGestures,
  type SidebarRowContextMenuPosition,
} from "./sidebarThreadRowGestures";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

const ACTIVITY_LIST_BASE_LIMIT = 20;
const ACTIVITY_LIST_PAGE_SIZE = 20;
const EMPTY_PROJECT_GROUPS: ActivityProjectGroup[] = [];
const EMPTY_EXPANDED_THREAD_IDS: ReadonlySet<ThreadId> = new Set();
const EMPTY_COLLAPSED_THREAD_IDS: ReadonlySet<ThreadId> = new Set();
const EMPTY_CHILD_EXTRA_PAGES: ReadonlyMap<ThreadId, number> = new Map();
const DEFAULT_ACTIVITY_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

type ActivityHierarchyEntry = {
  thread: SidebarThreadSummary;
  depth: number;
  directChildCount?: number | undefined;
  edgeKind?: import("./sidebarThreadHierarchy").ThreadHierarchyEdgeKind | undefined;
};

/** Roots paged before they expand: families count, children never consume root slots. */
function getVisibleFamiliesForPreview(input: {
  families: readonly ActivityFamily[];
  activeThreadId: ThreadId | null;
  familyByThreadId: ReadonlyMap<ThreadId, ActivityFamily>;
  previewLimit: number;
}): { visibleFamilies: ActivityFamily[]; hasHiddenFamilies: boolean } {
  const { families, activeThreadId, familyByThreadId, previewLimit } = input;
  if (families.length <= previewLimit) {
    return { visibleFamilies: [...families], hasHiddenFamilies: false };
  }
  const previewFamilies = families.slice(0, previewLimit);
  const previewRootIds = new Set(previewFamilies.map((family) => family.rootId));
  if (activeThreadId !== null) {
    const activeFamily = familyByThreadId.get(activeThreadId);
    if (activeFamily && !previewRootIds.has(activeFamily.rootId)) {
      return {
        visibleFamilies: [...previewFamilies, activeFamily],
        hasHiddenFamilies: true,
      };
    }
  }
  return { visibleFamilies: previewFamilies, hasHiddenFamilies: true };
}

/** Keeps a row action (pin, archive, done) from also opening the thread. */
function stopRowActivation(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function ActivityThreadRow({
  thread,
  project,
  isActive,
  isSettled,
  isPinned,
  pr,
  status,
  threadJumpLabel,
  rowTime,
  onOpen,
  onSetSettled,
  onTogglePinned,
  onArchive,
  onRename,
  onRenamePointerUp,
  onContextMenu,
  renderHoverCard,
}: {
  thread: SidebarThreadSummary;
  project: Project | undefined;
  isActive: boolean;
  isSettled: boolean;
  isPinned: boolean;
  pr: OrchestrationThreadPullRequest | null;
  status: ThreadStatusPill | null;
  threadJumpLabel: string | null;
  /** Pre-computed by the parent so every row in a section shares one clock. */
  rowTime: string;
  onOpen: () => void;
  onSetSettled: (settled: boolean) => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  onRename: (threadId: ThreadId) => void;
  onRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  renderHoverCard: (anchorId: string) => ReactNode;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const branch = resolveThreadDisplayBranch(thread);
  const isWorktree =
    resolveThreadEnvironmentMode({
      envMode: thread.envMode,
      worktreePath: thread.worktreePath,
    }) === "worktree";
  const ProjectGlyph = isWorktree ? WorktreeIcon : FolderClosed;
  const hoverAnchorId = createSidebarThreadHoverAnchorId({
    scope: "activity",
    threadId: thread.id,
  });
  const actionToneClassName = "text-muted-foreground/42";
  // The status glyph lives inline in the second line (next to PR/branch) instead
  // of the absolute top-right slot, so it stays visible while the hover actions
  // appear — the classic rows fade it out exactly when it is most needed.
  const trailingStatus = resolveThreadStatusTrailingIndicator({
    status,
    isActive,
  });
  const threadJumpLabelParts = threadJumpLabel ? splitShortcutLabel(threadJumpLabel) : [];
  // Rename/context-menu gestures live on the row wrapper (not the title button) so
  // they also fire over the trailing status and hover-action cluster, which are
  // absolutely positioned siblings of the button.
  const rowGestures = createSidebarThreadRowGestures({
    threadId: thread.id,
    onRename,
    onRenamePointerUp,
    onContextMenu,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <div
            data-thread-hover-anchor={hoverAnchorId}
            className="group/activity-row relative"
            data-thread-item
            {...rowGestures}
          />
        }
      >
        <button
          type="button"
          onClick={onOpen}
          data-testid={`activity-thread-${thread.id}`}
          className={cn(
            "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left select-none",
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
            isActive ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
            // Pinned rows never dim: dimming means "settled/done" in this feed,
            // and a pinned-but-settled thread must not read as finished.
            isSettled && !isPinned && "opacity-55 transition-opacity hover:opacity-85",
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-hidden pr-5 transition-[padding] duration-150 ease-out",
              threadJumpLabelParts.length > 0 &&
                resolveJumpHintReserveClass(0, threadJumpLabelParts.length),
              // Yield the title row to the hover action cluster (pin + archive + done).
              "group-hover/activity-row:pr-[4.25rem] group-focus-within/activity-row:pr-[4.25rem]",
            )}
          >
            <ProviderIcon
              provider={provider}
              className="size-3 shrink-0"
              fallback={
                <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
              }
            />
            <span
              className={cn(
                "min-w-0 shrink truncate text-[length:var(--app-font-size-ui,12px)] leading-5 font-normal",
                isActive ? "text-foreground" : SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
              )}
            >
              {thread.title}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <ProjectGlyph
              className={sidebarGlyphClass("meta", "text-muted-foreground/70")}
              aria-hidden
            />
            <span className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/80">
              {resolveThreadProjectLabel(project)}
            </span>
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              {pr ? <PrStateChip pr={pr} className="[&_svg]:size-2.5" /> : null}
              {branch ? (
                <span className="flex min-w-0 items-center gap-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
                  <GitBranchIcon className={sidebarGlyphClass("meta")} aria-hidden />
                  <span className="max-w-36 truncate">{branch}</span>
                </span>
              ) : null}
              {trailingStatus ? <SidebarStatusTrailingGlyph status={trailingStatus} /> : null}
              <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/60">
                {rowTime}
              </span>
            </span>
          </span>
        </button>
        {threadJumpLabel ? (
          <KbdGroup
            className={cn(
              "pointer-events-none absolute top-1 right-1",
              sidebarHoverRevealHideClassName("activity-row"),
            )}
          >
            {threadJumpLabelParts.map((part) => (
              <Kbd key={part}>{part}</Kbd>
            ))}
          </KbdGroup>
        ) : null}
        <span
          className="absolute top-1 right-1 inline-flex items-center gap-1 opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100"
          // Double-clicking an action button toggles it twice; it must not also open
          // the row's rename dialog. Pointer-up is the touch/pen double-tap signal,
          // so keep action taps out of that detector too.
          onDoubleClick={stopRowActivation}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <ThreadPinToggleButton
            pinned={isPinned}
            presentation="inline"
            toneClassName={actionToneClassName}
            onToggle={(event) => {
              stopRowActivation(event);
              onTogglePinned();
            }}
          />
          <ThreadArchiveActionButton
            threadId={thread.id}
            toneClassName={actionToneClassName}
            onArchive={onArchive}
          />
          <SidebarIconButton
            icon={isSettled ? Undo2Icon : CircleCheckIcon}
            label={isSettled ? "Undo" : "Done"}
            title={isSettled ? "Undo" : "Done"}
            iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
            className={cn("hover:text-foreground/89", actionToneClassName)}
            onMouseDown={stopRowActivation}
            onClick={(event) => {
              stopRowActivation(event);
              onSetSettled(!isSettled);
            }}
          />
        </span>
      </TooltipTrigger>
      {renderHoverCard(hoverAnchorId)}
    </Tooltip>
  );
}

function ActivitySectionLabel({
  label,
  onContextMenu,
}: {
  label: string;
  /** Project blocks carry the same right-click menu as a classic project row. */
  onContextMenu?: (position: SidebarRowContextMenuPosition) => void;
}) {
  return (
    <div
      data-slot="activity-section-label"
      className="mb-1.5 px-2"
      {...(onContextMenu
        ? {
            onContextMenu: (event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu({ x: event.clientX, y: event.clientY });
            },
          }
        : {})}
    >
      <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{label}</span>
    </div>
  );
}

/**
 * Collapsible section (Pinned, Earlier, Settled): the same label + inline
 * disclosure chevron the classic "Chats" header uses, with the shared
 * disclosure motion. Section-to-section spacing is owned by the parent list.
 */
function ActivityCollapsibleSection({
  label,
  open,
  onToggle,
  children,
  className,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className={cn(
          "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5",
          SIDEBAR_ROW_FOCUS_CLASS_NAME,
        )}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={cn("min-w-0 truncate", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>{label}</span>
        <DisclosureChevron open={open} className="text-muted-foreground/58" />
      </button>
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>
      </DisclosureRegion>
    </div>
  );
}

/**
 * The header doubles as the activity scope switcher: clicking it opens the
 * project menu, and its label always reflects the currently visible scope.
 */
function ActivityScopeMenu({
  options,
  projectById,
  scopeSelection,
  onChangeScopeSelection,
}: {
  options: ReadonlyArray<ActivityScopeOption>;
  projectById: ReadonlyMap<ProjectId, Project>;
  scopeSelection: ActivityScopeSelection;
  onChangeScopeSelection: (selection: ActivityScopeSelection) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const scopeLabel =
    scopeSelection === null
      ? "All activity"
      : scopeSelection === "chats"
        ? "Synara"
        : resolveThreadProjectLabel(projectById.get(scopeSelection));

  return (
    <Menu onOpenChange={(open) => setMenuOpen(open)}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Filter activity by project"
            className={cn(
              "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md text-left",
              SIDEBAR_ROW_FOCUS_CLASS_NAME,
            )}
          />
        }
      >
        <span
          className={cn(
            "min-w-0 truncate",
            SIDEBAR_SECTION_LABEL_CLASS_NAME,
            scopeSelection !== null && "text-foreground/85",
          )}
        >
          {scopeLabel}
        </span>
        <DisclosureChevron open={menuOpen} className="text-muted-foreground/55" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Activity scope
          </div>
          <MenuRadioGroup
            value={scopeSelection ?? "all"}
            onValueChange={(value) => {
              onChangeScopeSelection(
                value === "all" ? null : value === "chats" ? "chats" : (value as ProjectId),
              );
            }}
          >
            <MenuRadioItem value="all" className="min-h-7 py-1 sm:text-xs">
              All activity
            </MenuRadioItem>
            {options.map((option) => (
              <MenuRadioItem
                key={option.kind === "project" ? option.projectId : "chats"}
                value={option.kind === "project" ? option.projectId : "chats"}
                className="min-h-7 py-1 sm:text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {option.kind === "project"
                    ? resolveThreadProjectLabel(projectById.get(option.projectId))
                    : "Synara"}
                </span>
                <span className="ml-2 shrink-0 tabular-nums text-muted-foreground/60">
                  {option.threadCount}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/**
 * Header filter control: picks how the feed groups its sections (by time or by
 * project) and hosts "Mark all as read" below that choice.
 */
function ActivityFilterMenu({
  groupMode,
  onChangeGroupMode,
  markAllReadDisabled,
  onMarkAllRead,
}: {
  groupMode: ActivityGroupMode;
  onChangeGroupMode: (mode: ActivityGroupMode) => void;
  markAllReadDisabled: boolean;
  onMarkAllRead: () => void;
}) {
  return (
    <Menu>
      <SidebarIconButton
        icon={SortIcon}
        label="Activity options"
        tooltip="Activity options"
        tooltipSide="bottom"
        render={<MenuTrigger />}
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">Group by</div>
          <MenuRadioGroup
            value={groupMode}
            onValueChange={(value) => onChangeGroupMode(value as ActivityGroupMode)}
          >
            <MenuRadioItem value="time" className="min-h-7 py-1 sm:text-xs">
              Time
            </MenuRadioItem>
            <MenuRadioItem value="project" className="min-h-7 py-1 sm:text-xs">
              Project
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          className="min-h-7 py-1 sm:text-xs"
          disabled={markAllReadDisabled}
          onClick={onMarkAllRead}
        >
          Mark all as read
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function ActivityShowMoreRow({
  canShowMore,
  canShowLess,
  hiddenCount,
  pageSize,
  onShowMore,
  onShowLess,
}: {
  canShowMore: boolean;
  canShowLess: boolean;
  /** Rows still hidden; drives the "Show N more (M)" label. */
  hiddenCount: number;
  pageSize: number;
  onShowMore: () => void;
  onShowLess: () => void;
}) {
  if (!canShowMore && !canShowLess) return null;
  const visibleHiddenCount = Math.max(0, hiddenCount);
  const nextPageCount = Math.min(pageSize, visibleHiddenCount);
  const moreLabel =
    nextPageCount > 0 ? `Show ${nextPageCount} more (${visibleHiddenCount})` : "Show more";
  const buttonClassName =
    "h-7 cursor-pointer rounded-lg px-2.5 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:text-foreground";
  return (
    <div className="flex w-full items-center gap-1">
      {canShowMore ? (
        <button type="button" className={cn(buttonClassName, "flex-1")} onClick={onShowMore}>
          {moreLabel}
        </button>
      ) : null}
      {canShowLess ? (
        <button
          type="button"
          className={cn(buttonClassName, canShowMore ? "flex-none" : "flex-1")}
          onClick={onShowLess}
        >
          Show less
        </button>
      ) : null}
    </div>
  );
}

export function SidebarActivityView({
  threads,
  projectById,
  activeThreadId,
  pinnedThreadIdSet,
  settledOverrideByThreadId,
  threadsHydrated,
  resolveThreadStatus,
  onOpenThread,
  onSetThreadSettled,
  onToggleThreadPinned,
  onArchiveThread,
  onMarkThreadRead,
  onRenameThread,
  onThreadRenamePointerUp,
  onThreadContextMenu,
  onProjectContextMenu,
  renderThreadHoverCard,
  prByThreadId,
  threadJumpLabelByThreadId,
  onVisibleThreadIdsChange,
  onCreateChat,
  onAddProject,
  timestampFormat: timestampFormatProp,
  expandedThreadIds: expandedThreadIdsProp,
  collapsedThreadIds: collapsedThreadIdsProp,
  childExtraPagesByParentId: childExtraPagesByParentIdProp,
  onToggleBranch,
  onShowMoreChildren,
  onShowLessChildren,
  sortOrder: sortOrderProp,
}: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
  activeThreadId: ThreadId | null;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId: ReadonlyMap<ThreadId, boolean>;
  threadsHydrated: boolean;
  prByThreadId: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  threadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  onVisibleThreadIdsChange: (threadIds: readonly ThreadId[]) => void;
  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  onOpenThread: (threadId: ThreadId) => void;
  onSetThreadSettled: (threadId: ThreadId, settled: boolean) => void;
  onToggleThreadPinned: (threadId: ThreadId) => void;
  onArchiveThread: (threadId: ThreadId) => void;
  /** Records a completion as seen (the classic sidebar's markThreadVisited). */
  onMarkThreadRead: (threadId: ThreadId, completedAt?: string) => void;
  /** Double-click a row (the classic sidebar's rename gesture). */
  onRenameThread: (threadId: ThreadId) => void;
  /** Touch/pen double-tap fallback for the same rename gesture. */
  onThreadRenamePointerUp: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  /** Right-click a row: the full thread menu, including Copy Thread ID. */
  onThreadContextMenu: (threadId: ThreadId, position: SidebarRowContextMenuPosition) => void;
  /** Right-click a project block header: the same menu a classic project row opens. */
  onProjectContextMenu: (projectId: ProjectId, position: SidebarRowContextMenuPosition) => void;
  /** Same rich hover card the classic thread rows show at the sidebar edge. */
  renderThreadHoverCard: (thread: SidebarThreadSummary, anchorId: string) => ReactNode;
  /** Starts a new chat in the current or most recently used ordinary project. */
  onCreateChat: () => void;
  /** Same "Add project" action the Projects section header runs. */
  onAddProject: () => void;
  /** Clock format for row timestamps; defaults to the app locale setting. */
  timestampFormat?: TimestampFormat;
  /** Shared branch expansion (same set as the normal sidebar). */
  expandedThreadIds?: ReadonlySet<ThreadId>;
  collapsedThreadIds?: ReadonlySet<ThreadId>;
  childExtraPagesByParentId?: ReadonlyMap<ThreadId, number>;
  onToggleBranch?: (threadId: ThreadId, isCurrentlyOpen: boolean) => void;
  onShowMoreChildren?: (parentId: ThreadId) => void;
  onShowLessChildren?: (parentId: ThreadId) => void;
  sortOrder?: SidebarThreadSortOrder;
}) {
  // Default resolved in the body, not the destructuring pattern: an
  // AssignmentPattern in the parameter list makes React Compiler bail out.
  const timestampFormat = timestampFormatProp ?? DEFAULT_TIMESTAMP_FORMAT;
  const expandedThreadIds = expandedThreadIdsProp ?? EMPTY_EXPANDED_THREAD_IDS;
  const collapsedThreadIds = collapsedThreadIdsProp ?? EMPTY_COLLAPSED_THREAD_IDS;
  const childExtraPagesByParentId = childExtraPagesByParentIdProp ?? EMPTY_CHILD_EXTRA_PAGES;
  const sortOrder = sortOrderProp ?? DEFAULT_ACTIVITY_SORT_ORDER;
  const [scopeSelection, setScopeSelection] = useState<ActivityScopeSelection>(null);
  const [groupMode, setGroupMode] = useState<ActivityGroupMode>("time");
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [earlierExtraPages, setEarlierExtraPages] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledExtraPages, setSettledExtraPages] = useState(0);
  const [projectExtraPagesByKey, setProjectExtraPagesByKey] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const isRealProject = (projectId: ProjectId) => projectById.get(projectId)?.kind === "project";
  // Scope menu counts families so a parent with subagents occupies one slot;
  // the menu itself ignores the active scope so it keeps offering every project.
  const scopeOptions = collectActivityScopeOptions(threads, isRealProject, sortOrder);

  const { scope: activeScope, projectFilterIds } = resolveActivityScope(
    scopeSelection,
    scopeOptions,
  );
  useEffect(() => {
    if (scopeSelection !== activeScope) setScopeSelection(activeScope);
  }, [activeScope, scopeSelection]);

  const model = buildActivityViewModel({
    threads,
    pinnedThreadIdSet,
    settledOverrideByThreadId,
    projectFilterIds,
    sortOrder,
  });
  const scopedPinnedFamilies = model.pinned;
  // Mark-all-as-read reaches eligible members in closed branches: it sweeps the
  // current scope's families, not just mounted rows, using individual IDs/times.
  const unreadThreads = collectUnreadActivityFamilyThreads([
    ...model.pinned,
    ...model.active,
    ...model.settled,
  ]);
  const nowMs = Date.now();
  const { priority: priorityFamilies, seen: seenFamilies } = splitPriorityActivityThreads(
    model.active,
  );
  const { recent: recentFamilies, rest: remainingActiveFamilies } = splitRecentActivityThreads(
    seenFamilies,
    { nowMs },
  );
  const dateBuckets = splitActivityThreadsByDateBucket(remainingActiveFamilies, nowMs);
  const projectGroups =
    groupMode === "project"
      ? groupActivityThreadsByProject(model.active, isRealProject, { nowMs })
      : EMPTY_PROJECT_GROUPS;

  const earlierPaging = resolveSidebarThreadListPaging({
    totalCount: dateBuckets.earlier.length,
    baseLimit: ACTIVITY_LIST_BASE_LIMIT,
    pageSize: ACTIVITY_LIST_PAGE_SIZE,
    requestedExtraPages: earlierExtraPages,
  });
  const settledPaging = resolveSidebarThreadListPaging({
    totalCount: model.settled.length,
    baseLimit: ACTIVITY_LIST_BASE_LIMIT,
    pageSize: ACTIVITY_LIST_PAGE_SIZE,
    requestedExtraPages: settledExtraPages,
  });
  const familyByThreadId = useMemo(() => {
    const byThreadId = new Map<ThreadId, ActivityFamily>();
    for (const family of [...model.pinned, ...model.active, ...model.settled]) {
      for (const thread of family.threads) {
        if (!byThreadId.has(thread.id)) byThreadId.set(thread.id, family);
      }
    }
    return byThreadId;
  }, [model.active, model.pinned, model.settled]);

  // Transient section reveal: navigating to a child hidden by a closed
  // Activity section opens that section without changing the chosen scope.
  // A manual close afterwards stays valid until the active thread changes.
  useEffect(() => {
    if (activeThreadId === null) return;
    const family = familyByThreadId.get(activeThreadId);
    if (!family) return;
    const isIn = (families: readonly ActivityFamily[]) =>
      families.some((entry) => entry.rootId === family.rootId);
    if (isIn(model.pinned) && !pinnedOpen) setPinnedOpen(true);
    if (isIn(dateBuckets.earlier) && !earlierOpen) setEarlierOpen(true);
    if (isIn(model.settled) && !settledOpen) setSettledOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  const pagedProjectGroups = projectGroups.map((group) => {
    const paging = resolveSidebarThreadListPaging({
      totalCount: group.families.length,
      baseLimit: ACTIVITY_LIST_BASE_LIMIT,
      pageSize: ACTIVITY_LIST_PAGE_SIZE,
      requestedExtraPages: projectExtraPagesByKey.get(group.key) ?? 0,
    });
    const { visibleFamilies } = getVisibleFamiliesForPreview({
      families: group.families,
      activeThreadId,
      familyByThreadId,
      previewLimit: paging.previewLimit,
    });
    return {
      group,
      paging,
      families: visibleFamilies,
      hasHiddenFamilies: visibleFamilies.length < group.families.length || paging.canShowMore,
    };
  });

  const visibleEarlierFamilies = getVisibleFamiliesForPreview({
    families: dateBuckets.earlier,
    activeThreadId,
    familyByThreadId,
    previewLimit: earlierPaging.previewLimit,
  }).visibleFamilies;
  const visibleSettledFamilies = getVisibleFamiliesForPreview({
    families: model.settled,
    activeThreadId,
    familyByThreadId,
    previewLimit: settledPaging.previewLimit,
  }).visibleFamilies;

  const visibleThreadIds = useMemo(
    () =>
      collectVisibleActivityThreadIds({
        groupMode,
        pinnedOpen,
        pinned: scopedPinnedFamilies,
        priority: priorityFamilies,
        recent: recentFamilies,
        today: dateBuckets.today,
        yesterday: dateBuckets.yesterday,
        earlierOpen,
        earlier: visibleEarlierFamilies,
        projectGroups: pagedProjectGroups.map((group) => group.families),
        settledOpen,
        settled: visibleSettledFamilies,
        expandedThreadIds,
        collapsedThreadIds,
        childExtraPagesByParentId,
        forceVisibleThreadId: activeThreadId ?? undefined,
      }),
    [
      activeThreadId,
      childExtraPagesByParentId,
      collapsedThreadIds,
      dateBuckets.today,
      dateBuckets.yesterday,
      earlierOpen,
      expandedThreadIds,
      groupMode,
      pagedProjectGroups,
      pinnedOpen,
      priorityFamilies,
      recentFamilies,
      scopedPinnedFamilies,
      settledOpen,
      visibleEarlierFamilies,
      visibleSettledFamilies,
    ],
  );
  const visibleThreadIdsFingerprint = visibleThreadIds.join("\0");
  const visibleThreadIdsRef = useRef(visibleThreadIds);
  visibleThreadIdsRef.current = visibleThreadIds;
  useEffect(() => {
    onVisibleThreadIdsChange(visibleThreadIdsRef.current);
  }, [onVisibleThreadIdsChange, visibleThreadIdsFingerprint]);
  useEffect(
    () => () => {
      onVisibleThreadIdsChange([]);
    },
    [onVisibleThreadIdsChange],
  );

  const markAllRead = () => {
    for (const thread of unreadThreads) {
      onMarkThreadRead(thread.id, thread.latestTurn?.completedAt ?? undefined);
    }
  };

  const renderRow = (thread: SidebarThreadSummary, isSettled: boolean) => (
    <ActivityThreadRow
      key={thread.id}
      thread={thread}
      project={projectById.get(thread.projectId)}
      isActive={activeThreadId === thread.id}
      isSettled={isSettled}
      isPinned={pinnedThreadIdSet.has(thread.id)}
      pr={
        // An explicit null from the resolver means the persisted PR was ruled out (e.g. the
        // checkout moved on); falling back to raw lastKnownPr would resurrect that stale
        // badge. Rows not yet covered (revealed by paging a paint before the parent's map
        // catches up) get the same resolution without live status instead.
        prByThreadId.has(thread.id)
          ? (prByThreadId.get(thread.id) ?? null)
          : resolveThreadPullRequestFallback({
              branch: thread.branch,
              hasDedicatedWorktree: thread.worktreePath !== null,
              lastKnownPr: thread.lastKnownPr ?? null,
            })
      }
      status={resolveThreadStatus(thread)}
      threadJumpLabel={threadJumpLabelByThreadId.get(thread.id) ?? null}
      rowTime={formatActivityRowTime({ thread, nowMs, timestampFormat })}
      onOpen={() => onOpenThread(thread.id)}
      onSetSettled={(settled) => {
        if (settled) onMarkThreadRead(thread.id, thread.latestTurn?.completedAt ?? undefined);
        onSetThreadSettled(thread.id, settled);
      }}
      onTogglePinned={() => onToggleThreadPinned(thread.id)}
      onArchive={() => onArchiveThread(thread.id)}
      onRename={onRenameThread}
      onRenamePointerUp={onThreadRenamePointerUp}
      onContextMenu={onThreadContextMenu}
      renderHoverCard={(anchorId) => renderThreadHoverCard(thread, anchorId)}
    />
  );
  function renderBranchChildPaging(
    parentId: ThreadId,
    totalChildCount: number,
    renderedDirectCount: number,
  ) {
    const extraPages = childExtraPagesByParentId.get(parentId) ?? 0;
    const hiddenCount = Math.max(0, totalChildCount - renderedDirectCount);
    if (hiddenCount <= 0 && extraPages <= 0) return null;
    const showCount = Math.min(SIDEBAR_THREAD_HIERARCHY_CHILD_PAGE_SIZE, hiddenCount);
    const buttonClassName =
      "h-6 cursor-pointer rounded-md text-left text-[length:var(--app-font-size-ui,11px)] text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground";
    return (
      <div className="flex w-full min-w-0 items-center gap-1 py-0.5 pr-2">
        {hiddenCount > 0 ? (
          <button
            type="button"
            data-thread-selection-safe
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onShowMoreChildren?.(parentId);
            }}
            className={`${buttonClassName} flex-1 truncate pl-8`}
          >
            Show {showCount} more
          </button>
        ) : null}
        {extraPages > 0 ? (
          <button
            type="button"
            data-thread-selection-safe
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onShowLessChildren?.(parentId);
            }}
            className={
              hiddenCount > 0
                ? `${buttonClassName} flex-none px-2`
                : `${buttonClassName} flex-1 truncate pl-8`
            }
          >
            Show less
          </button>
        ) : null}
      </div>
    );
  }

  function renderNestedFamilyNode(
    node: NestedSidebarEntry<ActivityHierarchyEntry>,
    isSettledRow: (thread: SidebarThreadSummary) => boolean,
  ): ReactNode {
    const { entry } = node;
    const totalChildCount = entry.directChildCount ?? 0;
    const isOpen = node.children.length > 0;
    const threadId = entry.thread.id;
    return (
      <SidebarThreadHierarchyBranch
        key={threadId}
        threadId={threadId}
        title={entry.thread.title}
        depth={entry.depth}
        directChildCount={totalChildCount}
        edgeKind={entry.edgeKind}
        expanded={isOpen}
        onToggle={(id) => onToggleBranch?.(id, isOpen)}
        row={renderRow(entry.thread, isSettledRow(entry.thread))}
        childPaging={
          isOpen
            ? renderBranchChildPaging(threadId, totalChildCount, node.children.length)
            : undefined
        }
        surface="activity"
      >
        {node.children.map((child) => renderNestedFamilyNode(child, isSettledRow))}
      </SidebarThreadHierarchyBranch>
    );
  }

  function renderFamilyBranches(
    families: readonly ActivityFamily[],
    isSettledRow: (thread: SidebarThreadSummary) => boolean,
  ): ReactNode {
    return (
      <ul className="flex w-full min-w-0 flex-col gap-0.5">
        {families.flatMap((family) => {
          const rows = buildProjectThreadTree({
            threads: family.threads,
            forceVisibleThreadId: activeThreadId ?? undefined,
            expandedThreadIds,
            collapsedThreadIds,
            childExtraPagesByParentId,
          });
          const entries: ActivityHierarchyEntry[] = rows.map((row) => ({
            thread: row.thread,
            depth: row.depth,
            directChildCount: row.directChildCount,
            edgeKind: row.edgeKind,
          }));
          return nestSidebarEntriesByDepth(entries).map((node) =>
            renderNestedFamilyNode(node, isSettledRow),
          );
        })}
      </ul>
    );
  }

  const renderActiveFamilyBranches = (families: readonly ActivityFamily[]) =>
    renderFamilyBranches(families, (thread) =>
      isThreadSettledForActivity(thread, settledOverrideByThreadId),
    );

  // The placeholder speaks for the whole surface, so it may only appear when no
  // section has rows — a feed with nothing active but a populated Pinned or Done
  // section is not empty.
  const isEmpty =
    model.active.length === 0 && model.settled.length === 0 && scopedPinnedFamilies.length === 0;
  const emptyLabel =
    activeScope === null
      ? "No activity yet"
      : activeScope === "chats"
        ? "No activity in Synara chats"
        : "No activity for this project";

  return (
    <div className="flex flex-col gap-3">
      {scopedPinnedFamilies.length > 0 ? (
        <ActivityCollapsibleSection
          label="Pinned"
          open={pinnedOpen}
          onToggle={() => setPinnedOpen((open) => !open)}
        >
          {renderFamilyBranches(scopedPinnedFamilies, (thread) =>
            isThreadSettledForActivity(thread, settledOverrideByThreadId),
          )}
        </ActivityCollapsibleSection>
      ) : null}

      {/* `group/project-header` is the marker SidebarSectionToolbar reveals on, so
          the header's create actions fade in exactly like a project row's. */}
      <div className="group/project-header relative flex h-7 items-center gap-1 px-2 py-0.5">
        <ActivityScopeMenu
          options={scopeOptions}
          projectById={projectById}
          scopeSelection={activeScope}
          onChangeScopeSelection={setScopeSelection}
        />
        <SidebarSectionToolbar revealOnHover className="mr-0">
          <SidebarIconButton
            icon={NewThreadIcon}
            label="Start new chat in last used project"
            tooltip="New chat"
            tooltipSide="bottom"
            onClick={onCreateChat}
          />
          <SidebarIconButton
            icon={AddPlusIcon}
            label="Add project"
            tooltip="Add project"
            tooltipSide="bottom"
            onClick={onAddProject}
          />
        </SidebarSectionToolbar>
        <ActivityFilterMenu
          groupMode={groupMode}
          onChangeGroupMode={setGroupMode}
          markAllReadDisabled={unreadThreads.length === 0}
          onMarkAllRead={markAllRead}
        />
      </div>

      {isEmpty ? (
        <div className="px-2 pt-4 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/58">
          {threadsHydrated ? emptyLabel : "Loading activity..."}
        </div>
      ) : groupMode === "project" ? (
        pagedProjectGroups.map(({ group, paging, families: visibleFamilies }) => (
          <div key={group.key}>
            <ActivitySectionLabel
              label={
                group.kind === "chats"
                  ? "Synara"
                  : resolveThreadProjectLabel(projectById.get(group.projectId))
              }
              {...(group.kind === "project"
                ? {
                    onContextMenu: (position: SidebarRowContextMenuPosition) =>
                      onProjectContextMenu(group.projectId, position),
                  }
                : {})}
            />
            <div className="flex flex-col gap-0.5">
              {renderActiveFamilyBranches(visibleFamilies)}
              <ActivityShowMoreRow
                canShowMore={paging.canShowMore}
                canShowLess={paging.canShowLess}
                hiddenCount={group.families.length - paging.previewLimit}
                pageSize={ACTIVITY_LIST_PAGE_SIZE}
                onShowMore={() => {
                  setProjectExtraPagesByKey((current) => {
                    const next = new Map(current);
                    next.set(group.key, paging.effectiveExtraPages + 1);
                    return next;
                  });
                }}
                onShowLess={() => {
                  setProjectExtraPagesByKey((current) => {
                    const next = new Map(current);
                    const extraPages = Math.max(0, paging.effectiveExtraPages - 1);
                    if (extraPages === 0) next.delete(group.key);
                    else next.set(group.key, extraPages);
                    return next;
                  });
                }}
              />
            </div>
          </div>
        ))
      ) : (
        <>
          {priorityFamilies.length > 0 || recentFamilies.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Recent" />
              <div className="flex flex-col gap-0.5">
                {renderActiveFamilyBranches(priorityFamilies)}
                {renderActiveFamilyBranches(recentFamilies)}
              </div>
            </div>
          ) : null}
          {dateBuckets.today.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Today" />
              <div className="flex flex-col gap-0.5">
                {renderActiveFamilyBranches(dateBuckets.today)}
              </div>
            </div>
          ) : null}
          {dateBuckets.yesterday.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Yesterday" />
              <div className="flex flex-col gap-0.5">
                {renderActiveFamilyBranches(dateBuckets.yesterday)}
              </div>
            </div>
          ) : null}
          {dateBuckets.earlier.length > 0 ? (
            <ActivityCollapsibleSection
              label="Earlier"
              open={earlierOpen}
              onToggle={() => setEarlierOpen((open) => !open)}
            >
              {renderActiveFamilyBranches(visibleEarlierFamilies)}
              <ActivityShowMoreRow
                canShowMore={earlierPaging.canShowMore}
                canShowLess={earlierPaging.canShowLess}
                hiddenCount={dateBuckets.earlier.length - earlierPaging.previewLimit}
                pageSize={ACTIVITY_LIST_PAGE_SIZE}
                onShowMore={() => setEarlierExtraPages(earlierPaging.effectiveExtraPages + 1)}
                onShowLess={() =>
                  setEarlierExtraPages(Math.max(0, earlierPaging.effectiveExtraPages - 1))
                }
              />
            </ActivityCollapsibleSection>
          ) : null}
        </>
      )}

      {model.settled.length > 0 ? (
        <ActivityCollapsibleSection
          label="Done"
          open={settledOpen}
          onToggle={() => setSettledOpen((open) => !open)}
        >
          {renderFamilyBranches(visibleSettledFamilies, () => true)}
          <ActivityShowMoreRow
            canShowMore={settledPaging.canShowMore}
            canShowLess={settledPaging.canShowLess}
            hiddenCount={model.settled.length - settledPaging.previewLimit}
            pageSize={ACTIVITY_LIST_PAGE_SIZE}
            onShowMore={() => setSettledExtraPages(settledPaging.effectiveExtraPages + 1)}
            onShowLess={() =>
              setSettledExtraPages(Math.max(0, settledPaging.effectiveExtraPages - 1))
            }
          />
        </ActivityCollapsibleSection>
      ) : null}
    </div>
  );
}
