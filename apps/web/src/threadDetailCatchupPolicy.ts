// FILE: threadDetailCatchupPolicy.ts
// Purpose: Decide when a subscribed thread's periodic projection reconcile can be skipped.
// Layer: Web subscription policy (pure)
// Exports: ThreadDetailSyncEvidence, isThreadDetailVerifiedInSync
// Why: The root route polls every subscribed running thread on a fixed cadence: a cheap
//      `replayEvents` catch-up (returns the thread's events past the client cursor) and a
//      full `getThreadDetailSnapshot` projection reconcile that re-ships and re-normalizes
//      the entire transcript. The full reconcile exists to repair a client that silently
//      fell out of sync, but with several threads running it became a steady load of
//      multi-megabyte snapshot fetches (server read + JSON + schema decode + store merge)
//      even when every thread was provably current. An empty replay that resolved with no
//      detail event applied since is that proof for this thread: the server holds no
//      detail event past the cursor, so a projection built from those same events cannot
//      contain anything the client has not already applied. Verified threads let the
//      reconcile back off instead of fetching; anything that marks the thread as needing
//      repair (terminal fence, draft promotion, un-echoed dispatch) bypasses this policy,
//      and the caller still bounds the worst case with a periodic authoritative resync.

export interface ThreadDetailSyncEvidence {
  /**
   * Monotonic count of detail events applied to this thread (live or replayed). A
   * counter, not a timestamp: wall-clock time is neither monotonic nor fine-grained
   * enough to order an applied event against the replay that should have proven it.
   */
  readonly appliedEventSerial: number;
  /** `appliedEventSerial` observed when the latest replay resolved empty, or null if none. */
  readonly emptyReplayAtEventSerial: number | null;
}

/**
 * True when the most recent replay poll proved the client cursor at (or past) the server's
 * detail-event head for this thread and no event has been applied since that proof.
 */
export function isThreadDetailVerifiedInSync(evidence: ThreadDetailSyncEvidence): boolean {
  return (
    evidence.emptyReplayAtEventSerial !== null &&
    evidence.emptyReplayAtEventSerial === evidence.appliedEventSerial
  );
}
