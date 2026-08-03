// FILE: Sidebar.logic.ts
// Purpose: Shared sidebar sorting and status helpers used by the thread list UI.
// Exports: Sidebar row state derivation, add-project error helpers, sort utilities, and visibility helpers.

import {
  MAX_PINNED_PROJECTS,
  type KeybindingCommand,
  type ProjectId,
  type PullRequestReviewRequestCountResult,
  type ThreadId,
} from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { resolveThreadEnvironmentMode } from "@synara/shared/threadEnvironment";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "../appSettings";
import { resolveRestorableThreadRoute, type LastThreadRoute } from "../chatRouteRestore";
import type { ChatMessage, Project, SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import {
  derivePinnedIds,
  getPinnedItems,
  isLatestPinMutation,
  orderPinnedItemsFirst,
} from "../pinning.logic";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../sidebarRowStyles";
import { isDuplicateProjectCreateError } from "../lib/projectCreateRecovery";
import {
  canSessionAnswerPendingRequests,
  hasLiveLatestTurn,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";

export {
  extractDuplicateProjectCreateProjectId,
  isDuplicateProjectCreateError,
} from "../lib/projectCreateRecovery";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export const DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY = "synara:show-debug-feature-flags-menu";
export type SidebarNewThreadEnvMode = "local" | "worktree";
export type SidebarView = "threads" | "studio";
export type SidebarActionBadge = {
  readonly text: string;
  readonly accessibleLabel: string;
};

export function isProjectsSidebarSurface(input: {
  readonly isOnSettings: boolean;
  readonly isOnStudio: boolean;
}): boolean {
  return !input.isOnSettings && !input.isOnStudio;
}

/** Keep partial review counts visible without presenting them as exact. */
export function resolvePullRequestReviewBadge(
  result: PullRequestReviewRequestCountResult | undefined,
): SidebarActionBadge | null {
  if (!result) return null;
  if (result.incomplete) {
    return result.count > 0
      ? {
          text: `${result.count}+`,
          accessibleLabel: `At least ${result.count} ${pluralize(
            result.count,
            "pull request is",
            "pull requests are",
          )} waiting for your review`,
        }
      : null;
  }
  return result.count > 0
    ? {
        text: String(result.count),
        accessibleLabel: `${result.count} ${pluralize(
          result.count,
          "pull request is",
          "pull requests are",
        )} waiting for your review`,
      }
    : null;
}

/** Stable repository-resolution input for PR caches. Sidebar-only presentation changes such as
 * expand/collapse and ordering do not invalidate; project roots/names do. */
export function pullRequestRepositoryConfigFingerprint(
  projects: ReadonlyArray<Pick<Project, "id" | "kind" | "cwd" | "name" | "remoteName">>,
): string {
  return JSON.stringify(
    projects
      .filter((project) => project.kind === "project")
      .map((project) => [project.id, project.cwd, project.name, project.remoteName] as const)
      .toSorted((left, right) => left[0].localeCompare(right[0])),
  );
}

type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type SidebarThreadSortInput = {
  createdAt: string;
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null | undefined;
  messages?: ReadonlyArray<Pick<ChatMessage, "role" | "createdAt">> | undefined;
  // Present on real thread summaries; lets finished-but-unseen threads float to
  // the top of the sort (see sortThreadsForSidebar). Optional so minimal test
  // fixtures and legacy shapes keep plain timestamp ordering.
  latestTurn?: Thread["latestTurn"] | undefined;
  lastVisitedAt?: Thread["lastVisitedAt"] | undefined;
  hasLiveTailWork?: boolean | undefined;
  session?: Thread["session"] | undefined;
};

function nonEmptyDisplayValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function differentDisplayValue(
  value: string | null | undefined,
  existing: string | null,
): string | null {
  const normalized = nonEmptyDisplayValue(value);
  if (!normalized) {
    return null;
  }
  return existing !== null && normalized === existing ? null : normalized;
}

/**
 * Display label for the container a thread lives in: real projects show their
 * user-facing name, while project-less containers (home chats, studio) read as
 * the app itself. Single rule shared by the Activity rows, pinned-row
 * suffixes, and thread hover cards, so a chat's auto-generated slug folder
 * never leaks into the UI as a fake "project name".
 */
export function resolveThreadProjectLabel(
  project: Pick<Project, "kind" | "name" | "folderName"> | null | undefined,
): string {
  if (!project || project.kind !== "project") {
    return "Synara";
  }
  return nonEmptyDisplayValue(project.name) ?? project.folderName;
}

export type SidebarThreadHoverMetadata = {
  projectName: string;
  projectCwd: string | null;
  sourceProjectName: string | null;
  branch: string | null;
  worktreeName: string | null;
};

export function resolveThreadHoverCardMetadata(input: {
  thread: Pick<
    SidebarThreadSummary,
    "envMode" | "branch" | "worktreePath" | "associatedWorktreePath" | "associatedWorktreeBranch"
  >;
  project: Pick<Project, "kind" | "name" | "folderName" | "cwd"> | null;
}): SidebarThreadHoverMetadata {
  const projectName = resolveThreadProjectLabel(input.project);
  const activeWorktreePath = nonEmptyDisplayValue(input.thread.worktreePath);
  const isWorktree =
    resolveThreadEnvironmentMode({
      envMode: input.thread.envMode,
      worktreePath: activeWorktreePath,
    }) === "worktree";
  const associatedWorktreePath = nonEmptyDisplayValue(input.thread.associatedWorktreePath);
  const worktreePath = isWorktree ? (associatedWorktreePath ?? activeWorktreePath) : null;

  return {
    projectName,
    projectCwd: input.project?.cwd ?? null,
    sourceProjectName: isWorktree
      ? differentDisplayValue(input.project?.folderName, projectName)
      : null,
    branch:
      nonEmptyDisplayValue(input.thread.associatedWorktreeBranch) ??
      nonEmptyDisplayValue(input.thread.branch),
    worktreeName: worktreePath ? formatWorktreePathForDisplay(worktreePath) : null,
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]"
  );
}

export function shouldShowDebugFeatureFlagsMenu(input: {
  readonly isDev: boolean;
  readonly hostname: string;
  readonly storageValue: string | null;
}): boolean {
  return input.isDev && isLoopbackHostname(input.hostname) && input.storageValue === "true";
}

export type SidebarProjectEntry = {
  kind: "thread";
  rowId: ThreadId;
  rootRowId: ThreadId;
  thread: SidebarThreadSummary;
  depth: number;
};

export type SidebarThreadHoverAnchorScope = "pinned" | "chat" | "project" | "activity";

export function createSidebarThreadHoverAnchorId(input: {
  scope: SidebarThreadHoverAnchorScope;
  threadId: ThreadId;
}): string {
  return `${input.scope}:${input.threadId}`;
}

export type SidebarDerivedProjectData = {
  allProjectThreadCount: number;
  projectThreads: SidebarThreadSummary[];
  orderedProjectThreadIds: ThreadId[];
  visibleEntries: SidebarProjectEntry[];
  /** Extra "Show more" pages currently applied, clamped to the real row count. */
  threadListExtraPages: number;
  canShowMoreThreads: boolean;
  canShowLessThreads: boolean;
  activeEntryId: ThreadId | null;
  projectStatus: ReturnType<typeof resolveProjectStatusIndicator>;
};

const THREAD_JUMP_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const satisfies readonly KeybindingCommand[];

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  dismissible?: boolean;
  dismissalKey?: string;
}

