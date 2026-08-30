import { Duration, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import {
  consecutiveUpstreamRefreshFailures,
  statusUpstreamRefreshCacheTimeToLive,
} from "./GitCore.ts";

const REMOTE = "origin";

describe("statusUpstreamRefreshCacheTimeToLive (#515)", () => {
  beforeEach(() => {
    consecutiveUpstreamRefreshFailures.clear();
  });

  it("keeps successful upstream refreshes warm for 15 seconds", () => {
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(Exit.succeed("refreshed")))).toBe(
      15_000,
    );
  });

  it("caches handled failures for 30 seconds instead of Duration.zero", () => {
    const failed = Exit.succeed("failed" as const);
    // A zero TTL re-ran fetch on every git.status for unreachable remotes.
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed))).toBe(30_000);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed))).toBeGreaterThan(0);
  });

  it("throttles failures at least as long as successes", () => {
    const successMs = Duration.toMillis(
      statusUpstreamRefreshCacheTimeToLive(Exit.succeed("refreshed")),
    );
    const failureMs = Duration.toMillis(
      statusUpstreamRefreshCacheTimeToLive(Exit.succeed("failed")),
    );
    expect(failureMs).toBeGreaterThanOrEqual(successMs);
  });

  it("backs off failures exponentially per remote, capping at 5 minutes", () => {
    const key = { remoteName: REMOTE };
    const failed = Exit.succeed("failed" as const);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, key))).toBe(30_000);

    consecutiveUpstreamRefreshFailures.set(REMOTE, 1);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, key))).toBe(60_000);

    consecutiveUpstreamRefreshFailures.set(REMOTE, 2);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, key))).toBe(120_000);

    consecutiveUpstreamRefreshFailures.set(REMOTE, 3);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, key))).toBe(240_000);

    consecutiveUpstreamRefreshFailures.set(REMOTE, 4);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, key))).toBe(300_000);

    consecutiveUpstreamRefreshFailures.set(REMOTE, 5);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, key))).toBe(300_000);
  });

  it("resets failure backoff independently per remote", () => {
    const originKey = { remoteName: "origin" };
    const forkKey = { remoteName: "fork" };
    const failed = Exit.succeed("failed" as const);

    consecutiveUpstreamRefreshFailures.set("origin", 4);
    consecutiveUpstreamRefreshFailures.set("fork", 1);

    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, originKey))).toBe(
      300_000,
    );
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed, forkKey))).toBe(60_000);
  });
});
