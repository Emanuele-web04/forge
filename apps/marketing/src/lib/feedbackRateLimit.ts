// FILE: feedbackRateLimit.ts
// Purpose: Rate limiting for /api/feedback that survives the Workers runtime.
// Layer: Server utility
// Depends on: Cloudflare rate limiting binding (FEEDBACK_RATE_LIMITER) when
//             present, in-process counters otherwise.

import "server-only";

/**
 * The in-process limiter this file replaces was a module-level Map. That works
 * on a long-lived Node server, where every request shares one process; on
 * Workers each isolate gets its own Map and isolates are many and short-lived,
 * so the limit stopped binding and /api/feedback was effectively unthrottled
 * against a paid upstream (Resend).
 *
 * Cloudflare's rate limiting binding is account-level state, so it holds across
 * isolates. Its `period` accepts only 10 or 60 seconds, so the durable layer
 * enforces a per-minute burst cap rather than the per-hour budget below. Both
 * run: the binding stops the abuse case (one source hammering the endpoint),
 * the in-process window keeps the friendlier hourly budget for the common case
 * where a person submits repeatedly against a warm isolate.
 */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
export const RATE_LIMIT_MAX_REQUESTS = 5;

/** Matches `simple.period` in wrangler.jsonc; used only for Retry-After. */
const BINDING_PERIOD_SECONDS = 60;

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the caller should wait. 0 when allowed. */
  retryAfter: number;
}

const rateLimits = new Map<string, RateLimitRecord>();

/** Cloudflare's binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit */
interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The binding is absent outside Workers (`bun run dev`, `next start` under the
 * SEO smoke test, `node --test`), so this resolves to null there and callers
 * fall back to the in-process window. Imported lazily because
 * @opennextjs/cloudflare cannot be loaded in a plain Node process.
 */
async function getBinding(): Promise<RateLimiterBinding | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as Record<string, unknown>;
    const binding = env.FEEDBACK_RATE_LIMITER;
    if (binding && typeof (binding as RateLimiterBinding).limit === "function") {
      return binding as RateLimiterBinding;
    }
    return null;
  } catch {
    return null;
  }
}

function consumeInProcess(key: string, now: number): RateLimitDecision {
  if (rateLimits.size > 2_000) {
    for (const [candidate, record] of rateLimits) {
      if (record.resetAt <= now) rateLimits.delete(candidate);
    }
  }

  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Records a hit for `key` and reports whether it is allowed. The durable check
 * runs first so a distributed flood is rejected before it can also fill the
 * in-process map.
 */
export async function consumeFeedbackRateLimit(
  key: string,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const binding = await getBinding();
  if (binding) {
    try {
      const { success } = await binding.limit({ key });
      if (!success) return { allowed: false, retryAfter: BINDING_PERIOD_SECONDS };
    } catch {
      // A binding failure must not take the endpoint down; the in-process
      // window below still applies.
    }
  }

  return consumeInProcess(key, now);
}

/** Test seam: drops in-process state between cases. */
export function resetFeedbackRateLimitForTests(): void {
  rateLimits.clear();
}