/**
 * A status that still asks something of the user or is producing output right
 * now. Surfaces that dim finished work (the Activity Done section) keep showing
 * these pills, so a thread that restarts or asks for approval stays visible.
 */
export function isUrgentThreadStatusPill(pill: ThreadStatusPill): boolean {
  return pill.label !== "Completed";
}

/**
 * Which status — if any — a sidebar row shows in its trailing glyph slot.
 * Single owner of the visibility rule so the classic thread rows, the collapsed
 * project rows and the Activity rows can never disagree about when a spinner or
 * an unread-completion dot is on screen; only the surface-specific suppressions
 * are passed in.
 *
 * - `slotOccupied`: another affordance owns the slot right now (e.g. the thread
 *   jump shortcut label), so the status stays hidden until it clears.
 * - `isActive`: the row's thread is open, so a completion the user is already
 *   looking at is not advertised as unread.
 *
 * Every other status still asks something of the user (or is live work), so it
 * survives even on a dimmed/settled row.
 */
export function resolveThreadStatusTrailingIndicator(input: {
  status: ThreadStatusPill | null;
  slotOccupied?: boolean;
  isActive?: boolean;
}): ThreadStatusPill | null {
  const { status } = input;
  if (status === null || input.slotOccupied === true) {
    return null;
  }
  if (status.label === "Completed" && input.isActive === true) {
    return null;
  }
  return status;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "session" | "updatedAt"
> & {
  proposedPlans?: Thread["proposedPlans"] | undefined;
  hasActionableProposedPlan?: boolean | undefined;
  hasLiveTailWork?: boolean | undefined;
  dismissedStatusKey?: string | undefined;
};

function createThreadStatusDismissalKey(
  label: Extract<ThreadStatusPill["label"], "Pending Approval" | "Awaiting Input" | "Plan Ready">,
  thread: ThreadStatusInput,
): string {
  return [
    label,
    thread.updatedAt ?? "",
    thread.latestTurn?.turnId ?? "",
    thread.latestTurn?.completedAt ?? "",
    thread.session?.updatedAt ?? "",
  ].join(":");
}

function createCompletedDismissalKey(thread: ThreadStatusInput): string | null {
  if (!thread.latestTurn?.completedAt) {
    return null;
  }

  return ["Completed", thread.latestTurn.turnId, thread.latestTurn.completedAt].join(":");
}

export function hasUnseenCompletion(thread: Pick<Thread, "latestTurn" | "lastVisitedAt">): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export type SettingsBackTarget =
  | {
      kind: "thread";
      threadId: string;
      splitViewId?: string | undefined;
    }
  | {
      kind: "home";
    };

export function resolveSettingsBackTarget(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadIds: ReadonlySet<string>;
  latestThreadId: string | null;
  availableSplitViewIds?: ReadonlySet<string>;
}): SettingsBackTarget {
  const restorableRoute = resolveRestorableThreadRoute({
    lastThreadRoute: input.lastThreadRoute,
    availableThreadIds: input.availableThreadIds,
    ...(input.availableSplitViewIds ? { availableSplitViewIds: input.availableSplitViewIds } : {}),
  });

  if (restorableRoute) {
    return {
      kind: "thread",
      threadId: restorableRoute.threadId,
      splitViewId: restorableRoute.splitViewId,
    };
  }

  if (input.latestThreadId) {
    return {
      kind: "thread",
      threadId: input.latestThreadId,
    };
  }

  return { kind: "home" };
}

