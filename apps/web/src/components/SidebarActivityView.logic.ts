// FILE: SidebarActivityView.logic.ts
// Purpose: Pure grouping/sorting model for the sidebar Activity view (threads as tasks).
// Exports: eligibility, status-group resolution, settle helpers, family model, and the view-model builder.

import type { ProjectId, ThreadId } from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import type { SidebarThreadSortOrder, TimestampFormat } from "../appSettings";
import { canSessionAnswerPendingRequests, isLatestTurnSettled } from "../session-logic";
import { formatShortTimestamp } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import {
  buildProjectThreadTree,
  hasUnseenCompletion,
  isThreadActivelyWorking,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { buildThreadHierarchyIndex } from "./sidebarThreadHierarchy";

/**
 * Task-feed ordering, top to bottom: threads that need the user (approvals,
 * input, ready plans), finished work not yet seen, live work, then everything
 * already reviewed. Settled threads leave these groups entirely and sink to
 * the dimmed Settled section.
 */
export type ActivityStatusGroup = "attention" | "unseenCompleted" | "running" | "seen";

const ACTIVITY_GROUP_ORDER: Record<ActivityStatusGroup, number> = {
  attention: 0,
  unseenCompleted: 1,
  running: 2,
  seen: 3,
};

export function isThreadRunningForActivity(
  thread: Pick<SidebarThreadSummary, "hasLiveTailWork" | "session" | "latestTurn">,
): boolean {
  return isThreadActivelyWorking(thread) || thread.session?.status === "connecting";
}

type ActivityAttentionInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasLiveTailWork"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
>;

function requiresActivityAttention(thread: ActivityAttentionInput): boolean {
  // Mirrors resolveThreadStatusPill: a dead session cannot receive answers, so
  // its pending requests no longer count as "needs attention".
  const canAnswerPendingRequests = canSessionAnswerPendingRequests(thread.session);
  if ((thread.hasPendingApprovals || thread.hasPendingUserInput) && canAnswerPendingRequests) {
    return true;
  }
  return (
    thread.interactionMode === "plan" &&
    !thread.hasLiveTailWork &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  );
}

export function resolveActivityStatusGroup(thread: SidebarThreadSummary): ActivityStatusGroup {
  if (requiresActivityAttention(thread)) {
    return "attention";
  }
  if (isThreadRunningForActivity(thread)) {
    return "running";
  }
  if (hasUnseenCompletion(thread)) {
    return "unseenCompleted";
  }
  return "seen";
}

/**
 * Threads that belong in the task feed: not archived, and having run at
 * least once. Drafts stay out, but a thread whose very first turn is
 * starting up already counts as running work.
 *
 * Lote C: the parent exclusion is gone. Subagents/batches are eligible on
 * their own; families (not individual rows) decide visibility.
 */
export function isActivityThread(thread: SidebarThreadSummary): boolean {
  if (thread.archivedAt != null) return false;
  return thread.latestTurn !== null || isThreadRunningForActivity(thread);
}

export function isThreadSettledForActivity(
  thread: Pick<SidebarThreadSummary, "id" | "settledAt">,
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>,
): boolean {
  return settledOverrideByThreadId?.get(thread.id) ?? thread.settledAt != null;
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The thread fields the feed is allowed to order by.
 *
 * `updatedAt` is ignored while work streams because every finalized assistant
 * message can bump it and make concurrent rows trade places. Once a thread
 * requires attention, however, output is paused and `updatedAt` is the stable
 * timestamp of the approval/input/plan event that made the row actionable.
 * Milestones remain the fallback for every other status.
 */
export type ActivityRecencyInput = ActivityAttentionInput &
  Pick<SidebarThreadSummary, "createdAt" | "latestTurn" | "latestUserMessageAt" | "updatedAt">;

/** The timestamp a row represents, as ISO, so order and row label never disagree. */
export function resolveActivityRecencyIso(thread: ActivityRecencyInput): string {
  let bestIso = thread.createdAt;
  let bestMs = parseTimestampMs(thread.createdAt);
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    requiresActivityAttention(thread) ? thread.updatedAt : null,
  ]) {
    if (!candidate) continue;
    const candidateMs = parseTimestampMs(candidate);
    if (candidateMs > bestMs) {
      bestMs = candidateMs;
      bestIso = candidate;
    }
  }
  return bestIso;
}

export function resolveActivityRecencyMs(thread: ActivityRecencyInput): number {
  return parseTimestampMs(resolveActivityRecencyIso(thread));
}

