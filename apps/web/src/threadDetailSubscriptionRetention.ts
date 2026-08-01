// FILE: threadDetailSubscriptionRetention.ts
// Purpose: Keep recently used thread-detail subscriptions warm across route/sidebar switches.
// Layer: Web subscription retention utility
// Exports: retain/release helpers, the connection lease selector, and a React listener.
//
// KNOWN GAP — this module is single-environment while the shell layer is not.
// The shell snapshot fence, thread ownership and resume cursors are all keyed by
// EnvironmentId, but everything here is keyed by ThreadId alone and every cursor
// read resolves through `localThreadDetailResumeCursors()`. That is safe only
// because no product code registers a remote environment yet (the settings UI is
// issue #7); `ensureWsEnvironmentClient` with a non-local id appears only in
// tests.
//
// It is already reachable in principle: `serverThreadIds` in routes/__root.tsx
// comes from `createAllThreadsSelector`, which reads `state.threadIds` — and the
// shell aggregator deliberately merges every environment's threads into that one
// list. So this selector is handed remote thread ids today and answers them with
// local cursor state.
//
// Before any remote environment can be registered, retention/prewarm/lease must
// be keyed by (EnvironmentId, ThreadId), resolving the scope via
// `state.environmentIdByThreadId`. Sequences are per-server SQLite autoincrement
// values with no cross-server ordering, so a cursor written into the wrong
// environment's map resumes against an unrelated sequence space — the server's
// gap check accepts it and streams nothing, leaving a silently empty
// conversation. ThreadId is not proven unique across servers either, so the
// thread-keyed maps here would conflate two servers' threads outright.
// (The ownership side table named above is gone; ownership is now positional,
// so the scope resolves via `environmentIdForThread` in storeAggregation.)
//
// TWO MORE PATHS BELONG TO THIS GAP, both latent for the same reason and both
// to be fixed when issue #7 lands rather than piecemeal:
//
// 1. `clearThreadDetailSyncState` in storeProjection.ts calls
//    `localThreadDetailResumeCursors().clear(threadId)` unconditionally, and it
//    is reached for REMOTE threads through evictThreadDetailFromClientState,
//    removeDeletedThreadFromClientState and the sync-failure resets. Those
//    wrappers route correctly to the owning environment; the inner helper then
//    clears the LOCAL cursor, so a remote cursor outlives the detail it vouches
//    for and the next resubscribe resumes on top of history that is gone. The
//    BULK paths are correctly scoped already (the snapshot retain passes its
//    environment, and the read-model resync is local by definition), so this is
//    the single-thread wipe path alone. It is not threaded through today
//    because the environment id would have to reach eleven in-environment
//    helpers — removeThreadState and the detail-sync writers among them — and
//    that refactor belongs with the (EnvironmentId, ThreadId) rekey above, not
//    ahead of it.
//
// 2. The pinned-thread and space-bookmark pruners (Sidebar.tsx,
//    hooks/useSidebarThreadActions.ts) correctly gate on the LOCAL environment's
//    hydration flag but iterate the MERGED sidebar list. Once a remote
//    environment can be registered, a pinned REMOTE thread is prunable in the
//    window after local hydration but before that environment's first snapshot
//    lands — and the pruned set is what gets persisted, so the pin does not come
//    back. The gate needs to become per-environment along with the rekey.

import { WS_STREAM_LIMITS, type ThreadId } from "@synara/contracts";
import { useSyncExternalStore } from "react";
import { useStore } from "./store";
import { getThreadFromState } from "./threadDerivation";
import { localThreadDetailResumeCursors } from "./threadDetailResumeCursors";

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
  // How many of `refCount` are speculative (prewarm) holds. An entry held only
  // speculatively is not evidence that anything needs a live stream, so the
  // lease selector re-checks its cursor instead of leasing it on sight.
  speculativeRefCount: number;
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
  // The store's detail-wipe transition also drops the thread's resume cursor,
  // so a resubscribe after this eviction fetches a fresh snapshot.
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

export function retainThreadDetailSubscription(
  threadId: ThreadId,
  options?: { readonly speculative?: boolean },
): () => void {
  const speculative = options?.speculative === true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseThreadDetailSubscription(threadId, { speculative });
  };
  const existing = retainedThreadEntries.get(threadId);
  if (existing) {
    clearEvictionTimeout(existing);
    existing.refCount += 1;
    if (speculative) existing.speculativeRefCount += 1;
    existing.lastAccessedAt = Date.now();
    // Leasing keys off speculativeness, so a first non-speculative retain over
    // a speculative entry has to re-publish the snapshot to be picked up.
    if (!speculative) emitChange();
    return release;
  }

  retainedThreadEntries.set(threadId, {
    refCount: 1,
    speculativeRefCount: speculative ? 1 : 0,
    lastAccessedAt: Date.now(),
    evictionTimeout: null,
  });
  emitChange();
  evictIdleEntriesToCapacity();

  return release;
}

export function releaseThreadDetailSubscription(
  threadId: ThreadId,
  options?: { readonly speculative?: boolean },
): void {
  const entry = retainedThreadEntries.get(threadId);
  if (!entry) {
    return;
  }

  entry.refCount = Math.max(0, entry.refCount - 1);
  if (options?.speculative === true) {
    entry.speculativeRefCount = Math.max(0, entry.speculativeRefCount - 1);
  }
  entry.lastAccessedAt = Date.now();
  if (entry.refCount > 0) {
    // A dropped speculative hold can leave real holders behind; republish so
    // the lease selector stops treating the entry as speculative-only.
    if (entry.speculativeRefCount === 0) emitChange();
    return;
  }

  scheduleEviction(threadId, entry);
  evictIdleEntriesToCapacity();
  // The entry survives with refCount 0 (it is the warm detail cache), so a
  // released speculative hold must be published: nothing else tells the lease
  // selector this thread no longer wants a stream.
  emitChange();
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

/**
 * Whether every hold on this thread is speculative — a prewarm, not something
 * currently rendering it.
 */
function isSpeculativeOnlyRetain(threadId: ThreadId): boolean {
  const entry = retainedThreadEntries.get(threadId);
  if (!entry) return false;
  return entry.speculativeRefCount >= entry.refCount;
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
    if (!input.serverThreadIds.has(threadId)) continue;
    // Eligibility is re-checked here rather than trusted from the render that
    // admitted the retain: the cursor map is not reactive, so a server-generation
    // reset can invalidate a speculative hold with nothing re-rendering. A
    // speculative-only entry without a cursor would open a full-history stream —
    // one per prewarmed thread on every restart.
    // Local-only cursor read; see the KNOWN GAP note at the top of this file.
    if (isSpeculativeOnlyRetain(threadId) && !localThreadDetailResumeCursors().has(threadId)) {
      continue;
    }
    threadIds.add(threadId);
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
