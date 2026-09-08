// FILE: rateLimit.ts
// Purpose: A minimal in-memory sliding-window rate limiter for unauthenticated
// endpoints that fan out to a paid upstream.
// Layer: API support
// Depends on: nothing.

export type RateLimiter = {
  /** True when this key is still under its allowance; records the hit. */
  tryConsume(key: string): boolean;
};

function liveHits(timestamps: number[] | undefined, cutoff: number): number[] {
  if (!timestamps) return [];
  return timestamps.filter((at) => at > cutoff);
}

/**
 * How many stored keys each request may examine for expiry. Amortized: a
 * burst of B one-shot keys is fully reclaimed within B/`PRUNE_BATCH` later
 * requests, and no single request ever pays for more than this many entries —
 * the failure mode the old whole-map sweep had, where an attacker minting
 * unique keys made every request past the threshold O(map size).
 */
const PRUNE_BATCH = 8;

/**
 * Sliding window over per-key hit timestamps. Deliberately process-local: it
 * exists to keep a single instance from being turned into a free amplifier
 * against WorkOS, not to enforce a quota across a fleet — a distributed limit
 * would need shared state this service does not have.
 *
 * Expired keys are pruned as they are touched and, once the map grows past
 * `pruneThreshold`, incrementally: each request walks at most
 * {@link PRUNE_BATCH} entries of the map in insertion order via a persistent
 * cursor, deleting the fully expired ones. Work per request is O(1); a burst
 * of one-shot keys is reclaimed across the requests that follow it. No timer,
 * so nothing keeps the process (or a test) alive.
 */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  pruneThreshold?: number;
}): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const pruneThreshold = options.pruneThreshold ?? 1024;
  const hits = new Map<string, number[]>();

  /**
   * Insertion-order cursor for incremental pruning. Invalidated (set to
   * undefined) whenever it finishes a pass; deletions during iteration are
   * safe on a Map, and a key re-inserted after deletion is simply visited
   * again on a later pass.
   */
  let pruneCursor: Iterator<[string, number[]]> | undefined;

  function pruneSome(cutoff: number): void {
    if (hits.size <= pruneThreshold) {
      pruneCursor = undefined;
      return;
    }
    pruneCursor ??= hits.entries();
    for (let step = 0; step < PRUNE_BATCH; step += 1) {
      const next = pruneCursor.next();
      if (next.done) {
        pruneCursor = undefined;
        return;
      }
      const [existingKey, timestamps] = next.value;
      const live = liveHits(timestamps, cutoff);
      if (live.length === 0) hits.delete(existingKey);
      else if (live.length !== timestamps.length) hits.set(existingKey, live);
    }
  }

  return {
    tryConsume(key) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;

      pruneSome(cutoff);

      const recent = liveHits(hits.get(key), cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(currentTime);
      hits.set(key, recent);
      return true;
    },
  };
}