function compareFamilyRootIds(
  left: Pick<ActivityFamily, "rootId">,
  right: Pick<ActivityFamily, "rootId">,
): number {
  return left.rootId.localeCompare(right.rootId);
}

// ---------------------------------------------------------------------------
// Family model (Lote C)
// ---------------------------------------------------------------------------

/**
 * One orchestrator family: the root as context plus every available
 * descendant, even those without a turn yet. Aggregates are computed from
 * eligible members only; no SidebarThreadSummary field is falsified.
 */
export interface ActivityFamily {
  readonly rootId: ThreadId;
  readonly rootThread: SidebarThreadSummary;
  readonly projectId: ProjectId;
  /** Every available (non-archived) member, root first, in sibling sort order. */
  readonly threads: SidebarThreadSummary[];
  /** Eligible members (isActivityThread); non-empty by construction. */
  readonly eligibleThreads: SidebarThreadSummary[];
  /** Highest priority among eligible: attention > unseenCompleted > running > seen. */
  readonly statusGroup: ActivityStatusGroup;
  /** Max resolveActivityRecencyMs among eligible. */
  readonly recencyMs: number;
  /** ISO behind recencyMs, for date buckets and row-time fallback. */
  readonly recencyIso: string;
  /** Max human interaction among eligible, for Recent/project ordering. */
  readonly interactionMs: number;
}

function resolveFamilyStatusGroup(eligible: readonly SidebarThreadSummary[]): ActivityStatusGroup {
  let best: ActivityStatusGroup = "seen";
  let bestOrder = ACTIVITY_GROUP_ORDER.seen;
  for (const thread of eligible) {
    const group = resolveActivityStatusGroup(thread);
    const order = ACTIVITY_GROUP_ORDER[group];
    if (order < bestOrder) {
      bestOrder = order;
      best = group;
      if (bestOrder === ACTIVITY_GROUP_ORDER.attention) break;
    }
  }
  return best;
}

function resolveFamilyRecency(eligible: readonly SidebarThreadSummary[]): {
  recencyMs: number;
  recencyIso: string;
} {
  let recencyMs = 0;
  let recencyIso = eligible[0]?.createdAt ?? new Date(0).toISOString();
  let recencyId = eligible[0]?.id ?? "";
  for (const thread of eligible) {
    const ms = resolveActivityRecencyMs(thread);
    if (ms > recencyMs || (ms === recencyMs && thread.id.localeCompare(recencyId) < 0)) {
      recencyMs = ms;
      recencyIso = resolveActivityRecencyIso(thread);
      recencyId = thread.id;
    }
  }
  return { recencyMs, recencyIso };
}

function resolveFamilyInteractionMs(eligible: readonly SidebarThreadSummary[]): number {
  let best = 0;
  for (const thread of eligible) {
    best = Math.max(best, resolveActivityInteractionMs(thread));
  }
  return best;
}

function isFamilySettled(
  eligible: readonly SidebarThreadSummary[],
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>,
): boolean {
  for (const thread of eligible) {
    if (!isThreadSettledForActivity(thread, settledOverrideByThreadId)) return false;
    if (resolveActivityStatusGroup(thread) !== "seen") return false;
  }
  return true;
}

function resolveFamilySettledMs(
  eligible: readonly SidebarThreadSummary[],
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>,
): number {
  let best = 0;
  for (const thread of eligible) {
    const settledMs = parseTimestampMs(thread.settledAt) || resolveActivityRecencyMs(thread);
    // Optimistic settle without settledAt falls back to recency (see flat sorter).
    void settledOverrideByThreadId;
    best = Math.max(best, settledMs);
  }
  return best;
}

/**
 * Build every family that enters Activity: group available (non-archived)
 * threads by hierarchy root, keep the group when any member is eligible,
 * expose the root as context even without a turn and include every available
 * descendant (even not-yet-started) for the open branch.
 *
 * Siblings follow sortThreadsForSidebar with the user's preference so both
 * sidebars order children identically; family order itself is decided by the
 * view model aggregates, not by input order.
 */
