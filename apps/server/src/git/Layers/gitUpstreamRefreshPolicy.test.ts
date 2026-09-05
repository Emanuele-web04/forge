import { Duration, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeStatusUpstreamRefreshCacheTimeToLive } from "./GitCore.ts";

// The backoff map is keyed by the full status cache key, so every key needs
// all four fields; same-named remotes in different repositories must not
// share backoff state.
function cacheKey(
  overrides: Partial<{
    cwd: string;
    upstreamRef: string;
    remoteName: string;
    upstreamBranch: string;
  }> = {},
): { cwd: string; upstreamRef: string; remoteName: string; upstreamBranch: string } {
  return {
    cwd: "/repo",
    upstreamRef: "origin/main",
    remoteName: "origin",
    upstreamBranch: "main",
    ...overrides,
  };
}

describe("status-upstream-refresh cache TTL (#515)", () => {
  let policy: ReturnType<typeof makeStatusUpstreamRefreshCacheTimeToLive>;

  beforeEach(() => {
    policy = makeStatusUpstreamRefreshCacheTimeToLive();
  });

  it("keeps successful upstream refreshes warm for 15 seconds", () => {
    expect(Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed"), cacheKey()))).toBe(
      15_000,
    );
  });

  it("caches handled failures for 30 seconds instead of Duration.zero", () => {
    const failed = Exit.succeed("failed" as const);
    // A zero TTL re-ran fetch on every git.status for unreachable remotes.
    expect(Duration.toMillis(policy.timeToLive(failed, cacheKey()))).toBe(30_000);
  });

  it("throttles failures at least as long as successes", () => {
    const successMs = Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed"), cacheKey()));
    const failureMs = Duration.toMillis(policy.timeToLive(Exit.succeed("failed"), cacheKey()));
    expect(failureMs).toBeGreaterThanOrEqual(successMs);
  });

  it("backs off failures exponentially per remote, capping at 5 minutes", () => {
    const key = cacheKey();
    const failed = Exit.succeed("failed" as const);
    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(30_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(60_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(120_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(240_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(300_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(300_000);
  });

  it("resets failure backoff independently per remote", () => {
    const originKey = cacheKey();
    const forkKey = cacheKey({
      upstreamRef: "fork/main",
      remoteName: "fork",
      upstreamBranch: "main",
    });
    const failed = Exit.succeed("failed" as const);

    // Push origin to the cap.
    for (let index = 0; index < 5; index += 1) {
      policy.timeToLive(failed, originKey);
    }
    expect(Duration.toMillis(policy.timeToLive(failed, originKey))).toBe(300_000);

    // Fork starts from zero and only reaches the second backoff tier.
    expect(Duration.toMillis(policy.timeToLive(failed, forkKey))).toBe(30_000);
    expect(Duration.toMillis(policy.timeToLive(failed, forkKey))).toBe(60_000);
  });

  it("isolates backoff between repositories sharing a remote name", () => {
    const repoAKey = cacheKey({ cwd: "/repo-a" });
    const repoBKey = cacheKey({ cwd: "/repo-b" });
    const failed = Exit.succeed("failed" as const);

    // Push repo A's origin to the cap.
    for (let index = 0; index < 5; index += 1) {
      policy.timeToLive(failed, repoAKey);
    }
    expect(Duration.toMillis(policy.timeToLive(failed, repoAKey))).toBe(300_000);

    // Repo B's origin is a different cache key: it starts from zero instead of
    // inheriting repo A's poisoned backoff.
    expect(Duration.toMillis(policy.timeToLive(failed, repoBKey))).toBe(30_000);

    // A success in repo A only resets repo A's backoff.
    expect(Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed"), repoAKey))).toBe(15_000);
    expect(Duration.toMillis(policy.timeToLive(failed, repoBKey))).toBe(60_000);
  });

  it("bounds failure bookkeeping and keeps recently retried repositories", () => {
    const failed = Exit.succeed("failed" as const);
    const oldest = cacheKey({ cwd: "/repo-0" });
    for (let index = 0; index < 2_048; index += 1) {
      policy.timeToLive(failed, cacheKey({ cwd: `/repo-${index}` }));
    }
    policy.timeToLive(failed, oldest);
    policy.timeToLive(failed, cacheKey({ cwd: "/repo-new" }));
    expect(policy.getFailureCount(oldest)).toBe(2);
    expect(policy.getFailureCount(cacheKey({ cwd: "/repo-1" }))).toBe(0);
    expect(policy.getFailureCount(cacheKey({ cwd: "/repo-new" }))).toBe(1);
  });

  it("resets a remote's backoff after a successful refresh", () => {
    const key = cacheKey();
    const failed = Exit.succeed("failed" as const);

    policy.timeToLive(failed, key);
    policy.timeToLive(failed, key);
    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(120_000);

    expect(Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed"), key))).toBe(15_000);

    // After success the remote is back to the baseline failure TTL.
    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(30_000);
  });
});