// Drops remembered "show more" paging for projects that are currently collapsed.
export function pruneProjectThreadListPagingForCollapsedProjects<
  T extends Pick<Project, "cwd" | "expanded">,
>(input: {
  threadListExtraPagesByProjectCwd: ReadonlyMap<string, number>;
  projects: readonly T[];
  normalizeProjectCwd: (cwd: string) => string;
}): ReadonlyMap<string, number> {
  const { normalizeProjectCwd, projects, threadListExtraPagesByProjectCwd } = input;
  const collapsedProjectCwds = new Set(
    projects
      .filter((project) => !project.expanded)
      .map((project) => normalizeProjectCwd(project.cwd))
      .filter((cwd) => cwd.length > 0),
  );

  if (collapsedProjectCwds.size === 0) {
    return threadListExtraPagesByProjectCwd;
  }

  let changed = false;
  const nextThreadListExtraPagesByProjectCwd = new Map<string, number>();
  for (const [cwd, extraPages] of threadListExtraPagesByProjectCwd) {
    if (collapsedProjectCwds.has(cwd)) {
      changed = true;
      continue;
    }
    nextThreadListExtraPagesByProjectCwd.set(cwd, extraPages);
  }

  return changed ? nextThreadListExtraPagesByProjectCwd : threadListExtraPagesByProjectCwd;
}

/**
 * Trailing padding that protects the title from the absolutely-positioned
 * trailing cluster, sized to what the slot ACTUALLY shows so the title runs as
 * far right as the on-screen content allows:
 *
 * - The relative time now lives in the row hover card, so an idle row with no
 *   status/jump glyph and no meta chips reserves almost nothing — the title runs
 *   to the row edge instead of truncating against permanently reserved space.
 * - A status/loader (or keyboard-jump) glyph occupies a ~2.25rem slot, and each
 *   fork/worktree/handoff meta chip adds width; the reserve grows only for the
 *   badges that are present.
 * - The wider reserve that clears the hover pin/archive actions is applied only
 *   on hover/focus (mirroring the project header row), so the title gives up that
 *   width exactly when those actions appear and not a moment sooner.
 *
 * Literal class strings are required so Tailwind's JIT scanner emits them.
 */
export function resolveThreadRowTrailingReserveClass(input: {
  metaChipCount: number;
  hasTrailingGlyph: boolean;
}): string {
  // Hover/focus reveals the pin/archive actions; the meta chips + glyph fade out
  // at the same time, so the hover reserve is constant regardless of rest content.
  const hoverReserve =
    "transition-[padding] duration-150 ease-out group-hover/thread-row:pr-[4.75rem] group-focus-within/thread-row:pr-[4.75rem]";
  const { metaChipCount, hasTrailingGlyph } = input;
  if (metaChipCount <= 0) {
    return cn(hasTrailingGlyph ? "pr-[1.75rem]" : "pr-2", hoverReserve);
  }
  if (metaChipCount === 1) {
    return cn(hasTrailingGlyph ? "pr-[3rem]" : "pr-[1.75rem]", hoverReserve);
  }
  if (metaChipCount === 2) {
    return cn(hasTrailingGlyph ? "pr-[4rem]" : "pr-[3rem]", hoverReserve);
  }
  return cn(hasTrailingGlyph ? "pr-[4.5rem]" : "pr-[4.25rem]", hoverReserve);
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  // Trailing reserve for the absolute cluster is applied separately by callers
  // via resolveThreadRowTrailingReserveClass so it can flex with the chip count.
  const baseClassName = SIDEBAR_THREAD_ROW_BASE_CLASS_NAME;

  if (input.isSelected && input.isActive) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  if (input.isSelected) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  if (input.isActive) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  return cn(baseClassName, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME);
}

