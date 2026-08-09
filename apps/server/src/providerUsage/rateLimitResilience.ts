// FILE: providerUsage/rateLimitResilience.ts
// Purpose: Shared "keep last-good + back off" resilience for live usage fetchers. When a provider's
// usage endpoint throttles (HTTP 429) or blips, blanking the panel is worse than showing slightly
// stale numbers — so we remember the last clean snapshot per account and keep serving it (with a
// staleness note) during a cooldown that honors Retry-After, while skipping live calls so we don't
// pile on more 429s. Any fetcher can opt in via createRateLimitResilience; keeping the state
// here avoids duplicating the bookkeeping per provider.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";

import { errorSnapshot } from "./parse";

/** Fallback backoff when a 429 carries no usable Retry-After header. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/** Upper bound on a cooldown so a huge/hostile Retry-After can't freeze usage on stale data for hours. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
/**
 * Cap on tracked credential fingerprints per resilience instance. Keys are derived from on-disk
 * credentials, so churn (re-logins rotating tokens) would otherwise grow the map without bound
 * over a long-lived server process. Writes re-insert their entry so Map iteration order is
 * least-recently-written first, making oldest-key eviction safe.
 */
const MAX_TRACKED_KEYS = 32;

interface ResilienceEntry {
  lastGoodSnapshot: ServerProviderUsageSnapshot | null;
  cooldownUntilMs: number;
}

export interface RateLimitResilience {
  /** Snapshot to serve while `key` is throttled, or null when no cooldown is active for it. */
  serveDuringCooldown(key: string, nowMs: number): ServerProviderUsageSnapshot | null;
  /** Record a clean fetch and clear any cooldown for `key`. */
  rememberLastGood(key: string, snapshot: ServerProviderUsageSnapshot, nowMs: number): void;
  /** Begin a cooldown for `key` honoring Retry-After (clamped), then return the snapshot to serve. */
  enterCooldown(
    key: string,
    nowMs: number,
    retryAfterMs: number | undefined,
  ): ServerProviderUsageSnapshot;
  /** Test-only: drop all remembered state. */
  reset(): void;
}

export function createRateLimitResilience(options: {
  provider: ProviderKind;
  source: string;
  /** Builds the throttle note shown on the served snapshot, given the rounded minutes until retry. */
  detail: (retryMins: number) => string;
  defaultCooldownMs?: number;
  maxCooldownMs?: number;
}): RateLimitResilience {
  const defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const maxCooldownMs = options.maxCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS;
  const store = new Map<string, ResilienceEntry>();

  const entryFor = (key: string, nowMs: number): ResilienceEntry => {
    const existing = store.get(key);
    if (existing) {
      // Re-insert so iteration order tracks write recency for eviction.
      store.delete(key);
      store.set(key, existing);
      return existing;
    }
    // Prefer the oldest inactive entry, but never discard an account while its cooldown is
    // active: doing so would resume requests against an endpoint that explicitly throttled us.
    // The store may temporarily exceed the soft cap when more than 32 accounts are simultaneously
    // cooling down; later insertions prune expired entries back toward the bound.
    if (store.size >= MAX_TRACKED_KEYS) {
      for (const [candidateKey, candidate] of store) {
        if (candidate.cooldownUntilMs <= nowMs) {
          store.delete(candidateKey);
          break;
        }
      }
    }
    const entry: ResilienceEntry = { lastGoodSnapshot: null, cooldownUntilMs: 0 };
    store.set(key, entry);
    return entry;
  };

  const detailFor = (entry: ResilienceEntry, nowMs: number): string =>
    options.detail(Math.max(1, Math.ceil((entry.cooldownUntilMs - nowMs) / 60_000)));

  // The last clean fetch with a staleness note when we have it, otherwise an error snapshot that at
  // least explains the throttle. The last-good note rides on `status: "ok"` so the UI keeps rendering
  // the limits instead of hiding the section on a non-ok snapshot; `stale: true` (with the original
  // `updatedAt`) lets consumers tell a re-served snapshot from a fresh read.
  const snapshotForCooldown = (
    entry: ResilienceEntry,
    nowMs: number,
  ): ServerProviderUsageSnapshot => {
    const lastGood = entry.lastGoodSnapshot;
    return lastGood
      ? { ...lastGood, status: "ok", detail: detailFor(entry, nowMs), stale: true }
      : errorSnapshot(options.provider, nowMs, options.source, detailFor(entry, nowMs));
  };

  return {
    serveDuringCooldown(key, nowMs) {
      const entry = store.get(key);
      if (!entry || nowMs >= entry.cooldownUntilMs) {
        return null;
      }
      return snapshotForCooldown(entry, nowMs);
    },
    rememberLastGood(key, snapshot, nowMs) {
      const entry = entryFor(key, nowMs);
      entry.lastGoodSnapshot = snapshot;
      entry.cooldownUntilMs = 0;
    },
    enterCooldown(key, nowMs, retryAfterMs) {
      const entry = entryFor(key, nowMs);
      const backoffMs = Math.min(
        Math.max(retryAfterMs ?? defaultCooldownMs, 0) || defaultCooldownMs,
        maxCooldownMs,
      );
      entry.cooldownUntilMs = nowMs + backoffMs;
      return snapshotForCooldown(entry, nowMs);
    },
    reset() {
      store.clear();
    },
  };
}