export function buildActivityFamilies(input: {
  threads: readonly SidebarThreadSummary[];
  sortOrder?: SidebarThreadSortOrder | undefined;
}): ActivityFamily[] {
  const available = input.threads.filter((thread) => thread.archivedAt == null);
  const sorted = input.sortOrder
    ? sortThreadsForSidebar(available, input.sortOrder)
    : [...available];
  const index = buildThreadHierarchyIndex(sorted);
  const membersByRootId = new Map<ThreadId, SidebarThreadSummary[]>();
  for (const thread of sorted) {
    const rootId = index.rootIdByThreadId.get(thread.id);
    if (rootId === undefined) continue;
    const members = membersByRootId.get(rootId);
    if (members) members.push(thread);
    else membersByRootId.set(rootId, [thread]);
  }

  const families: ActivityFamily[] = [];
  for (const [rootId, members] of membersByRootId) {
    const eligible = members.filter((thread) => isActivityThread(thread));
    if (eligible.length === 0) continue;
    const rootThread = index.nodesById.get(rootId);
    if (!rootThread) continue;
    const statusGroup = resolveFamilyStatusGroup(eligible);
    const { recencyMs, recencyIso } = resolveFamilyRecency(eligible);
    const interactionMs = resolveFamilyInteractionMs(eligible);
    families.push({
      rootId,
      rootThread,
      projectId: rootThread.projectId,
      threads: [...members],
      eligibleThreads: [...eligible],
      statusGroup,
      recencyMs,
      recencyIso,
      interactionMs,
    });
  }
  return families;
}

export interface ActivityFamilyViewModel {
  pinned: ActivityFamily[];
  active: ActivityFamily[];
  settled: ActivityFamily[];
}

/**
 * Splits eligible families into the three Activity sections and orders each
 * by family aggregates:
 * pinned by recency, active by status group then recency, settled by when
 * they were settled. A family appears exactly once: any pinned member moves
 * the whole family to Pinned; a non-pinned family settles only when every
 * eligible member is settled+seen. An optional project filter narrows every
 * section without changing the ordering rules.
 */
export function buildActivityViewModel(input: {
  threads: readonly SidebarThreadSummary[];
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  /** Project scope as a set so merged scopes (all project-less chats) filter as one. */
  projectFilterIds?: ReadonlySet<ProjectId> | null;
  sortOrder?: SidebarThreadSortOrder;
}): ActivityFamilyViewModel {
  const projectFilterIds = input.projectFilterIds ?? null;
  const families = buildActivityFamilies({ threads: input.threads, sortOrder: input.sortOrder });
  const pinned: ActivityFamily[] = [];
  const active: ActivityFamily[] = [];
  const settled: ActivityFamily[] = [];

  for (const family of families) {
    if (projectFilterIds !== null && !projectFilterIds.has(family.projectId)) continue;
    const isPinned = family.threads.some((thread) => input.pinnedThreadIdSet.has(thread.id));
    if (isPinned) {
      pinned.push(family);
      continue;
    }
    if (isFamilySettled(family.eligibleThreads, input.settledOverrideByThreadId)) {
      settled.push(family);
    } else {
      active.push(family);
    }
  }

  pinned.sort(
    (left, right) => right.recencyMs - left.recencyMs || compareFamilyRootIds(left, right),
  );
  active.sort((left, right) => {
    const groupDelta =
      ACTIVITY_GROUP_ORDER[left.statusGroup] - ACTIVITY_GROUP_ORDER[right.statusGroup];
    if (groupDelta !== 0) return groupDelta;
    return right.recencyMs - left.recencyMs || compareFamilyRootIds(left, right);
  });
  settled.sort((left, right) => {
    const leftSettledMs = resolveFamilySettledMs(
      left.eligibleThreads,
      input.settledOverrideByThreadId,
    );
    const rightSettledMs = resolveFamilySettledMs(
      right.eligibleThreads,
      input.settledOverrideByThreadId,
    );
    return rightSettledMs - leftSettledMs || compareFamilyRootIds(left, right);
  });

  return { pinned, active, settled };
}

export type ActivityDateBucket = "today" | "yesterday" | "earlier";

export function resolveActivityDateBucket(
  thread: ActivityRecencyInput,
  nowMs: number,
): ActivityDateBucket {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const recencyMs = resolveActivityRecencyMs(thread);
  if (recencyMs >= startOfToday.getTime()) return "today";
  if (recencyMs >= startOfYesterday.getTime()) return "yesterday";
  return "earlier";
}

export function resolveActivityFamilyDateBucket(
  family: Pick<ActivityFamily, "recencyMs">,
  nowMs: number,
): ActivityDateBucket {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (family.recencyMs >= startOfToday.getTime()) return "today";
  if (family.recencyMs >= startOfYesterday.getTime()) return "yesterday";
  return "earlier";
}

/**
 * Splits an already-ordered active family list into calendar sections. Ordering is
 * preserved as-is inside each bucket, so status priority keeps working within
 * a day and the Earlier section can collapse the long tail.
 */
