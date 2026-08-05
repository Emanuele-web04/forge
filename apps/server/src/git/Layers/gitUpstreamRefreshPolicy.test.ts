import { Duration, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { statusUpstreamRefreshCacheTimeToLive } from "./GitCore.ts";

describe("statusUpstreamRefreshCacheTimeToLive (#515)", () => {
  it("keeps successful upstream refreshes warm for 15 seconds", () => {
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(Exit.void))).toBe(15_000);
  });

  it("caches failures for 30 seconds instead of Duration.zero", () => {
    const failed = Exit.fail(new Error("git fetch timed out"));
    // A zero TTL re-ran fetch on every git.status for unreachable remotes.
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed))).toBe(30_000);
    expect(Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(failed))).toBeGreaterThan(0);
  });

  it("throttles failures at least as long as successes", () => {
    const successMs = Duration.toMillis(statusUpstreamRefreshCacheTimeToLive(Exit.void));
    const failureMs = Duration.toMillis(
      statusUpstreamRefreshCacheTimeToLive(Exit.fail("unreachable")),
    );
    expect(failureMs).toBeGreaterThanOrEqual(successMs);
  });
});
