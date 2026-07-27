// FILE: threadDetailSubscriptionRetention.ts
// Purpose: Keep recently used thread-detail subscriptions warm across route/sidebar switches.
// Layer: Web subscription retention utility
// Exports: retain/release helpers, the connection lease selector, and a React listener.

import { WS_STREAM_LIMITS, type ThreadId } from "@synara/contracts";
import { useSyncExternalStore } from "react";
import { useStore } from "./store";
import { getThreadFromState } from "./threadDerivation";

const THREAD_DETAIL_RETENTION_EVICTION_MS = 15 * 60 * 1000;
// This is a client-side memory cache, not a stream budget: concurrent server
// subscriptions stay capped at `WS_STREAM_LIMITS.threadPerClient` by
// `resolveThreadDetailSubscriptionLeaseIds`, so a larger cache never widens
// admission. It must exceed everything that retains at once (sidebar prewarm
// window + split-view threads + a parent's live subagent children), otherwise the
// map sits permanently over capacity and evicts warm detail on every store write.
export const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;

type RetainedThreadEntry = {
  refCount: number;
  lastAccessedAt: number;
  evictionTimeout: ReturnType<typeof setTimeout> | null;
};

const retainedThreadEntries = new Map<ThreadId, RetainedThreadEntry>();
const listeners = new Set<() => void>();
const evictionListeners = new Set<(threadId: ThreadId) => void>();
let cachedSnapshot: readonly ThreadId[] = [];
let visibleThreadIds: ReadonlySet<ThreadId> = new Set();

function emitChange(): void {
  cachedSnapshot = [...retainedThreadEntries.keys()];
  for (const listener of listeners) {
    listener();
  }
}

function emitEviction(threadId: ThreadId): void {
  for (const listener of evictionListeners) {
    try {
      listener(threadId);
    } catch {
      // Eviction listeners must not break retention bookkeeping.
    }
  }
}

/**
 * Whether wiping this thread's detail would discard live or actionable state.
 * Visibility and active retain handles are checked separately; terminal hidden
 * children must remain evictable so completed subagents cannot leak forever.
 */
