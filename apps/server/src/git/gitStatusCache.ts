import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
} from "@synara/contracts";

import type { GitStatusDetails } from "./Services/GitCore";

export interface CachedValue<T> {
  readonly fingerprint: string;
  readonly updatedAt: number;
  readonly value: T;
}

export interface CachedGitStatus {
  readonly local: CachedValue<GitStatusLocalResult> | null;
  readonly remote: CachedValue<GitStatusRemoteResult | null> | null;
}

export const REMOTE_STATUS_CACHE_TTL_MS = 30_000;

/**
 * Upper bound on cached working directories.
 *
 * Synara creates a git worktree per thread, so `cwd` keys are effectively
 * thread-scoped and unbounded over a long-lived server. The cache is a pure
 * optimization behind a 30 s TTL — a miss just re-runs git — so evicting the least
 * recently written directory is always safe, and it keeps the copy-on-write update
 * below O(limit) instead of O(directories ever seen).
 */
export const GIT_STATUS_CACHE_MAX_ENTRIES = 64;

/**
 * Copy-on-write insert with least-recently-written eviction. Re-inserting the key
 * moves it to the end of `Map` iteration order, so the first key is always the
 * coldest entry.
 */
export function setCachedGitStatus(
  cache: ReadonlyMap<string, CachedGitStatus>,
  cwd: string,
  next: CachedGitStatus,
  maxEntries: number = GIT_STATUS_CACHE_MAX_ENTRIES,
): Map<string, CachedGitStatus> {
  const nextCache = new Map(cache);
  nextCache.delete(cwd);
  nextCache.set(cwd, next);
  while (nextCache.size > maxEntries) {
    const coldest = nextCache.keys().next().value;
    if (coldest === undefined) {
      break;
    }
    nextCache.delete(coldest);
  }
  return nextCache;
}

export function makeCachedStatusValue<T>(value: T): CachedValue<T> {
  return {
    fingerprint: JSON.stringify(value),
    updatedAt: Date.now(),
    value,
  };
}

export function splitLocalStatus(status: GitStatusResult): GitStatusLocalResult {
  return {
    branch: status.branch,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

export function splitLocalStatusDetails(status: GitStatusDetails): GitStatusLocalResult {
  return {
    branch: status.branch,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  };
}

export function splitRemoteStatus(status: GitStatusResult): GitStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    upstreamBranch: status.upstreamBranch,
    configuredPrBaseBranch: status.configuredPrBaseBranch,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: status.pr,
  };
}

export function splitRemoteStatusDetails(
  status: GitStatusDetails,
  cachedRemote: GitStatusRemoteResult | null,
): GitStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    upstreamBranch: status.upstreamBranch,
    configuredPrBaseBranch: status.configuredPrBaseBranch,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    pr: cachedRemote?.pr ?? null,
  };
}

/**
 * The half of the reuse decision that depends only on the cache.
 *
 * Callers check this *before* fetching fresh status details: when the cached remote
 * metadata is absent or expired the details can never be reused, so probing git for
 * them would only be thrown away and repeated by the full status load.
 */
export function isCachedRemoteStatusFresh(input: {
  readonly cached: CachedGitStatus;
  readonly now?: number;
  readonly ttlMs?: number;
}): boolean {
  const remote = input.cached.remote;
  if (!input.cached.local || !remote?.value) return false;
  return (input.now ?? Date.now()) - remote.updatedAt < (input.ttlMs ?? REMOTE_STATUS_CACHE_TTL_MS);
}

export function canReuseCachedRemoteStatus(input: {
  readonly cached: CachedGitStatus;
  readonly details: GitStatusDetails;
  readonly now?: number;
  readonly ttlMs?: number;
}): boolean {
  if (!isCachedRemoteStatusFresh(input)) return false;
  if (input.details.branch !== input.cached.local?.value.branch) return false;
  return input.details.upstreamBranch === input.cached.remote?.value?.upstreamBranch;
}
