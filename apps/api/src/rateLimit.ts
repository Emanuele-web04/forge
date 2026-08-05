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
 * Sliding window over per-key hit timestamps. Deliberately process-local: it
 * exists to keep a single instance from being turned into a free amplifier
 * against WorkOS, not to enforce a quota across a fleet — a distributed limit
 * would need shared state this service does not have.
 *
 * Expired keys are pruned as they are touched and, to bound a burst of
 * one-shot keys that are never seen again, in a sweep once the map grows past
 * `pruneThreshold`. No timer, so nothing keeps the process (or a test) alive.
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

  return {
    tryConsume(key) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;

      if (hits.size > pruneThreshold) {
        for (const [existingKey, timestamps] of hits) {
          const live = liveHits(timestamps, cutoff);
          if (live.length === 0) hits.delete(existingKey);
          else hits.set(existingKey, live);
        }
      }

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