export function splitActivityThreadsByDateBucket(
  families: readonly ActivityFamily[],
  nowMs: number,
): Record<ActivityDateBucket, ActivityFamily[]> {
  const buckets: Record<ActivityDateBucket, ActivityFamily[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const family of families) {
    buckets[resolveActivityFamilyDateBucket(family, nowMs)].push(family);
  }
  return buckets;
}

/** How the feed lays out its sections: calendar buckets or one block per project. */
export type ActivityGroupMode = "time" | "project";

export type ActivityProjectGroup =
  | {
      key: string;
      kind: "project";
      projectId: ProjectId;
      families: ActivityFamily[];
    }
  | {
      key: "chats";
      kind: "chats";
      projectIds: ProjectId[];
      families: ActivityFamily[];
    };

/**
 * Groups an already-ordered active family list by project, busiest-recent project
 * first. Family order inside a group is preserved, so status priority still
 * decides who leads each project block.
 *
 * Projects the user themselves touched in the current working day (the same
 * 4am-to-4am window the Recent section uses) rank above the rest, so a project
 * being worked on right now cannot be pushed down by another project whose
 * agents merely emitted newer output overnight. Within each tier the most
 * recent activity still leads.
 */
export function groupActivityThreadsByProject(
  families: readonly ActivityFamily[],
  isRealProject: (projectId: ProjectId) => boolean,
  options: { nowMs: number },
): ActivityProjectGroup[] {
  const dayStartMs = resolveActivityDayStartMs(options.nowMs);
  const groupByKey = new Map<string, ActivityProjectGroup>();
  for (const family of families) {
    const key = isRealProject(family.projectId) ? `project:${family.projectId}` : "chats";
    const group = groupByKey.get(key);
    if (group) {
      group.families.push(family);
      if (group.kind === "chats" && !group.projectIds.includes(family.projectId)) {
        group.projectIds.push(family.projectId);
      }
      continue;
    }
    groupByKey.set(
      key,
      isRealProject(family.projectId)
        ? {
            key,
            kind: "project",
            projectId: family.projectId,
            families: [family],
          }
        : {
            key: "chats",
            kind: "chats",
            projectIds: [family.projectId],
            families: [family],
          },
    );
  }
  // Precomputed so the comparator stays O(1) per call instead of rescanning
  // every family of both groups on each comparison.
  const rankByKey = new Map<string, { touchedToday: number; recencyMs: number }>();
  for (const group of groupByKey.values()) {
    let recencyMs = 0;
    let touchedToday = 1;
    for (const family of group.families) {
      recencyMs = Math.max(recencyMs, family.recencyMs);
      if (family.interactionMs >= dayStartMs) touchedToday = 0;
    }
    rankByKey.set(group.key, { touchedToday, recencyMs });
  }

  return Array.from(groupByKey.values()).toSorted((left, right) => {
    const leftRank = rankByKey.get(left.key)!;
    const rightRank = rankByKey.get(right.key)!;
    return (
      leftRank.touchedToday - rightRank.touchedToday ||
      rightRank.recencyMs - leftRank.recencyMs ||
      left.key.localeCompare(right.key)
    );
  });
}

export type ActivityScopeOption =
  | { kind: "project"; projectId: ProjectId; threadCount: number }
  | { kind: "chats"; projectIds: ProjectId[]; threadCount: number };

/**
 * Scope menu entries: every real project with eligible activity, busiest first.
 * Project-less chats (chat/studio-kind containers) collapse into ONE "Synara"
 * entry instead of one look-alike row per hidden container project.
 * Counts families, not rows, so a parent with subagents occupies one slot.
 */
export function collectActivityScopeOptions(
  threads: readonly SidebarThreadSummary[],
  isRealProject: (projectId: ProjectId) => boolean,
  sortOrder?: SidebarThreadSortOrder,
): ActivityScopeOption[] {
  const families = buildActivityFamilies({ threads, sortOrder });
  const countByProjectId = new Map<ProjectId, number>();
  for (const family of families) {
    countByProjectId.set(family.projectId, (countByProjectId.get(family.projectId) ?? 0) + 1);
  }

  const options: ActivityScopeOption[] = [];
  const chatProjectIds: ProjectId[] = [];
  let chatFamilyCount = 0;
  for (const [projectId, familyCount] of countByProjectId) {
    if (isRealProject(projectId)) {
      options.push({ kind: "project", projectId, threadCount: familyCount });
    } else {
      chatProjectIds.push(projectId);
      chatFamilyCount += familyCount;
    }
  }
  if (chatProjectIds.length > 0) {
    options.push({ kind: "chats", projectIds: chatProjectIds, threadCount: chatFamilyCount });
  }
  return options.toSorted((left, right) => right.threadCount - left.threadCount);
}

