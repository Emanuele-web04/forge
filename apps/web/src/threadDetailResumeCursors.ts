// FILE: threadDetailResumeCursors.ts
// Purpose: Per-environment, per-thread resume cursors so resubscribes replay only the event gap.
// Layer: Web subscription utility
// Exports: the environment-scoped cursor store accessor and test reset.

import type { EnvironmentId, OrchestrationSubscribeThreadInput, ThreadId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

// Invariant: a cursor exists for a thread only while the store's cached detail
// is coherent up to that sequence. The store projection layer enforces this
// structurally — every transition that wipes detail slices (thread removal,
// eviction, full-sync pruning) drops the cursor in the same step — and the
// subscription layer covers the store-independent paths (dead stream, snapshot
// discarded before application). A cursor without its detail would make a
// resubscribe resume on top of missing history.
//
// Second invariant: sequences are per-server SQLite autoincrement values, so a
// cursor is only meaningful against the environment whose journal issued it.
// There is no global ordering across environments — hence the outer key. A
// server-identity change within one environment drops that environment's
// cursors only (see ThreadDetailResumeCursorScope.resetAll).
const cursorsByEnvironmentId = new Map<EnvironmentId, Map<ThreadId, number>>();

function cursorsFor(environmentId: EnvironmentId): Map<ThreadId, number> {
  const existing = cursorsByEnvironmentId.get(environmentId);
  if (existing) return existing;
  const created = new Map<ThreadId, number>();
  cursorsByEnvironmentId.set(environmentId, created);
  return created;
}

export interface ThreadDetailResumeCursorScope {
  readonly environmentId: EnvironmentId;
  /** Advance-only write for live/replayed events applied on top of cached detail. */
  advance(threadId: ThreadId, sequence: number): void;
  /**
   * Overwrite for snapshot application. A snapshot replaces cached detail
   * wholesale, so its fence is authoritative even when it is lower than the
   * previous cursor (server restored from backup or rejected a stale cursor).
   */
  set(threadId: ThreadId, sequence: number): void;
  get(threadId: ThreadId): number | undefined;
  has(threadId: ThreadId): boolean;
  clear(threadId: ThreadId): void;
  clearMany(threadIds: readonly ThreadId[]): void;
  /**
   * Drops every cursor whose thread is not in the surviving set. Full-sync
   * projections use this: they prune detail slices down to the threads the
   * snapshot reports, and any cursor for a pruned thread would vouch for detail
   * that no longer exists.
   */
  retain(threadIds: ReadonlySet<ThreadId>): void;
  /**
   * Drops every cursor in this environment. Called when the environment's
   * transport observes a new server instance: sequences are only comparable
   * within the journal that issued them, and a different instance may serve a
   * journal with an unrelated sequence space. This trades resume-across-restart
   * for correctness until the protocol carries a durable journal epoch. Other
   * environments keep their cursors — their journals did not change.
   */
  resetAll(): void;
  /**
   * Subscription input for a thread stream: cursor resume when cached detail is
   * still valid, full-history snapshot otherwise. Every subscribeThread call
   * must go through this so the cursor decision lives in exactly one place.
   */
  buildSubscribeInput(threadId: ThreadId): OrchestrationSubscribeThreadInput;
}

const scopeByEnvironmentId = new Map<EnvironmentId, ThreadDetailResumeCursorScope>();

/**
 * Cursor accessor for one environment. Scopes are memoized so callers can hold
 * the returned object across renders without re-deriving identity.
 */
export function threadDetailResumeCursors(
  environmentId: EnvironmentId,
): ThreadDetailResumeCursorScope {
  const existing = scopeByEnvironmentId.get(environmentId);
  if (existing) return existing;

  const scope: ThreadDetailResumeCursorScope = {
    environmentId,
    advance(threadId, sequence) {
      const cursors = cursorsFor(environmentId);
      const current = cursors.get(threadId);
      if (current === undefined || sequence > current) {
        cursors.set(threadId, sequence);
      }
    },
    set(threadId, sequence) {
      cursorsFor(environmentId).set(threadId, sequence);
    },
    get(threadId) {
      return cursorsByEnvironmentId.get(environmentId)?.get(threadId);
    },
    has(threadId) {
      return cursorsByEnvironmentId.get(environmentId)?.has(threadId) ?? false;
    },
    clear(threadId) {
      cursorsByEnvironmentId.get(environmentId)?.delete(threadId);
    },
    clearMany(threadIds) {
      const cursors = cursorsByEnvironmentId.get(environmentId);
      if (!cursors) return;
      for (const threadId of threadIds) {
        cursors.delete(threadId);
      }
    },
    retain(threadIds) {
      const cursors = cursorsByEnvironmentId.get(environmentId);
      if (!cursors) return;
      for (const threadId of cursors.keys()) {
        if (!threadIds.has(threadId)) {
          cursors.delete(threadId);
        }
      }
    },
    resetAll() {
      cursorsByEnvironmentId.get(environmentId)?.clear();
    },
    buildSubscribeInput(threadId) {
      const afterSequence = cursorsByEnvironmentId.get(environmentId)?.get(threadId);
      return afterSequence === undefined ? { threadId } : { threadId, afterSequence };
    },
  };
  scopeByEnvironmentId.set(environmentId, scope);
  return scope;
}

/**
 * Cursors for the server that serves this page. Migration seam: UI modules that
 * are not yet environment-aware read through here, so the places that still
 * assume a single environment stay greppable as multi-server UI lands.
 */
export function localThreadDetailResumeCursors(): ThreadDetailResumeCursorScope {
  return threadDetailResumeCursors(LOCAL_ENVIRONMENT_ID);
}

/**
 * Drops one environment's cursors when its transport goes away for good
 * (deregistered, or replaced after disposal).
 *
 * `adoptNegotiation` can only detect a journal change by comparing against the
 * instance id its own transport last observed, and a replacement transport has
 * observed none. A cursor that outlived its transport is therefore
 * unverifiable: if the environment returns as a different instance, that
 * instance is the new transport's first, no reset fires, and the stale cursor
 * silently resumes against an unrelated sequence space — skipping every event
 * below it. Discarding on removal costs one full snapshot and removes the
 * possibility.
 */
export function discardEnvironmentResumeCursors(environmentId: EnvironmentId): void {
  cursorsByEnvironmentId.delete(environmentId);
}

export function resetThreadDetailResumeCursorsForTests(): void {
  cursorsByEnvironmentId.clear();
}
