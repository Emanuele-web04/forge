// FILE: threadDetailResumeCursors.ts
// Purpose: Per-thread resume cursors so resubscribes replay only the event gap.
// Layer: Web subscription utility
// Exports: Cursor read/advance/clear helpers and the subscribe-input builder.

import type { OrchestrationSubscribeThreadInput, ThreadId } from "@synara/contracts";

// Invariant: a cursor exists for a thread only while the store's cached detail
// is coherent up to that sequence. The store projection layer enforces this
// structurally — every transition that wipes detail slices (thread removal,
// eviction, full-sync pruning) drops the cursor in the same step — and the
// subscription layer covers the store-independent paths (dead stream, snapshot
// discarded before application). A cursor without its detail would make a
// resubscribe resume on top of missing history.
//
// A cursor is also only meaningful against the server journal that issued its
// sequences, so a server-identity change must drop all of them (see
// resetThreadDetailResumeCursors).
const resumeCursorByThreadId = new Map<ThreadId, number>();

/** Advance-only write for live/replayed events applied on top of cached detail. */
export function advanceThreadDetailResumeCursor(threadId: ThreadId, sequence: number): void {
  const current = resumeCursorByThreadId.get(threadId);
  if (current === undefined || sequence > current) {
    resumeCursorByThreadId.set(threadId, sequence);
  }
}

/**
 * Overwrite for snapshot application. A snapshot replaces cached detail
 * wholesale, so its fence is authoritative even when it is lower than the
 * previous cursor (server restored from backup or rejected a stale cursor).
 */
export function setThreadDetailResumeCursor(threadId: ThreadId, sequence: number): void {
  resumeCursorByThreadId.set(threadId, sequence);
}

export function getThreadDetailResumeCursor(threadId: ThreadId): number | undefined {
  return resumeCursorByThreadId.get(threadId);
}

export function hasThreadDetailResumeCursor(threadId: ThreadId): boolean {
  return resumeCursorByThreadId.has(threadId);
}

export function clearThreadDetailResumeCursor(threadId: ThreadId): void {
  resumeCursorByThreadId.delete(threadId);
}

/**
 * Drops every cursor whose thread is not in the surviving set. Full-sync
 * projections use this: they prune detail slices down to the threads the
 * snapshot reports, and any cursor for a pruned thread would vouch for detail
 * that no longer exists.
 */
export function retainThreadDetailResumeCursors(threadIds: ReadonlySet<ThreadId>): void {
  for (const threadId of resumeCursorByThreadId.keys()) {
    if (!threadIds.has(threadId)) {
      resumeCursorByThreadId.delete(threadId);
    }
  }
}

/**
 * Drops all cursors. Called when the transport observes a new server instance:
 * sequences are only comparable within the journal that issued them, and a
 * different instance may serve a journal with an unrelated sequence space.
 * This trades resume-across-server-restart for correctness until the protocol
 * carries a durable journal epoch the cursor can be validated against.
 */
export function resetThreadDetailResumeCursors(): void {
  resumeCursorByThreadId.clear();
}

/**
 * Subscription input for a thread stream: cursor resume when cached detail is
 * still valid, full-history snapshot otherwise. Every subscribeThread call must
 * go through this so the cursor decision lives in exactly one place.
 */
export function buildThreadSubscribeInput(threadId: ThreadId): OrchestrationSubscribeThreadInput {
  const afterSequence = resumeCursorByThreadId.get(threadId);
  return afterSequence === undefined ? { threadId } : { threadId, afterSequence };
}

export function resetThreadDetailResumeCursorsForTests(): void {
  resetThreadDetailResumeCursors();
}