/** The project scope the feed is pinned to, or null for every project. */
export type ActivityScopeSelection = ProjectId | "chats" | null;

/**
 * The scope the feed can actually honor. A selection whose option has left the
 * menu — its last family was archived, settled away, or moved — falls back to
 * "all projects" instead of filtering the feed down to nothing behind a scope
 * the user can no longer see.
 */
export function resolveActivityScope(
  scopeSelection: ActivityScopeSelection,
  scopeOptions: readonly ActivityScopeOption[],
): { scope: ActivityScopeSelection; projectFilterIds: Set<ProjectId> | null } {
  if (scopeSelection === null) return { scope: null, projectFilterIds: null };
  if (scopeSelection === "chats") {
    const chats = scopeOptions.find((option) => option.kind === "chats");
    if (!chats) return { scope: null, projectFilterIds: null };
    return { scope: "chats", projectFilterIds: new Set(chats.projectIds) };
  }
  const isOffered = scopeOptions.some(
    (option) => option.kind === "project" && option.projectId === scopeSelection,
  );
  if (!isOffered) return { scope: null, projectFilterIds: null };
  return { scope: scopeSelection, projectFilterIds: new Set([scopeSelection]) };
}

export const ACTIVITY_RECENT_LIMIT = 5;

/**
 * Recent turns over at 4am, not midnight: a session that runs past midnight is
 * still the same working day, and resetting the section out from under a live
 * session is worse than carrying it a few hours longer.
 */
export const ACTIVITY_DAY_START_HOUR = 4;

/** Start of the working day `nowMs` belongs to, in local time. */
export function resolveActivityDayStartMs(nowMs: number): number {
  const dayStart = new Date(nowMs);
  dayStart.setHours(ACTIVITY_DAY_START_HOUR, 0, 0, 0);
  if (dayStart.getTime() > nowMs) dayStart.setDate(dayStart.getDate() - 1);
  return dayStart.getTime();
}

/**
 * Keeps actionable or live work ahead of the user's already-reviewed working
 * set. `active` is already status-sorted, so both returned arrays preserve the
 * intended attention → unseen completion → running → seen ordering.
 */
export function splitPriorityActivityThreads(active: readonly ActivityFamily[]): {
  priority: ActivityFamily[];
  seen: ActivityFamily[];
} {
  const priority: ActivityFamily[] = [];
  const seen: ActivityFamily[] = [];
  for (const family of active) {
    if (family.statusGroup === "seen") {
      seen.push(family);
    } else {
      priority.push(family);
    }
  }
  return { priority, seen };
}

/**
 * When the user last touched a thread themselves: opened it (lastVisitedAt) or
 * sent a message (latestUserMessageAt). Agent/automation activity deliberately
 * does not count — the Recent section tracks the user's working set, not the
 * server's.
 */
export function resolveActivityInteractionMs(
  thread: Pick<SidebarThreadSummary, "lastVisitedAt" | "latestUserMessageAt">,
): number {
  return Math.max(
    parseTimestampMs(thread.lastVisitedAt),
    parseTimestampMs(thread.latestUserMessageAt),
  );
}

/**
 * Pulls the user's working set out of the (already status-sorted) active family list:
 * up to `limit` families they interacted with *today*, newest interaction first.
 * Counts families, so five roots occupy five slots even with descendants.
 * Nothing is hidden by aging out: the remainder keeps its original order and
 * falls through to the date buckets below.
 */
export function splitRecentActivityThreads(
  active: readonly ActivityFamily[],
  options: { nowMs: number; limit?: number },
): { recent: ActivityFamily[]; rest: ActivityFamily[] } {
  const limit = options.limit ?? ACTIVITY_RECENT_LIMIT;
  const dayStartMs = resolveActivityDayStartMs(options.nowMs);
  const recent = active
    .filter((family) => family.interactionMs >= dayStartMs)
    .toSorted(
      (left, right) =>
        right.interactionMs - left.interactionMs || compareFamilyRootIds(left, right),
    )
    .slice(0, limit);
  const recentRootIds = new Set(recent.map((family) => family.rootId));
  return {
    recent,
    rest: active.filter((family) => !recentRootIds.has(family.rootId)),
  };
}