function isThreadDetailEvictionUnsafe(threadId: ThreadId): boolean {
  const state = useStore.getState();
  const sidebarThread = state.sidebarThreadSummaryById[threadId];

  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan ||
      sidebarThread.hasLiveTailWork
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = getThreadFromState(state, threadId);
  if (!thread) {
    // Claude subagent children can have detail without a shell/sidebar row.
    // Their normalized lifecycle slices still tell us whether eviction would
    // discard live work. Once terminal, the retain timeout and capacity limit
    // must be allowed to reclaim them or every completed child leaks forever.
    const hiddenSession = state.threadSessionById?.[threadId];
    const hiddenTurnState = state.threadTurnStateById?.[threadId];
    return (
      hiddenSession?.orchestrationStatus === "starting" ||
      hiddenSession?.orchestrationStatus === "running" ||
      hiddenTurnState?.latestTurn?.state === "running" ||
      hiddenTurnState?.pendingSourceProposedPlan !== undefined
    );
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function shouldEvictEntry(threadId: ThreadId, entry: RetainedThreadEntry): boolean {
  return (
    entry.refCount === 0 &&
    !visibleThreadIds.has(threadId) &&
    !isThreadDetailEvictionUnsafe(threadId)
  );
}

/**
 * Threads the app is currently rendering. The store keeps a thread's shell row
 * when its detail is evicted, so evicting a visible thread renders it as an empty
 * conversation until a fresh snapshot lands — never evict one.
 */
export function setVisibleThreadDetailIds(threadIds: readonly ThreadId[]): void {
  if (
    visibleThreadIds.size === threadIds.length &&
    threadIds.every((threadId) => visibleThreadIds.has(threadId))
  ) {
    return;
  }
  visibleThreadIds = new Set(threadIds);
  reconcileRetentionEntries();
}

function clearEvictionTimeout(entry: RetainedThreadEntry): void {
  if (entry.evictionTimeout === null) {
    return;
  }
  clearTimeout(entry.evictionTimeout);
  entry.evictionTimeout = null;
}

function evictEntry(
  threadId: ThreadId,
  entry: RetainedThreadEntry,
  options?: { readonly notify?: boolean },
): void {
  clearEvictionTimeout(entry);
  if (!retainedThreadEntries.delete(threadId)) {
    return;
  }
  useStore.getState().evictThreadDetail(threadId);
  emitEviction(threadId);
  if (options?.notify !== false) {
    emitChange();
  }
}

function scheduleEviction(threadId: ThreadId, entry: RetainedThreadEntry): void {
  clearEvictionTimeout(entry);
  if (!shouldEvictEntry(threadId, entry)) {
    return;
  }
  const remainingMs = Math.max(
    0,
    entry.lastAccessedAt + THREAD_DETAIL_RETENTION_EVICTION_MS - Date.now(),
  );
  entry.evictionTimeout = setTimeout(() => {
    const currentEntry = retainedThreadEntries.get(threadId);
    if (currentEntry) {
      currentEntry.evictionTimeout = null;
    }
    if (!currentEntry || !shouldEvictEntry(threadId, currentEntry)) {
      return;
    }
    evictEntry(threadId, currentEntry);
  }, remainingMs);
}

function evictIdleEntriesToCapacity(): void {
  if (retainedThreadEntries.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
    return;
  }

  const idleEntries = [...retainedThreadEntries.entries()]
    .filter((entry): entry is [ThreadId, RetainedThreadEntry] =>
      shouldEvictEntry(entry[0], entry[1]),
    )
    .toSorted((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

  let changed = false;
  for (const [threadId] of idleEntries) {
    if (retainedThreadEntries.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      break;
    }
    const entry = retainedThreadEntries.get(threadId);
    if (!entry || !shouldEvictEntry(threadId, entry)) {
      continue;
    }
    evictEntry(threadId, entry, { notify: false });
    changed = true;
  }
  if (changed) {
    emitChange();
  }
}

function reconcileRetentionEntries(): void {
  for (const [threadId, entry] of retainedThreadEntries) {
    if (shouldEvictEntry(threadId, entry)) {
      if (entry.evictionTimeout === null) {
        scheduleEviction(threadId, entry);
      }
    } else {
      clearEvictionTimeout(entry);
    }
  }
  evictIdleEntriesToCapacity();
}

// This reconcile is re-entrant by design: it can evict, and eviction writes to the
// store, which synchronously runs this subscriber again. It stays correct because
// `evictEntry` deletes its entry before touching the store, and every step re-reads
// the live map, so a nested pass can only evict entries the outer pass has not
// claimed. The eviction notice is the one part that must not run inline — lease
// owners answer it by queueing a stream refresh rather than writing state here.
useStore.subscribe(() => {
  reconcileRetentionEntries();
});

export function retainThreadDetailSubscription(threadId: ThreadId): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseThreadDetailSubscription(threadId);
  };
  const existing = retainedThreadEntries.get(threadId);
  if (existing) {
    clearEvictionTimeout(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    return release;
  }

  retainedThreadEntries.set(threadId, {
    refCount: 1,
    lastAccessedAt: Date.now(),
    evictionTimeout: null,
  });
  emitChange();
  evictIdleEntriesToCapacity();

  return release;
}

export function releaseThreadDetailSubscription(threadId: ThreadId): void {
  const entry = retainedThreadEntries.get(threadId);
  if (!entry) {
    return;
  }

  entry.refCount = Math.max(0, entry.refCount - 1);
  entry.lastAccessedAt = Date.now();
  if (entry.refCount > 0) {
    return;
  }

  scheduleEviction(threadId, entry);
  evictIdleEntriesToCapacity();
}

export function subscribeRetainedThreadDetailIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fires after a thread's detail slices were evicted from the store. Subscription
 * owners use this to refresh threads whose stream lease is still active, since an
 * eviction wipes messages without triggering a new snapshot on its own.
 */
export function subscribeThreadDetailEvictions(listener: (threadId: ThreadId) => void): () => void {
  evictionListeners.add(listener);
  return () => {
    evictionListeners.delete(listener);
  };
}

export function getRetainedThreadDetailIdsSnapshot(): readonly ThreadId[] {
  return cachedSnapshot;
}

/**
 * Whether retention still owns this thread's warm detail. Subscription owners
 * check this when a stream lease drops: detail that no retention entry owns and
 * no lease references would otherwise stay in the store for the session's
 * lifetime, because eviction only ever runs from a retention entry.
 */
export function isThreadDetailRetained(threadId: ThreadId): boolean {
  return retainedThreadEntries.has(threadId);
}

export function resolveThreadDetailSubscriptionLeaseIds(input: {
  readonly visibleThreadIds: readonly ThreadId[];
  readonly retainedThreadIds: readonly ThreadId[];
  readonly serverThreadIds: ReadonlySet<ThreadId>;
}): ThreadId[] {
  const threadIds = new Set<ThreadId>();
  for (const threadId of input.visibleThreadIds) {
    if (threadIds.size >= WS_STREAM_LIMITS.threadPerClient) break;
    // A visible draft needs a lease before its shell row exists so its first
    // provider events cannot outrun promotion into the server snapshot.
    threadIds.add(threadId);
  }
  for (const threadId of input.retainedThreadIds) {
    if (threadIds.size >= WS_STREAM_LIMITS.threadPerClient) break;
    if (input.serverThreadIds.has(threadId)) {
      threadIds.add(threadId);
    }
  }
  return [...threadIds];
}

export function useRetainedThreadDetailIds(): readonly ThreadId[] {
  return useSyncExternalStore(
    subscribeRetainedThreadDetailIds,
    getRetainedThreadDetailIdsSnapshot,
    getRetainedThreadDetailIdsSnapshot,
  );
}

export function resetRetainedThreadDetailSubscriptionsForTests(): void {
  for (const entry of retainedThreadEntries.values()) {
    clearEvictionTimeout(entry);
  }
  retainedThreadEntries.clear();
  visibleThreadIds = new Set();
  emitChange();
}
