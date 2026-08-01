// FILE: threadDerivation.ts
// Purpose: Rebuild stable Thread objects from normalized shell/detail slices.
// Exports: cached collection helpers and thread derivation for the web store hot path.

import type { MessageId, ThreadId, TurnId } from "@synara/contracts";
import type { AggregatedView, EnvironmentState } from "./storeState";
import type {
  ChatMessage,
  ProposedPlan,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
  TurnDiffSummary,
} from "./types";

/**
 * Any holder of the normalized thread slices.
 *
 * Derivation is identical whether it runs over ONE environment's record (the
 * projection's own writes) or over the merged cross-environment view (what the
 * UI reads), so it is typed against the slices rather than against the store.
 * That is also the seam that keeps aggregation honest: a thread is rebuilt
 * inside the environment that owns it, and only the finished object is
 * concatenated.
 */
type ThreadSliceSource = EnvironmentState | AggregatedView;

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];
const EMPTY_MESSAGE_MAP: Record<MessageId, ChatMessage> = {};
const EMPTY_ACTIVITY_MAP: Record<string, Thread["activities"][number]> = {};
const EMPTY_PROPOSED_PLAN_MAP: Record<string, ProposedPlan> = {};
const EMPTY_TURN_DIFF_MAP: Record<TurnId, TurnDiffSummary> = {};
const EMPTY_THREAD_IDS: ThreadId[] = [];
const EMPTY_THREAD_SHELL_MAP: Record<ThreadId, ThreadShell> = {};
const EMPTY_THREAD_SESSION_MAP: Record<ThreadId, ThreadSession | null> = {};
const EMPTY_THREAD_TURN_STATE_MAP: Record<ThreadId, ThreadTurnState> = {};
const EMPTY_MESSAGE_IDS_BY_THREAD: Record<ThreadId, MessageId[]> = {};
const EMPTY_ACTIVITY_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
const EMPTY_PROPOSED_PLAN_IDS_BY_THREAD: Record<ThreadId, string[]> = {};
const EMPTY_TURN_DIFF_IDS_BY_THREAD: Record<ThreadId, TurnId[]> = {};

const collectedByIdsCache = new WeakMap<readonly string[], WeakMap<object, readonly unknown[]>>();
const threadCache = new WeakMap<
  ThreadShell,
  {
    session: ThreadSession | null;
    turnState: ThreadTurnState | undefined;
    messages: Thread["messages"];
    activities: Thread["activities"];
    proposedPlans: Thread["proposedPlans"];
    turnDiffSummaries: Thread["turnDiffSummaries"];
    thread: Thread;
  }
>();

export function collectByIds<TKey extends string, TValue>(
  ids: readonly TKey[] | undefined,
  byId: Record<TKey, TValue> | undefined,
  emptyValue: TValue[],
): TValue[] {
  if (!ids || ids.length === 0 || !byId) {
    return emptyValue;
  }

  const cachedByRecord = collectedByIdsCache.get(ids);
  const cached = cachedByRecord?.get(byId);
  if (cached) {
    return cached as TValue[];
  }

  const nextValues = ids.flatMap((id) => {
    const value = byId[id];
    return value ? [value] : [];
  });
  const nextCachedByRecord = cachedByRecord ?? new WeakMap<object, readonly unknown[]>();
  nextCachedByRecord.set(byId, nextValues);
  if (!cachedByRecord) {
    collectedByIdsCache.set(ids, nextCachedByRecord);
  }
  return nextValues;
}

function selectThreadMessages(state: ThreadSliceSource, threadId: ThreadId): Thread["messages"] {
  return collectByIds(
    state.messageIdsByThreadId?.[threadId] ?? EMPTY_MESSAGE_IDS_BY_THREAD[threadId],
    state.messageByThreadId?.[threadId] ?? EMPTY_MESSAGE_MAP,
    EMPTY_MESSAGES,
  );
}

function selectThreadActivities(
  state: ThreadSliceSource,
  threadId: ThreadId,
): Thread["activities"] {
  return collectByIds(
    state.activityIdsByThreadId?.[threadId] ?? EMPTY_ACTIVITY_IDS_BY_THREAD[threadId],
    state.activityByThreadId?.[threadId] ?? EMPTY_ACTIVITY_MAP,
    EMPTY_ACTIVITIES,
  );
}

function selectThreadProposedPlans(
  state: ThreadSliceSource,
  threadId: ThreadId,
): Thread["proposedPlans"] {
  return collectByIds(
    state.proposedPlanIdsByThreadId?.[threadId] ?? EMPTY_PROPOSED_PLAN_IDS_BY_THREAD[threadId],
    state.proposedPlanByThreadId?.[threadId] ?? EMPTY_PROPOSED_PLAN_MAP,
    EMPTY_PROPOSED_PLANS,
  );
}

function selectThreadTurnDiffSummaries(
  state: ThreadSliceSource,
  threadId: ThreadId,
): Thread["turnDiffSummaries"] {
  return collectByIds(
    state.turnDiffIdsByThreadId?.[threadId] ?? EMPTY_TURN_DIFF_IDS_BY_THREAD[threadId],
    state.turnDiffSummaryByThreadId?.[threadId] ?? EMPTY_TURN_DIFF_MAP,
    EMPTY_TURN_DIFF_SUMMARIES,
  );
}

export function getThreadFromState(
  state: ThreadSliceSource,
  threadId: ThreadId,
): Thread | undefined {
  const shell = state.threadShellById?.[threadId] ?? EMPTY_THREAD_SHELL_MAP[threadId];
  if (!shell) {
    return undefined;
  }

  const session = state.threadSessionById?.[threadId] ?? EMPTY_THREAD_SESSION_MAP[threadId] ?? null;
  const turnState = state.threadTurnStateById?.[threadId] ?? EMPTY_THREAD_TURN_STATE_MAP[threadId];
  const messages = selectThreadMessages(state, threadId);
  const activities = selectThreadActivities(state, threadId);
  const proposedPlans = selectThreadProposedPlans(state, threadId);
  const turnDiffSummaries = selectThreadTurnDiffSummaries(state, threadId);
  const cached = threadCache.get(shell);

  if (
    cached &&
    cached.session === session &&
    cached.turnState === turnState &&
    cached.messages === messages &&
    cached.activities === activities &&
    cached.proposedPlans === proposedPlans &&
    cached.turnDiffSummaries === turnDiffSummaries
  ) {
    return cached.thread;
  }

  const thread: Thread = {
    ...shell,
    session,
    latestTurn: turnState?.latestTurn ?? null,
    pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
    messages,
    activities,
    proposedPlans,
    turnDiffSummaries,
  };

  threadCache.set(shell, {
    session,
    turnState,
    messages,
    activities,
    proposedPlans,
    turnDiffSummaries,
    thread,
  });

  return thread;
}

export function getThreadsFromState(state: ThreadSliceSource): Thread[] {
  const threadIds = state.threadIds ?? EMPTY_THREAD_IDS;
  return threadIds.flatMap((threadId) => {
    const thread = getThreadFromState(state, threadId);
    return thread ? [thread] : [];
  });
}
