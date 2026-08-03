// FILE: SidebarActivityView.logic.ts
// Purpose: Pure grouping/sorting model for the sidebar Activity view (threads as tasks).
// Exports: eligibility, status-group resolution, settle helpers, and the view-model builder.

import type { ProjectId, ThreadId } from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import type { TimestampFormat } from "../appSettings";
import { canSessionAnswerPendingRequests, isLatestTurnSettled } from "../session-logic";
import { formatShortTimestamp } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { hasUnseenCompletion, isThreadActivelyWorking } from "./Sidebar.logic";

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
 * Threads that belong in the task feed: top-level, not archived, and having run
 * at least once. Drafts stay out, but a thread whose very first turn is
 * starting up already counts as running work.
 */
export function isActivityThread(thread: SidebarThreadSummary): boolean {
  if (thread.archivedAt != null) return false;
  if (thread.parentThreadId) return false;
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

/**
 * Last resort so equal timestamps still produce one fixed order: without it the
 * rows would follow whatever order the incoming thread list happened to have on
 * that render, which is exactly the flicker this sort is meant to prevent.
 */
function compareThreadIds(
  left: Pick<SidebarThreadSummary, "id">,
  right: Pick<SidebarThreadSummary, "id">,
): number {
  return left.id.localeCompare(right.id);
}

export interface ActivityViewModel {
  pinned: SidebarThreadSummary[];
  active: SidebarThreadSummary[];
  settled: SidebarThreadSummary[];
}

/**
 * Splits eligible threads into the three Activity sections and orders each:
 * pinned by recency, active by status group then recency, settled by when they
 * were settled. Pinned threads live exclusively in the Pinned section, while a
 * settled non-pinned thread is promoted back to active whenever it starts working,
 * needs attention, or has an unseen completion. An optional project filter narrows
 * every section without changing the ordering rules.
 */
export function buildActivityViewModel(input: {
  threads: readonly SidebarThreadSummary[];
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  /** Project scope as a set so merged scopes (all project-less chats) filter as one. */
  projectFilterIds?: ReadonlySet<ProjectId> | null;
}): ActivityViewModel {
  const projectFilterIds = input.projectFilterIds ?? null;
  const pinned: SidebarThreadSummary[] = [];
  const active: SidebarThreadSummary[] = [];
  const settled: SidebarThreadSummary[] = [];

  for (const thread of input.threads) {
    if (!isActivityThread(thread)) continue;
    if (projectFilterIds !== null && !projectFilterIds.has(thread.projectId)) continue;
    if (input.pinnedThreadIdSet.has(thread.id)) {
      pinned.push(thread);
      continue;
    }
    const statusGroup = resolveActivityStatusGroup(thread);
    if (
      isThreadSettledForActivity(thread, input.settledOverrideByThreadId) &&
      statusGroup === "seen"
    ) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  pinned.sort(
    (left, right) =>
      resolveActivityRecencyMs(right) - resolveActivityRecencyMs(left) ||
      compareThreadIds(left, right),
  );
  active.sort((left, right) => {
    const groupDelta =
      ACTIVITY_GROUP_ORDER[resolveActivityStatusGroup(left)] -
      ACTIVITY_GROUP_ORDER[resolveActivityStatusGroup(right)];
    if (groupDelta !== 0) return groupDelta;
    return (
      resolveActivityRecencyMs(right) - resolveActivityRecencyMs(left) ||
      compareThreadIds(left, right)
    );
  });
  settled.sort((left, right) => {
    // Optimistically settled threads have no settledAt yet; their latest
    // activity stands in so they surface at the top of the section.
    const leftSettledMs = parseTimestampMs(left.settledAt) || resolveActivityRecencyMs(left);
    const rightSettledMs = parseTimestampMs(right.settledAt) || resolveActivityRecencyMs(right);
    return rightSettledMs - leftSettledMs || compareThreadIds(left, right);
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

/**
 * Splits an already-ordered active list into calendar sections. Ordering is
 * preserved as-is inside each bucket, so status priority keeps working within
 * a day and the Earlier section can collapse the long tail.
 */
export function splitActivityThreadsByDateBucket(
  threads: readonly SidebarThreadSummary[],
  nowMs: number,
): Record<ActivityDateBucket, SidebarThreadSummary[]> {
  const buckets: Record<ActivityDateBucket, SidebarThreadSummary[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const thread of threads) {
    buckets[resolveActivityDateBucket(thread, nowMs)].push(thread);
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
      threads: SidebarThreadSummary[];
    }
  | {
      key: "chats";
      kind: "chats";
      projectIds: ProjectId[];
      threads: SidebarThreadSummary[];
    };

/**
 * Groups an already-ordered active list by project, busiest-recent project
 * first. Thread order inside a group is preserved, so status priority still
 * decides who leads each project block.
 */
export function groupActivityThreadsByProject(
  threads: readonly SidebarThreadSummary[],
  isRealProject: (projectId: ProjectId) => boolean,
): ActivityProjectGroup[] {
  const groupByKey = new Map<string, ActivityProjectGroup>();
  for (const thread of threads) {
    const key = isRealProject(thread.projectId) ? `project:${thread.projectId}` : "chats";
    const group = groupByKey.get(key);
    if (group) {
      group.threads.push(thread);
      if (group.kind === "chats" && !group.projectIds.includes(thread.projectId)) {
        group.projectIds.push(thread.projectId);
      }
      continue;
    }
    groupByKey.set(
      key,
      isRealProject(thread.projectId)
        ? {
            key,
            kind: "project",
            projectId: thread.projectId,
            threads: [thread],
          }
        : {
            key: "chats",
            kind: "chats",
            projectIds: [thread.projectId],
            threads: [thread],
          },
    );
  }
  return Array.from(groupByKey.values()).toSorted(
    (left, right) =>
      Math.max(...right.threads.map(resolveActivityRecencyMs)) -
        Math.max(...left.threads.map(resolveActivityRecencyMs)) ||
      left.key.localeCompare(right.key),
  );
}

export type ActivityScopeOption =
  | { kind: "project"; projectId: ProjectId; threadCount: number }
  | { kind: "chats"; projectIds: ProjectId[]; threadCount: number };

/**
 * Scope menu entries: every real project with eligible activity, busiest first.
 * Project-less chats (chat/studio-kind containers) collapse into ONE "Synara"
 * entry instead of one look-alike row per hidden container project.
 */
export function collectActivityScopeOptions(
  threads: readonly SidebarThreadSummary[],
  isRealProject: (projectId: ProjectId) => boolean,
): ActivityScopeOption[] {
  const countByProjectId = new Map<ProjectId, number>();
  for (const thread of threads) {
    if (!isActivityThread(thread)) continue;
    countByProjectId.set(thread.projectId, (countByProjectId.get(thread.projectId) ?? 0) + 1);
  }

  const options: ActivityScopeOption[] = [];
  const chatProjectIds: ProjectId[] = [];
  let chatThreadCount = 0;
  for (const [projectId, threadCount] of countByProjectId) {
    if (isRealProject(projectId)) {
      options.push({ kind: "project", projectId, threadCount });
    } else {
      chatProjectIds.push(projectId);
      chatThreadCount += threadCount;
    }
  }
  if (chatProjectIds.length > 0) {
    options.push({ kind: "chats", projectIds: chatProjectIds, threadCount: chatThreadCount });
  }
  return options.toSorted((left, right) => right.threadCount - left.threadCount);
}

/** The project scope the feed is pinned to, or null for every project. */
export type ActivityScopeSelection = ProjectId | "chats" | null;

/**
 * The scope the feed can actually honor. A selection whose option has left the
 * menu — its last thread was archived, settled away, or moved — falls back to
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
export function splitPriorityActivityThreads(active: readonly SidebarThreadSummary[]): {
  priority: SidebarThreadSummary[];
  seen: SidebarThreadSummary[];
} {
  const priority: SidebarThreadSummary[] = [];
  const seen: SidebarThreadSummary[] = [];
  for (const thread of active) {
    if (resolveActivityStatusGroup(thread) === "seen") {
      seen.push(thread);
    } else {
      priority.push(thread);
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
 * Pulls the user's working set out of the (already status-sorted) active list:
 * up to `limit` threads they interacted with *today*, newest interaction first.
 * The freshness window is the point of the section — without it the slots stay
 * occupied by whatever was last opened, so a thread touched days ago squats at
 * the top until it is archived. Nothing is hidden by aging out: the remainder
 * keeps its original order and falls through to the date buckets below.
 */
export function splitRecentActivityThreads(
  active: readonly SidebarThreadSummary[],
  options: { nowMs: number; limit?: number },
): { recent: SidebarThreadSummary[]; rest: SidebarThreadSummary[] } {
  const limit = options.limit ?? ACTIVITY_RECENT_LIMIT;
  const dayStartMs = resolveActivityDayStartMs(options.nowMs);
  const recent = active
    .filter((thread) => resolveActivityInteractionMs(thread) >= dayStartMs)
    .toSorted(
      (left, right) =>
        resolveActivityInteractionMs(right) - resolveActivityInteractionMs(left) ||
        compareThreadIds(left, right),
    )
    .slice(0, limit);
  const recentThreadIds = new Set(recent.map((thread) => thread.id));
  return {
    recent,
    rest: active.filter((thread) => !recentThreadIds.has(thread.id)),
  };
}

/**
 * Computes the rows that are actually mounted in Activity render order. The
 * Sidebar consumes this same list for jump shortcuts, next/previous navigation,
 * prewarming, and live PR refreshes so hidden classic-project state cannot leak
 * into the Activity surface.
 */
export function collectVisibleActivityThreadIds(input: {
  groupMode: ActivityGroupMode;
  pinnedOpen: boolean;
  pinned: readonly SidebarThreadSummary[];
  priority: readonly SidebarThreadSummary[];
  recent: readonly SidebarThreadSummary[];
  today: readonly SidebarThreadSummary[];
  yesterday: readonly SidebarThreadSummary[];
  earlierOpen: boolean;
  earlier: readonly SidebarThreadSummary[];
  projectGroups: readonly (readonly SidebarThreadSummary[])[];
  settledOpen: boolean;
  settled: readonly SidebarThreadSummary[];
}): ThreadId[] {
  const visible: SidebarThreadSummary[] = [];
  if (input.pinnedOpen) visible.push(...input.pinned);
  if (input.groupMode === "project") {
    for (const group of input.projectGroups) visible.push(...group);
  } else {
    visible.push(...input.priority, ...input.recent, ...input.today, ...input.yesterday);
    if (input.earlierOpen) visible.push(...input.earlier);
  }
  if (input.settledOpen) visible.push(...input.settled);
  return [...new Set(visible.map((thread) => thread.id))];
}

/**
 * Row timestamp: today's threads show the exact clock time (task-feed precision,
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

/** The open thread is already being read even if its visited timestamp update is one render late. */
export function hasUnreadActivity(
  threads: readonly SidebarThreadSummary[],
  activeThreadId: ThreadId | null,
): boolean {
  return collectUnreadActivityThreads(threads).some((thread) => thread.id !== activeThreadId);
}
