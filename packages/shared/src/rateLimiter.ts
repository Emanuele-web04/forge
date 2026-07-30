// FILE: rateLimiter.ts
// Purpose: Small deterministic token-bucket rate limiter for server-side RPC
//          methods whose cost is paid off-box (spawning processes, dialing hosts).
// Layer: Shared runtime
// Exports: makeTokenBucketLimiter, type TokenBucketLimiter

export interface TokenBucketOptions {
  /** Maximum burst. */
  readonly capacity: number;
  /** Sustained rate. */
  readonly refillPerSecond: number;
  /** Injected clock; real callers pass `Date.now`. */
  readonly now?: () => number;
  /** Buckets untouched for this long are dropped so the map cannot grow forever. */
  readonly idleEvictionMs?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until the next token, when refused. */
  readonly retryAfterMs: number;
}

export interface TokenBucketLimiter {
  readonly take: (key: string) => RateLimitDecision;
  readonly size: () => number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

/**
 * Per-key token bucket.
 *
 * Rate limiting is enforced SERVER-side rather than by debouncing in the UI: a
 * probe spawns an ssh process and dials a third-party host, so an unthrottled
 * method is an outbound amplifier that a client — or a stuck retry loop in one —
 * can point at any address the server can reach.
 */
export function makeTokenBucketLimiter(options: TokenBucketOptions): TokenBucketLimiter {
  const now = options.now ?? Date.now;
  const idleEvictionMs = options.idleEvictionMs ?? 10 * 60_000;
  const buckets = new Map<string, Bucket>();

  const evictIdle = (nowMs: number): void => {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.updatedAtMs > idleEvictionMs) buckets.delete(key);
    }
  };

  return {
    take(key) {
      const nowMs = now();
      evictIdle(nowMs);
      const bucket = buckets.get(key) ?? { tokens: options.capacity, updatedAtMs: nowMs };
      const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1_000;
      const tokens = Math.min(
        options.capacity,
        bucket.tokens + elapsedSeconds * options.refillPerSecond,
      );

      if (tokens < 1) {
        // Keep the refilled value so a refused call still advances the clock, and
        // never reset the timestamp forward past the refill we just computed —
        // otherwise hammering the endpoint would starve the bucket indefinitely.
        buckets.set(key, { tokens, updatedAtMs: nowMs });
        return {
          allowed: false,
          retryAfterMs: Math.ceil(((1 - tokens) / options.refillPerSecond) * 1_000),
        };
      }

      buckets.set(key, { tokens: tokens - 1, updatedAtMs: nowMs });
      return { allowed: true, retryAfterMs: 0 };
    },
    size: () => buckets.size,
  };
}
