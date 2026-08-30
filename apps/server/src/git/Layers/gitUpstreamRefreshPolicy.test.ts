import { Duration, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeStatusUpstreamRefreshCacheTimeToLive } from "./GitCore.ts";

describe("status-upstream-refresh cache TTL (#515)", () => {
  let policy: ReturnType<typeof makeStatusUpstreamRefreshCacheTimeToLive>;

  beforeEach(() => {
    policy = makeStatusUpstreamRefreshCacheTimeToLive();
  });

  it("keeps successful upstream refreshes warm for 15 seconds", () => {
    expect(Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed")))).toBe(15_000);
  });

  it("caches handled failures for 30 seconds instead of Duration.zero", () => {
    const failed = Exit.succeed("failed" as const);
    // A zero TTL re-ran fetch on every git.status for unreachable remotes.
    expect(Duration.toMillis(policy.timeToLive(failed))).toBe(30_000);
    expect(Duration.toMillis(policy.timeToLive(failed))).toBeGreaterThan(0);
  });

  it("throttles failures at least as long as successes", () => {
    const successMs = Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed")));
    const failureMs = Duration.toMillis(policy.timeToLive(Exit.succeed("failed")));
    expect(failureMs).toBeGreaterThanOrEqual(successMs);
  });

  it("backs off failures exponentially per remote, capping at 5 minutes", () => {
    const key = { remoteName: "origin" };
    const failed = Exit.succeed("failed" as const);
    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(30_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(60_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(120_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(240_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(300_000);

    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(300_000);
  });

  it("resets failure backoff independently per remote", () => {
    const originKey = { remoteName: "origin" };
    const forkKey = { remoteName: "fork" };
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

  it("resets a remote's backoff after a successful refresh", () => {
    const key = { remoteName: "origin" };
    const failed = Exit.succeed("failed" as const);

    policy.timeToLive(failed, key);
    policy.timeToLive(failed, key);
    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(120_000);

    expect(Duration.toMillis(policy.timeToLive(Exit.succeed("refreshed"), key))).toBe(15_000);

    // After success the remote is back to the baseline failure TTL.
    expect(Duration.toMillis(policy.timeToLive(failed, key))).toBe(30_000);
  });
});
