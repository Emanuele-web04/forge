// FILE: providerUsage/rateLimitResilience.test.ts
// Purpose: Unit-covers the shared last-good/cooldown helper: serving cached usage while throttled,
// clamping a hostile Retry-After, per-account keying, and reset.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "./http";
import { createRateLimitResilience, MAX_RATE_LIMIT_COOLDOWN_MS } from "./rateLimitResilience";

const NOW_MS = 1_780_000_000_000;

function makeResilience() {
  return createRateLimitResilience({
    provider: "claudeAgent",
    source: "test",
    detail: (retryMins) => `throttled, retrying in ~${retryMins}m`,
  });
}

function goodSnapshot(): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [{ window: "5h", usedPercent: 42, windowDurationMins: 300 }],
    usageLines: [],
    source: "test",
    status: "ok",
  };
}

describe("createRateLimitResilience", () => {
  it("serves the last good snapshot with a staleness note while throttled", () => {
    const resilience = makeResilience();
    resilience.rememberLastGood("home", goodSnapshot(), NOW_MS);

    const served = resilience.enterCooldown("home", NOW_MS, 120_000);
    expect(served.status).toBe("ok");
    expect(served.limits[0]?.usedPercent).toBe(42);
    expect(served.detail).toContain("~2m");

    // Subsequent polls inside the window keep serving the cache.
    const cached = resilience.serveDuringCooldown("home", NOW_MS + 30_000);
    expect(cached?.status).toBe("ok");
    expect(cached?.limits[0]?.usedPercent).toBe(42);
  });

  it("surfaces an error snapshot when throttled before any good fetch", () => {
    const resilience = makeResilience();

    const served = resilience.enterCooldown("home", NOW_MS, undefined);
    expect(served.status).toBe("error");
    expect(served.detail).toContain("~5m");
    expect(served.limits).toHaveLength(0);

    // The cooldown must keep short-circuiting so we don't hammer the throttled endpoint.
    expect(resilience.serveDuringCooldown("home", NOW_MS + 60_000)?.status).toBe("error");
  });

  it("clamps a hostile Retry-After to the maximum cooldown", () => {
    const resilience = makeResilience();

    resilience.enterCooldown("home", NOW_MS, 24 * 60 * 60 * 1000);
    // Just before the cap it is still cooling down; just after, it lets a live fetch through again.
    expect(
      resilience.serveDuringCooldown("home", NOW_MS + MAX_RATE_LIMIT_COOLDOWN_MS - 1),
    ).not.toBeNull();
    expect(resilience.serveDuringCooldown("home", NOW_MS + MAX_RATE_LIMIT_COOLDOWN_MS)).toBeNull();
  });

  it("keys cooldowns per account so one login can't leak into another", () => {
    const resilience = makeResilience();
    resilience.rememberLastGood("account-a", goodSnapshot(), NOW_MS);
    resilience.enterCooldown("account-a", NOW_MS, 120_000);

    expect(resilience.serveDuringCooldown("account-a", NOW_MS)).not.toBeNull();
    expect(resilience.serveDuringCooldown("account-b", NOW_MS)).toBeNull();
  });

  it("marks re-served snapshots stale and keeps their original fetch time", () => {
    const resilience = makeResilience();
    resilience.rememberLastGood("home", goodSnapshot(), NOW_MS);

    const served = resilience.enterCooldown("home", NOW_MS, 120_000);
    expect(served.stale).toBe(true);
    // `updatedAt` still says when the data was actually fetched, not when it was re-served.
    expect(served.updatedAt).toBe("2026-06-09T12:00:00.000Z");
    // Fresh snapshots never carry the flag.
    expect(goodSnapshot().stale).toBeUndefined();
  });

  it("keeps active cooldowns even when the soft tracking cap is exceeded", () => {
    const resilience = makeResilience();
    for (let index = 0; index < 40; index += 1) {
      resilience.rememberLastGood(`account-${index}`, goodSnapshot(), NOW_MS);
      resilience.enterCooldown(`account-${index}`, NOW_MS, 120_000);
    }

    expect(resilience.serveDuringCooldown("account-0", NOW_MS)).not.toBeNull();
    expect(resilience.serveDuringCooldown("account-39", NOW_MS)).not.toBeNull();
  });

  it("evicts an expired cooldown before exceeding the soft tracking cap", () => {
    const resilience = makeResilience();
    for (let index = 0; index < 32; index += 1) {
      resilience.rememberLastGood(`account-${index}`, goodSnapshot(), NOW_MS);
      resilience.enterCooldown(`account-${index}`, NOW_MS, 60_000);
    }

    const later = NOW_MS + 90_000;
    resilience.rememberLastGood("new-account", goodSnapshot(), later);
    resilience.enterCooldown("new-account", later, 60_000);

    expect(resilience.serveDuringCooldown("account-0", later)).toBeNull();
    expect(resilience.serveDuringCooldown("new-account", later)).not.toBeNull();
  });

  it("returns nothing outside a cooldown and after reset", () => {
    const resilience = makeResilience();
    resilience.rememberLastGood("home", goodSnapshot(), NOW_MS);
    expect(resilience.serveDuringCooldown("home", NOW_MS)).toBeNull();

    resilience.enterCooldown("home", NOW_MS, 120_000);
    resilience.reset();
    expect(resilience.serveDuringCooldown("home", NOW_MS)).toBeNull();
  });
});

describe("parseRetryAfterMs", () => {
  it("parses digit-only delta seconds and HTTP dates", () => {
    expect(parseRetryAfterMs(new Headers({ "Retry-After": " 120 " }), 0)).toBe(120_000);

    const nowMs = Date.parse("2026-10-21T07:27:00.000Z");
    const retryAt = new Date(nowMs + 60_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ "Retry-After": retryAt }), nowMs)).toBe(60_000);
  });

  it("rejects non-HTTP numeric spellings", () => {
    const invalidValues = ["1e3", "0x10", "1.5", "+10", "-10"];
    for (const value of invalidValues) {
      expect(parseRetryAfterMs(new Headers({ "Retry-After": value }), 0)).toBeUndefined();
    }
  });

  it("rejects zero and unsafe delta values", () => {
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "0" }), 0)).toBeUndefined();
    const unsafeSeconds = String(Number.MAX_SAFE_INTEGER);
    expect(parseRetryAfterMs(new Headers({ "Retry-After": unsafeSeconds }), 0)).toBeUndefined();
  });
});
