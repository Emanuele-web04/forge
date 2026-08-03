// FILE: SidebarActivityView.tsx
// Purpose: Task-feed sidebar surface — every thread is a 2-line task row
//          (provider + title / project + branch) grouped by status, with settle.
// Layer: Sidebar UI component
// Exports: SidebarActivityView

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type { OrchestrationThreadPullRequest, ProjectId, ThreadId } from "@synara/contracts";

import {
  AddPlusIcon,
  CircleCheckIcon,
  GitBranchIcon,
  NewThreadIcon,
  SortIcon,
  Undo2Icon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  sidebarHoverRevealHideClassName,
} from "../sidebarRowStyles";
import type { Project, SidebarThreadSummary } from "../types";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon } from "./ProviderIcon";
import { PrStateChip } from "./pullRequest/PrStateChip";
import {
  createSidebarThreadHoverAnchorId,
  resolveSidebarThreadListPaging,
  resolveThreadProjectLabel,
  resolveThreadStatusTrailingIndicator,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  groupActivityThreadsByProject,
  isThreadSettledForActivity,
  resolveActivityScope,
  splitActivityThreadsByDateBucket,
  splitPriorityActivityThreads,
  splitRecentActivityThreads,
  type ActivityGroupMode,
  type ActivityProjectGroup,
  type ActivityScopeOption,
  type ActivityScopeSelection,
} from "./SidebarActivityView.logic";
import { SIDEBAR_TRAILING_ICON_CLASS, sidebarGlyphClass } from "./sidebarGlyphs";
import { SIDEBAR_HOVER_CARD_TRIGGER_PROPS } from "./sidebarHoverCardStyles";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
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
  onOpen,
  onSetSettled,
  onTogglePinned,
  onArchive,
  renderHoverCard,
}: {
  thread: SidebarThreadSummary;
  project: Project | undefined;
  isActive: boolean;
  isSettled: boolean;
  isPinned: boolean;
  pr: OrchestrationThreadPullRequest | null;
  status: ThreadStatusPill | null;
  onOpen: () => void;
  onSetSettled: (settled: boolean) => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  renderHoverCard: (anchorId: string) => ReactNode;
}) {
  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const branch = thread.associatedWorktreeBranch?.trim() || thread.branch?.trim() || null;
  const hoverAnchorId = createSidebarThreadHoverAnchorId({
    scope: "activity",
    threadId: thread.id,
  });
  const actionToneClassName = "text-muted-foreground/42";
  // One trailing slot, top-right, shared by every status: the accent dot for an
  // unread completion and the running spinner (or state dot) for everything
  // else — same rule and same glyphs the classic thread/project rows use.
  const trailingStatus = resolveThreadStatusTrailingIndicator({ status, isActive });

  return (
    <Tooltip>
      <TooltipTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <div
            data-thread-hover-anchor={hoverAnchorId}
            className="group/activity-row relative"
            data-thread-item
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
            isSettled && "opacity-55 transition-opacity hover:opacity-85",
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-hidden pr-5 transition-[padding] duration-150 ease-out",
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
            <FolderClosed
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
            </span>
          </span>
        </button>
        {trailingStatus ? (
          <span
            data-slot="activity-completion-status"
            className={cn(
              "pointer-events-none absolute top-1 right-1 inline-flex size-5 items-center justify-center",
              sidebarHoverRevealHideClassName("activity-row"),
            )}
          >
            <SidebarStatusTrailingGlyph status={trailingStatus} />
          </span>
        ) : null}
        <span className="absolute top-1 right-1 inline-flex items-center gap-1 opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100">
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

function ActivitySectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-1.5 px-2">
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
  onShowMore,
  onShowLess,
}: {
  canShowMore: boolean;
  canShowLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
}) {
  if (!canShowMore && !canShowLess) return null;
  const buttonClassName =
    "h-7 cursor-pointer rounded-lg px-2.5 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79 hover:text-foreground";
  return (
    <div className="flex w-full items-center gap-1">
      {canShowMore ? (
        <button type="button" className={cn(buttonClassName, "flex-1")} onClick={onShowMore}>
          Show more
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
  renderThreadHoverCard,
  prByThreadId,
  onVisibleThreadIdsChange,
  onCreateChat,
  onAddProject,
}: {
  threads: readonly SidebarThreadSummary[];
  projectById: ReadonlyMap<ProjectId, Project>;
  activeThreadId: ThreadId | null;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId: ReadonlyMap<ThreadId, boolean>;
  threadsHydrated: boolean;
  prByThreadId: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  onVisibleThreadIdsChange: (threadIds: readonly ThreadId[]) => void;
  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  onOpenThread: (threadId: ThreadId) => void;
  onSetThreadSettled: (threadId: ThreadId, settled: boolean) => void;
  onToggleThreadPinned: (threadId: ThreadId) => void;
  onArchiveThread: (threadId: ThreadId) => void;
  /** Records a completion as seen (the classic sidebar's markThreadVisited). */
  onMarkThreadRead: (threadId: ThreadId, completedAt?: string) => void;
  /** Same rich hover card the classic thread rows show at the sidebar edge. */
  renderThreadHoverCard: (thread: SidebarThreadSummary, anchorId: string) => ReactNode;
  /** Starts a new chat in the current or most recently used ordinary project. */
  onCreateChat: () => void;
  /** Same "Add project" action the Projects section header runs. */
  onAddProject: () => void;
}) {
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
  // Scope options and the unread sweep intentionally ignore the active scope:
  // the menu must keep offering every project, and "Mark all as read" means all.
  const scopeOptions = collectActivityScopeOptions(threads, isRealProject);
  const unreadThreads = collectUnreadActivityThreads(threads);

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
  });
  const scopedPinnedThreads = model.pinned;
  const nowMs = Date.now();
  const { priority: priorityThreads, seen: seenThreads } = splitPriorityActivityThreads(
    model.active,
  );
  const { recent: recentThreads, rest: remainingActiveThreads } = splitRecentActivityThreads(
    seenThreads,
    { nowMs },
  );
  const dateBuckets = splitActivityThreadsByDateBucket(remainingActiveThreads, nowMs);
  const projectGroups =
    groupMode === "project"
      ? groupActivityThreadsByProject(model.active, isRealProject)
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
  const pagedProjectGroups = projectGroups.map((group) => {
    const paging = resolveSidebarThreadListPaging({
      totalCount: group.threads.length,
      baseLimit: ACTIVITY_LIST_BASE_LIMIT,
      pageSize: ACTIVITY_LIST_PAGE_SIZE,
      requestedExtraPages: projectExtraPagesByKey.get(group.key) ?? 0,
    });
    return {
      group,
      paging,
      threads: group.threads.slice(0, paging.previewLimit),
    };
  });

  const visibleThreadIds = useMemo(
    () =>
      collectVisibleActivityThreadIds({
        groupMode,
        pinnedOpen,
        pinned: scopedPinnedThreads,
        priority: priorityThreads,
        recent: recentThreads,
        today: dateBuckets.today,
        yesterday: dateBuckets.yesterday,
        earlierOpen,
        earlier: dateBuckets.earlier.slice(0, earlierPaging.previewLimit),
        projectGroups: pagedProjectGroups.map((group) => group.threads),
        settledOpen,
        settled: model.settled.slice(0, settledPaging.previewLimit),
      }),
    [
      dateBuckets.earlier,
      dateBuckets.today,
      dateBuckets.yesterday,
      earlierOpen,
      earlierPaging.previewLimit,
      groupMode,
      model.settled,
      pagedProjectGroups,
      pinnedOpen,
      priorityThreads,
      recentThreads,
      scopedPinnedThreads,
      settledOpen,
      settledPaging.previewLimit,
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
      pr={prByThreadId.get(thread.id) ?? thread.lastKnownPr ?? null}
      status={resolveThreadStatus(thread)}
      onOpen={() => onOpenThread(thread.id)}
      onSetSettled={(settled) => {
        if (settled) onMarkThreadRead(thread.id, thread.latestTurn?.completedAt ?? undefined);
        onSetThreadSettled(thread.id, settled);
      }}
      onTogglePinned={() => onToggleThreadPinned(thread.id)}
      onArchive={() => onArchiveThread(thread.id)}
      renderHoverCard={(anchorId) => renderThreadHoverCard(thread, anchorId)}
    />
  );
  const renderActiveRow = (thread: SidebarThreadSummary) =>
    renderRow(thread, isThreadSettledForActivity(thread, settledOverrideByThreadId));

  // The placeholder speaks for the whole surface, so it may only appear when no
  // section has rows — a feed with nothing active but a populated Pinned or Done
  // section is not empty.
  const isEmpty =
    model.active.length === 0 && model.settled.length === 0 && scopedPinnedThreads.length === 0;
  const emptyLabel =
    activeScope === null
      ? "No activity yet"
      : activeScope === "chats"
        ? "No activity in Synara chats"
        : "No activity for this project";

  return (
    <div className="flex flex-col gap-3">
      {scopedPinnedThreads.length > 0 ? (
        <ActivityCollapsibleSection
          label="Pinned"
          open={pinnedOpen}
          onToggle={() => setPinnedOpen((open) => !open)}
        >
          {scopedPinnedThreads.map((thread) =>
            renderRow(thread, isThreadSettledForActivity(thread, settledOverrideByThreadId)),
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
        pagedProjectGroups.map(({ group, paging, threads: visibleThreads }) => (
          <div key={group.key}>
            <ActivitySectionLabel
              label={
                group.kind === "chats"
                  ? "Synara"
                  : resolveThreadProjectLabel(projectById.get(group.projectId))
              }
            />
            <div className="flex flex-col gap-0.5">
              {visibleThreads.map(renderActiveRow)}
              <ActivityShowMoreRow
                canShowMore={paging.canShowMore}
                canShowLess={paging.canShowLess}
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
          {priorityThreads.length > 0 || recentThreads.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Recent" />
              <div className="flex flex-col gap-0.5">
                {priorityThreads.map(renderActiveRow)}
                {recentThreads.map(renderActiveRow)}
              </div>
            </div>
          ) : null}
          {dateBuckets.today.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Today" />
              <div className="flex flex-col gap-0.5">{dateBuckets.today.map(renderActiveRow)}</div>
            </div>
          ) : null}
          {dateBuckets.yesterday.length > 0 ? (
            <div>
              <ActivitySectionLabel label="Yesterday" />
              <div className="flex flex-col gap-0.5">
                {dateBuckets.yesterday.map(renderActiveRow)}
              </div>
            </div>
          ) : null}
          {dateBuckets.earlier.length > 0 ? (
            <ActivityCollapsibleSection
              label="Earlier"
              open={earlierOpen}
              onToggle={() => setEarlierOpen((open) => !open)}
            >
              {dateBuckets.earlier.slice(0, earlierPaging.previewLimit).map(renderActiveRow)}
              <ActivityShowMoreRow
                canShowMore={earlierPaging.canShowMore}
                canShowLess={earlierPaging.canShowLess}
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
          {model.settled
            .slice(0, settledPaging.previewLimit)
            .map((thread) => renderRow(thread, true))}
          <ActivityShowMoreRow
            canShowMore={settledPaging.canShowMore}
            canShowLess={settledPaging.canShowLess}
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