/**
 * Computes the rows that are actually mounted in Activity render order, from
 * the same family + branch model that renders. Closed branches and closed
 * sections are excluded even though their DOM may linger for the disclosure
 * animation. The Sidebar consumes this same list for jump shortcuts,
 * next/previous navigation, prewarming, and live PR refreshes so hidden
 * classic-project state cannot leak into the Activity surface.
 */
export function collectVisibleActivityThreadIds(input: {
  groupMode: ActivityGroupMode;
  pinnedOpen: boolean;
  pinned: readonly ActivityFamily[];
  priority: readonly ActivityFamily[];
  recent: readonly ActivityFamily[];
  today: readonly ActivityFamily[];
  yesterday: readonly ActivityFamily[];
  earlierOpen: boolean;
  earlier: readonly ActivityFamily[];
  projectGroups: readonly (readonly ActivityFamily[])[];
  settledOpen: boolean;
  settled: readonly ActivityFamily[];
  expandedThreadIds?: ReadonlySet<ThreadId> | undefined;
  collapsedThreadIds?: ReadonlySet<ThreadId> | undefined;
  childExtraPagesByParentId?: ReadonlyMap<ThreadId, number> | undefined;
  forceVisibleThreadId?: ThreadId | undefined;
}): ThreadId[] {
  const orderedFamilies: ActivityFamily[] = [];
  const pushFamilies = (families: readonly ActivityFamily[]) => {
    for (const family of families) orderedFamilies.push(family);
  };
  if (input.pinnedOpen) pushFamilies(input.pinned);
  if (input.groupMode === "project") {
    for (const group of input.projectGroups) pushFamilies(group);
  } else {
    pushFamilies(input.priority);
    pushFamilies(input.recent);
    pushFamilies(input.today);
    pushFamilies(input.yesterday);
    if (input.earlierOpen) pushFamilies(input.earlier);
  }
  if (input.settledOpen) pushFamilies(input.settled);

  const visible: ThreadId[] = [];
  const seen = new Set<ThreadId>();
  for (const family of orderedFamilies) {
    const rows = buildProjectThreadTree({
      threads: family.threads,
      forceVisibleThreadId: input.forceVisibleThreadId,
      expandedThreadIds: input.expandedThreadIds,
      collapsedThreadIds: input.collapsedThreadIds,
      childExtraPagesByParentId: input.childExtraPagesByParentId,
    });
    // Roots without cutting the subtree: an included family renders every
    // visible row of its branch; closed branches contribute only the root.
    if (rows.length === 0) {
      if (!seen.has(family.rootId)) {
        seen.add(family.rootId);
        visible.push(family.rootId);
      }
      continue;
    }
    for (const row of rows) {
      if (!seen.has(row.thread.id)) {
        seen.add(row.thread.id);
        visible.push(row.thread.id);
      }
    }
  }
  return visible;
}

/**
 * Row timestamp: today's families show the exact clock time (task-feed precision,
 * and it disambiguates same-title chats that would both read "2h"); older rows
 * keep the coarser relative label.
 */
export function formatActivityRowTime(input: {
  thread: ActivityRecencyInput;
  nowMs: number;
  timestampFormat: TimestampFormat;
}): string {
  const isoDate = resolveActivityRecencyIso(input.thread);
  if (resolveActivityDateBucket(input.thread, input.nowMs) === "today") {
    return formatShortTimestamp(isoDate, input.timestampFormat);
  }
  return formatRelativeTime(isoDate);
}

/** Threads "Mark all as read" should visit: eligible feed rows with an unseen completion. */
export function collectUnreadActivityThreads(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return threads.filter((thread) => isActivityThread(thread) && hasUnseenCompletion(thread));
}

/**
 * Unread sweep for the current scope, reaching eligible members in closed
 * branches: uses individual IDs/times so collapsing never hides work.
 */
export function collectUnreadActivityFamilyThreads(
  families: readonly ActivityFamily[],
): SidebarThreadSummary[] {
  const unread: SidebarThreadSummary[] = [];
  for (const family of families) {
    for (const thread of family.eligibleThreads) {
      if (hasUnseenCompletion(thread)) unread.push(thread);
    }
  }
  return unread;
}

/** The open thread is already being read even if its visited timestamp update is one render late. */
export function hasUnreadActivity(
  threads: readonly SidebarThreadSummary[],
  activeThreadId: ThreadId | null,
): boolean {
  return collectUnreadActivityThreads(threads).some((thread) => thread.id !== activeThreadId);
}