// Single definition of "this thread is actively doing work" shared by the
// Working status pill and the sidebar sort, so a thread's position and its
// pill never disagree.
export function isThreadActivelyWorking(thread: {
  hasLiveTailWork?: boolean | undefined;
  session?: Thread["session"] | undefined;
  latestTurn?: Thread["latestTurn"] | undefined;
}): boolean {
  if (thread.hasLiveTailWork === true) {
    return true;
  }
  const session = thread.session ?? null;
  return (
    session?.status === "running" &&
    (thread.latestTurn == null || hasLiveLatestTurn(thread.latestTurn, session))
  );
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { thread } = input;
  // A dead session can't receive approval/input answers anymore — drop the
  // actionable pills instead of advertising a request nobody can fulfill.
  // Mirrored by the kanban board's deriveKanbanColumn.
  const canAnswerPendingRequests = canSessionAnswerPendingRequests(thread.session);
  const hasPendingApprovals = input.hasPendingApprovals && canAnswerPendingRequests;
  const hasPendingUserInput = input.hasPendingUserInput && canAnswerPendingRequests;

  if (hasPendingApprovals) {
    const dismissalKey = createThreadStatusDismissalKey("Pending Approval", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (hasPendingUserInput) {
    const dismissalKey = createThreadStatusDismissalKey("Awaiting Input", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (isThreadActivelyWorking(thread)) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    !thread.hasLiveTailWork &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    (thread.hasActionableProposedPlan ??
      hasActionableProposedPlan(
        findLatestProposedPlan(thread.proposedPlans ?? [], thread.latestTurn?.turnId ?? null),
      ));
  if (hasPlanReadyPrompt) {
    const dismissalKey = createThreadStatusDismissalKey("Plan Ready", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (!thread.hasLiveTailWork && hasUnseenCompletion(thread)) {
    const dismissalKey = createCompletedDismissalKey(thread);
    if (dismissalKey && thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
      dismissible: true,
      ...(dismissalKey ? { dismissalKey } : {}),
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function findWorkspaceRootMatch<T>(
  items: readonly T[],
  targetWorkspaceRoot: string,
  getWorkspaceRoot: (item: T) => string,
): T | undefined {
  return items.find((item) => workspaceRootsEqual(getWorkspaceRoot(item), targetWorkspaceRoot));
}

// Finds the item whose workspace root most specifically contains `targetPath`
// (equal to it, or its closest ancestor). Used to attribute a dev server's cwd
// to a project even when it runs from a monorepo subdirectory; the deepest root
// wins so a nested project beats its parent.
export function findDeepestWorkspaceRootMatch<T>(
  items: readonly T[],
  targetPath: string,
  getWorkspaceRoot: (item: T) => string,
): T | undefined {
  let best: T | undefined;
  let bestRootLength = -1;
  for (const item of items) {
    const root = getWorkspaceRoot(item);
    if (!isWorkspaceRootWithin(targetPath, root)) {
      continue;
    }
    if (root.length > bestRootLength) {
      best = item;
      bestRootLength = root.length;
    }
  }
  return best;
}

// Rechecks an existing local project against the server before the add flow decides to reuse it.
export async function recoverExistingAddProjectTarget(input: {
  readonly existingProjectId: ProjectId | null | undefined;
  readonly workspaceRoot: string;
  readonly recoverByProjectId: (projectId: ProjectId) => Promise<boolean>;
  readonly recoverByWorkspaceRoot: (workspaceRoot: string) => Promise<boolean>;
}): Promise<"recovered" | "create"> {
  if (!input.existingProjectId) {
    return "create";
  }

  if (await input.recoverByProjectId(input.existingProjectId)) {
    return "recovered";
  }

  if (await input.recoverByWorkspaceRoot(input.workspaceRoot)) {
    return "recovered";
  }

  return "create";
}

// Translates low-level add-project failures into a short explanation without
// hiding the original error text that developers may need for diagnosis.
export function describeAddProjectError(message: string): string | null {
  if (isDuplicateProjectCreateError(message)) {
    return "This usually means the folder is already linked to an existing project. On Windows, the same folder can arrive with a different path format, so it looks new even when it is not.";
  }

  if (
    message.startsWith("Failed to create project directory: /") ||
    message.startsWith("Project directory does not exist: /")
  ) {
    return "This is an absolute path from the filesystem root. If the folder is in your home directory, use ~/Developer/... or the full /Users/<name>/Developer/... path.";
  }

  return null;
}

// One "Show more" click reveals one extra page of rows; "Show less" hides one page again.
// The requested page count is clamped to what the list can actually use, so stale persisted
// values (or shrinking thread lists) self-heal instead of requiring dead "Show less" clicks.
export type SidebarThreadListPaging = {
  /** Requested pages clamped to what `totalCount` can actually consume. */
  effectiveExtraPages: number;
  /** Row cap to render: `baseLimit + effectiveExtraPages * pageSize`. */
  previewLimit: number;
  canShowMore: boolean;
  canShowLess: boolean;
};

export function resolveSidebarThreadListPaging(input: {
  totalCount: number;
  baseLimit: number;
  pageSize: number;
  requestedExtraPages: number;
}): SidebarThreadListPaging {
  const { baseLimit, pageSize, totalCount } = input;
  const hiddenBeyondBase = Math.max(0, totalCount - baseLimit);
  const maxExtraPages = pageSize > 0 ? Math.ceil(hiddenBeyondBase / pageSize) : 0;
  const requestedExtraPages = Number.isFinite(input.requestedExtraPages)
    ? Math.floor(input.requestedExtraPages)
    : 0;
  const effectiveExtraPages = Math.min(Math.max(0, requestedExtraPages), maxExtraPages);
  const previewLimit = baseLimit + effectiveExtraPages * pageSize;

  return {
    effectiveExtraPages,
    previewLimit,
    canShowMore: totalCount > previewLimit,
    canShowLess: effectiveExtraPages > 0,
  };
}

export function getVisibleThreadsForProject<T extends Pick<SidebarThreadSummary, "id">>(input: {
  threads: readonly T[];
  activeThreadId: Thread["id"] | undefined;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
} {
  const { activeThreadId, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads) {
    return {
      hasHiddenThreads,
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export interface SidebarThreadTreeRow<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
> {
  thread: T;
  depth: number;
  rootThreadId: T["id"];
}

function collectActiveThreadAncestorIds<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
>(threadById: Map<T["id"], T>, forceVisibleThreadId: T["id"] | undefined): Set<T["id"]> {
  const ancestorIds = new Set<T["id"]>();
  let currentThreadId = forceVisibleThreadId;

  while (currentThreadId) {
    const parentThreadId = threadById.get(currentThreadId)?.parentThreadId ?? undefined;
    if (!parentThreadId) {
      break;
    }
    ancestorIds.add(parentThreadId);
    currentThreadId = parentThreadId;
  }

  return ancestorIds;
}

// Build the project-local parent/child thread tree while preserving sort order from the input list.
export function buildProjectThreadTree<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
>(input: {
  threads: readonly T[];
  forceVisibleThreadId?: T["id"] | undefined;
}): SidebarThreadTreeRow<T>[] {
  const { forceVisibleThreadId, threads } = input;
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const childrenByParentId = new Map<T["id"], T[]>();
  const roots: T[] = [];

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (!parentThreadId) {
      roots.push(thread);
      continue;
    }
    // Subagent threads are only reachable through their parent. When the parent
    // is not in the list (archived or deleted), its subtree stays hidden instead
    // of being promoted to top-level rows.
    if (!threadById.has(parentThreadId)) {
      continue;
    }
    const siblings = childrenByParentId.get(parentThreadId) ?? [];
    siblings.push(thread);
    childrenByParentId.set(parentThreadId, siblings);
  }

  const activeThreadAncestorIds = collectActiveThreadAncestorIds(threadById, forceVisibleThreadId);
  const orderedRows: SidebarThreadTreeRow<T>[] = [];

  const visit = (thread: T, depth: number, rootThreadId: T["id"]) => {
    const childThreads = childrenByParentId.get(thread.id) ?? [];
    const revealsActiveDescendant =
      childThreads.length > 0 && activeThreadAncestorIds.has(thread.id);

    orderedRows.push({
      thread,
      depth,
      rootThreadId,
    });

    if (!revealsActiveDescendant) {
      return;
    }

    for (const child of childThreads) {
      visit(child, depth + 1, rootThreadId);
    }
  };

  for (const root of roots) {
    visit(root, 0, root.id);
  }

  return orderedRows;
}

export function getVisibleSidebarEntriesForPreview<
  T extends {
    rowId: Thread["id"];
    rootRowId: Thread["id"];
  },
>(input: {
  entries: readonly T[];
  activeEntryId: Thread["id"] | undefined;
  previewLimit: number;
}): {
  hasHiddenEntries: boolean;
  visibleEntries: T[];
} {
  const { activeEntryId, entries, previewLimit } = input;
  const hasHiddenEntries = entries.length > previewLimit;

  if (!hasHiddenEntries) {
    return {
      hasHiddenEntries,
      visibleEntries: [...entries],
    };
  }

  const previewEntries = entries.slice(0, previewLimit);
  const visibleEntryIds = new Set(previewEntries.map((entry) => entry.rowId));

  if (!activeEntryId || visibleEntryIds.has(activeEntryId)) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  const activeEntryIndex = entries.findIndex((entry) => entry.rowId === activeEntryId);
  if (activeEntryIndex === -1) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  const activeEntry = entries[activeEntryIndex];
  if (!activeEntry) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  const rootEntryIndex = entries.findIndex((entry) => entry.rowId === activeEntry.rootRowId);
  const forcedVisibleEntries =
    rootEntryIndex === -1 ? [activeEntry] : entries.slice(rootEntryIndex, activeEntryIndex + 1);

  for (const entry of forcedVisibleEntries) {
    visibleEntryIds.add(entry.rowId);
  }

  return {
    hasHiddenEntries: true,
    visibleEntries: entries.filter((entry) => visibleEntryIds.has(entry.rowId)),
  };
}

export function getPinnedThreadsForSidebar<T extends Pick<Thread, "id">>(
  threads: readonly T[],
  pinnedThreadIds: readonly T["id"][],
): T[] {
  return getPinnedItems(threads, pinnedThreadIds);
}

// Resolve the visible pinned ids from server state, local legacy pins, and pending user clicks.
export function derivePinnedThreadIdsForSidebar<T extends Pick<Thread, "id" | "isPinned">>(input: {
  readonly threads: readonly T[];
  readonly persistedPinnedThreadIds: readonly T["id"][];
  readonly optimisticPinnedStateByThreadId: ReadonlyMap<T["id"], boolean>;
}): T["id"][] {
  return derivePinnedIds({
    items: input.threads,
    persistedPinnedIds: input.persistedPinnedThreadIds,
    optimisticPinnedStateById: input.optimisticPinnedStateByThreadId,
  });
}

// Only the newest pin mutation may roll back optimistic state after rapid clicks.
export function isLatestPinnedThreadMutation<T>(input: {
  readonly threadId: T;
  readonly requestVersion: number;
  readonly latestMutationVersionByThreadId: ReadonlyMap<T, number>;
}): boolean {
  return isLatestPinMutation({
    id: input.threadId,
    requestVersion: input.requestVersion,
    latestMutationVersionById: input.latestMutationVersionByThreadId,
  });
}

export function isLatestPinnedProjectMutation<T>(input: {
  readonly projectId: T;
  readonly requestVersion: number;
  readonly latestMutationVersionByProjectId: ReadonlyMap<T, number>;
}): boolean {
  return isLatestPinMutation({
    id: input.projectId,
    requestVersion: input.requestVersion,
    latestMutationVersionById: input.latestMutationVersionByProjectId,
  });
}

export function derivePinnedProjectIdsForSidebar<
  T extends Pick<Project, "id" | "isPinned">,
>(input: {
  readonly projects: readonly T[];
  readonly persistedPinnedProjectIds: readonly T["id"][];
  readonly optimisticPinnedStateByProjectId: ReadonlyMap<T["id"], boolean>;
}): T["id"][] {
  return derivePinnedIds({
    items: input.projects,
    persistedPinnedIds: input.persistedPinnedProjectIds,
    optimisticPinnedStateById: input.optimisticPinnedStateByProjectId,
    maxCount: MAX_PINNED_PROJECTS,
  });
}

export function orderPinnedProjectsForSidebar<T extends Pick<Project, "id">>(
  projects: readonly T[],
  pinnedProjectIds: readonly T["id"][],
): T[] {
  return orderPinnedItemsFirst(projects, pinnedProjectIds);
}

// Hide globally pinned rows from the per-project lists so the sidebar doesn't duplicate chats.
// Exception: a pinned parent whose children are in the list stays in the tree.
// The pinned section renders flat rows only, and buildProjectThreadTree hides
// children with a missing parent — hiding such a parent would make its
// descendants unreachable anywhere in the sidebar.
export function getUnpinnedThreadsForSidebar<
  T extends Pick<Thread, "id"> & Partial<Pick<SidebarThreadSummary, "parentThreadId">>,
>(threads: readonly T[], pinnedThreadIds: readonly T["id"][]): T[] {
  if (pinnedThreadIds.length === 0) {
    return [...threads];
  }

  const parentThreadIds = new Set<T["id"]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId !== null) {
      parentThreadIds.add(parentThreadId as T["id"]);
    }
  }

  const hiddenThreadIds = new Set(
    pinnedThreadIds.filter((threadId) => !parentThreadIds.has(threadId)),
  );
  return threads.filter((thread) => !hiddenThreadIds.has(thread.id));
}

// Only prune persisted pins after the thread snapshot has hydrated.
export function shouldPrunePinnedThreads(input: { threadsHydrated: boolean }): boolean {
  return input.threadsHydrated;
}

export type ProjectEmptyState = "loading" | "empty" | null;

// Keep the initial shell bootstrap visually distinct from a genuinely empty project list.
export function resolveProjectEmptyState(input: {
  readonly projectCount: number;
  readonly shouldShowProjectPathEntry: boolean;
  readonly threadsHydrated: boolean;
}): ProjectEmptyState {
  if (input.projectCount > 0 || input.shouldShowProjectPathEntry) {
    return null;
  }

  return input.threadsHydrated ? "empty" : "loading";
}

// Match the exact rows the sidebar renders for one project, including folded previews.
export function getRenderedThreadsForSidebarProject<
  T extends Pick<SidebarThreadSummary, "id"> & SidebarThreadSortInput,
>(input: {
  project: Pick<Project, "expanded">;
  threads: readonly T[];
  activeThreadId: Thread["id"] | undefined;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  renderedThreads: T[];
} {
  const { activeThreadId, previewLimit, project, threads } = input;
  const pinnedCollapsedThread =
    !project.expanded && activeThreadId
      ? (threads.find((thread) => thread.id === activeThreadId) ?? null)
      : null;
  const { hasHiddenThreads, visibleThreads } = getVisibleThreadsForProject({
    threads,
    activeThreadId,
    previewLimit,
  });

  return {
    hasHiddenThreads,
    renderedThreads: pinnedCollapsedThread ? [pinnedCollapsedThread] : visibleThreads,
  };
}

// Flatten the sidebar's current project/thread visibility into the same order the user sees.
export function getVisibleSidebarThreadIds(input: {
  projects: readonly Pick<Project, "id" | "expanded">[];
  threads: readonly (Pick<SidebarThreadSummary, "id" | "projectId" | "parentThreadId"> &
    SidebarThreadSortInput)[];
  activeThreadId: Thread["id"] | undefined;
  threadListExtraPagesByProjectId: ReadonlyMap<Project["id"], number>;
  previewLimit: number;
  previewPageSize: number;
  threadSortOrder: SidebarThreadSortOrder;
}): Thread["id"][] {
  const {
    activeThreadId,
    previewLimit,
    previewPageSize,
    projects,
    threadListExtraPagesByProjectId,
    threadSortOrder,
    threads,
  } = input;
  const visibleThreadIds: Thread["id"][] = [];
  const threadsByProjectId = new Map<ProjectId, (typeof threads)[number][]>();

  for (const thread of threads) {
    const projectThreads = threadsByProjectId.get(thread.projectId);
    if (projectThreads) {
      projectThreads.push(thread);
    } else {
      threadsByProjectId.set(thread.projectId, [thread]);
    }
  }

  for (const project of projects) {
    const projectThreads = sortThreadsForSidebar(
      threadsByProjectId.get(project.id) ?? [],
      threadSortOrder,
    );
    const projectThreadTree = buildProjectThreadTree({
      threads: projectThreads,
      forceVisibleThreadId: activeThreadId,
    });
    const paging = resolveSidebarThreadListPaging({
      totalCount: projectThreadTree.length,
      baseLimit: previewLimit,
      pageSize: previewPageSize,
      requestedExtraPages: threadListExtraPagesByProjectId.get(project.id) ?? 0,
    });
    const { visibleEntries } = getVisibleSidebarEntriesForPreview({
      entries: projectThreadTree.map((row) => ({
        rowId: row.thread.id,
        rootRowId: row.rootThreadId,
        threadId: row.thread.id,
      })),
      activeEntryId: activeThreadId,
      previewLimit: paging.previewLimit,
    });
    const pinnedCollapsedThread =
      !project.expanded && activeThreadId
        ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
        : null;

    if (pinnedCollapsedThread) {
      visibleThreadIds.push(pinnedCollapsedThread.id);
      continue;
    }

    for (const entry of visibleEntries) {
      visibleThreadIds.push(entry.threadId);
    }
  }

  return visibleThreadIds;
}

// Resolve the next sidebar-visible thread for keyboard cycling with wraparound.
export function getNextVisibleSidebarThreadId(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId: Thread["id"] | undefined;
  direction: "forward" | "backward";
}): Thread["id"] | null {
  const { activeThreadId, direction, visibleThreadIds } = input;
  if (visibleThreadIds.length === 0) {
    return null;
  }

  if (!activeThreadId) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const activeIndex = visibleThreadIds.findIndex((threadId) => threadId === activeThreadId);
  if (activeIndex === -1) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const nextIndex =
    direction === "forward"
      ? (activeIndex + 1) % visibleThreadIds.length
      : (activeIndex - 1 + visibleThreadIds.length) % visibleThreadIds.length;

  return visibleThreadIds[nextIndex] ?? null;
}

export function getSidebarThreadIdForJumpCommand(input: {
  visibleThreadIds: readonly Thread["id"][];
  command: string | null;
}): Thread["id"] | null {
  if (!input.command) {
    return null;
  }

  const jumpIndex = THREAD_JUMP_COMMANDS.indexOf(
    input.command as (typeof THREAD_JUMP_COMMANDS)[number],
  );
  if (jumpIndex === -1) {
    return null;
  }

  return input.visibleThreadIds[jumpIndex] ?? null;
}

export function getSidebarThreadIdsToPrewarm(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId?: Thread["id"] | null;
  limit?: number;
  neighborRadius?: number;
}): Thread["id"][] {
  const limit = Math.max(0, input.limit ?? SIDEBAR_THREAD_PREWARM_LIMIT);
  if (limit === 0) {
    return [];
  }
  const prewarmedThreadIds = new Set<Thread["id"]>();
  const neighborRadius = Math.max(0, input.neighborRadius ?? 2);
  const activeIndex =
    input.activeThreadId === undefined || input.activeThreadId === null
      ? -1
      : input.visibleThreadIds.indexOf(input.activeThreadId);

  if (activeIndex >= 0) {
    const start = Math.max(0, activeIndex - neighborRadius);
    const end = Math.min(input.visibleThreadIds.length - 1, activeIndex + neighborRadius);
    for (let index = start; index <= end; index += 1) {
      if (prewarmedThreadIds.size >= limit) {
        break;
      }
      const threadId = input.visibleThreadIds[index];
      if (threadId) {
        prewarmedThreadIds.add(threadId);
      }
    }
  }

  for (const threadId of input.visibleThreadIds) {
    if (prewarmedThreadIds.size >= limit) {
      break;
    }
    prewarmedThreadIds.add(threadId);
  }

  return [...prewarmedThreadIds];
}

function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: SidebarThreadSortInput): number {
  const latestUserMessageAt = toSortableTimestamp(thread.latestUserMessageAt ?? undefined);
  if (latestUserMessageAt !== null) {
    return latestUserMessageAt;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function getThreadSortTimestamp(
  thread: SidebarThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

// A finished chat the user hasn't opened yet floats above the plain timestamp
// order so it gets seen. Opening it (or dismissing its Completed pill, which
// marks it visited) updates lastVisitedAt and the thread falls back into place.
// A thread with live tail work isn't finished, so it stays in plain order.
function isUnseenFinishedThread(thread: SidebarThreadSortInput): boolean {
  if (thread.hasLiveTailWork === true) {
    return false;
  }
  return hasUnseenCompletion({
    latestTurn: thread.latestTurn ?? null,
    lastVisitedAt: thread.lastVisitedAt,
  });
}

// Attention groups for the sidebar order: threads doing live work first so you
// can watch what's going on, then finished-but-unseen ones so they get noticed,
// then everything else by timestamp. Mirrors THREAD_STATUS_PRIORITY, where
// Working/Connecting outrank Completed.
function threadSortAttentionRank(thread: SidebarThreadSortInput): number {
  if (isThreadActivelyWorking(thread) || thread.session?.status === "connecting") {
    return 2;
  }
  if (isUnseenFinishedThread(thread)) {
    return 1;
  }
  return 0;
}

export function sortThreadsForSidebar<T extends { id: Thread["id"] } & SidebarThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return threads.toSorted((left, right) => {
    const byAttentionRank = threadSortAttentionRank(right) - threadSortAttentionRank(left);
    if (byAttentionRank !== 0) return byAttentionRank;
    const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
    const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return right.id.localeCompare(left.id);
  });
}

export function getFallbackThreadIdAfterDelete<
  T extends { id: Thread["id"]; projectId: Thread["projectId"] } & SidebarThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreadsForSidebar(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly SidebarThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends { projectId: Thread["projectId"] } & SidebarThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

// Groups thread summaries once so project-specific sidebar derivations can reuse the same slices.
export function groupSidebarThreadsByProjectId(
  threads: readonly SidebarThreadSummary[],
): ReadonlyMap<ProjectId, SidebarThreadSummary[]> {
  const byProjectId = new Map<ProjectId, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const existing = byProjectId.get(thread.projectId);
    if (existing) {
      existing.push(thread);
    } else {
      byProjectId.set(thread.projectId, [thread]);
    }
  }
  return byProjectId;
}

export function partitionSidebarThreadsByProjectIds<
  T extends Pick<SidebarThreadSummary, "projectId">,
>(
  threads: readonly T[],
  studioProjectIds: ReadonlySet<ProjectId>,
): {
  readonly studioThreads: T[];
  readonly nonStudioThreads: T[];
} {
  const studioThreads: T[] = [];
  const nonStudioThreads: T[] = [];
  for (const thread of threads) {
    if (studioProjectIds.has(thread.projectId)) {
      studioThreads.push(thread);
    } else {
      nonStudioThreads.push(thread);
    }
  }
  return { studioThreads, nonStudioThreads };
}

// Centralizes the expensive per-project row derivation so Sidebar.tsx can mostly orchestrate UI state.
export function deriveSidebarProjectData(input: {
  projects: readonly Pick<Project, "id" | "cwd" | "expanded">[];
  sortedSidebarThreadsByProjectId: ReadonlyMap<ProjectId, SidebarThreadSummary[]>;
  pinnedThreadIds: readonly ThreadId[];
  threadListExtraPagesByProjectCwd: ReadonlyMap<string, number>;
  normalizeProjectCwd: (cwd: string) => string;
  activeSidebarThreadId: ThreadId | undefined;
  previewLimit: number;
  previewPageSize: number;
  resolveThreadStatus?: (
    thread: SidebarThreadSummary,
  ) => ReturnType<typeof resolveThreadStatusPill>;
}): ReadonlyMap<ProjectId, SidebarDerivedProjectData> {
  const byProjectId = new Map<ProjectId, SidebarDerivedProjectData>();

  for (const project of input.projects) {
    const allProjectThreads = input.sortedSidebarThreadsByProjectId.get(project.id) ?? [];
    const projectThreads = getUnpinnedThreadsForSidebar(allProjectThreads, input.pinnedThreadIds);
    const projectStatus = resolveProjectStatusIndicator(
      allProjectThreads.map((thread) =>
        input.resolveThreadStatus
          ? input.resolveThreadStatus(thread)
          : resolveThreadStatusPill({
              thread,
              hasPendingApprovals: thread.hasPendingApprovals,
              hasPendingUserInput: thread.hasPendingUserInput,
            }),
      ),
    );
    const requestedExtraPages =
      input.threadListExtraPagesByProjectCwd.get(input.normalizeProjectCwd(project.cwd)) ?? 0;
    const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);

    // Collapsed folders should not build or render their full tree; large projects can
    // contain hundreds of rows and folder toggles are on the sidebar hot path.
    if (!project.expanded) {
      const activeThread =
        input.activeSidebarThreadId === undefined
          ? null
          : (projectThreads.find((thread) => thread.id === input.activeSidebarThreadId) ?? null);
      const visibleEntries =
        activeThread === null
          ? []
          : [
              {
                kind: "thread" as const,
                rowId: activeThread.id,
                rootRowId: activeThread.id,
                thread: activeThread,
                depth: 0,
              },
            ];

      byProjectId.set(project.id, {
        allProjectThreadCount: allProjectThreads.length,
        projectThreads,
        orderedProjectThreadIds,
        visibleEntries,
        // The thread list is hidden while the folder is closed, so paging affordances are moot.
        threadListExtraPages: 0,
        canShowMoreThreads: false,
        canShowLessThreads: false,
        activeEntryId: activeThread?.id ?? null,
        projectStatus,
      });
      continue;
    }

    const projectThreadTree = buildProjectThreadTree({
      threads: projectThreads,
      forceVisibleThreadId: input.activeSidebarThreadId,
    });
    const orderedEntries: SidebarProjectEntry[] = projectThreadTree.map(
      ({ thread, depth, rootThreadId }) => ({
        kind: "thread",
        rowId: thread.id,
        rootRowId: rootThreadId,
        thread,
        depth,
      }),
    );

    const activeEntry =
      input.activeSidebarThreadId === undefined
        ? null
        : (orderedEntries.find((entry) => entry.rowId === input.activeSidebarThreadId) ?? null);
    const paging = resolveSidebarThreadListPaging({
      totalCount: orderedEntries.length,
      baseLimit: input.previewLimit,
      pageSize: input.previewPageSize,
      requestedExtraPages,
    });
    const { visibleEntries: renderedEntries } = getVisibleSidebarEntriesForPreview({
      entries: orderedEntries,
      activeEntryId: activeEntry?.rowId,
      previewLimit: paging.previewLimit,
    });

    byProjectId.set(project.id, {
      allProjectThreadCount: allProjectThreads.length,
      projectThreads,
      orderedProjectThreadIds,
      visibleEntries: renderedEntries,
      threadListExtraPages: paging.effectiveExtraPages,
      // The active-thread reveal can force rows beyond the page cap; only offer "Show more"
      // while rows are genuinely hidden.
      canShowMoreThreads: paging.canShowMore && renderedEntries.length < orderedEntries.length,
      canShowLessThreads: paging.canShowLess,
      activeEntryId: activeEntry?.rowId ?? null,
      projectStatus,
    });
  }

  return byProjectId;
}

// PR-state presentation (label/color/glyph) moved to
// ~/components/pullRequest/pullRequestStatePresentation so the sidebar badge, kanban chip,
// and the pull request feature surfaces all share one mapping.
