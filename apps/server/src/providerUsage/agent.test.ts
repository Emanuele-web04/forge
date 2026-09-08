import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  AGENT_PROVIDER_USAGE_MAX_AGE_MS,
  summarizeProviderUsageForAgent,
  summarizeProviderUsageListForAgent,
} from "./agent";

const NOW_MS = Date.parse("2026-09-08T18:00:00.000Z");

function snapshot(
  overrides: Partial<ServerProviderUsageSnapshot> = {},
): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    updatedAt: new Date(NOW_MS).toISOString(),
    limits: [
      { window: "5h", usedPercent: 40, resetsAt: "2026-09-08T20:00:00.000Z" },
      { window: "Weekly", usedPercent: 75, resetsAt: "2026-09-12T00:00:00.000Z" },
    ],
    usageLines: [{ label: "24h", value: "10K tokens" }],
    source: "codex-usage-api",
    status: "ok",
    ...overrides,
  };
}

describe("summarizeProviderUsageForAgent", () => {
  it("keeps quota windows separate and derives remaining percent with provenance", () => {
    const result = summarizeProviderUsageForAgent({
      provider: "codex",
      enabled: true,
      snapshot: snapshot(),
      checkedAtMs: NOW_MS,
    });

    expect(result.availability).toBe("available");
    expect(result.quotaWindows).toEqual([
      {
        window: "5h",
        availability: "available",
        usedPercent: 40,
        remainingPercent: 60,
        resetsAt: "2026-09-08T20:00:00.000Z",
        source: "codex-usage-api",
        observedAt: "2026-09-08T18:00:00.000Z",
      },
      {
        window: "Weekly",
        availability: "available",
        usedPercent: 75,
        remainingPercent: 25,
        resetsAt: "2026-09-12T00:00:00.000Z",
        source: "codex-usage-api",
        observedAt: "2026-09-08T18:00:00.000Z",
      },
    ]);
    expect(result.snapshot?.usageLines[0]).toMatchObject({
      value: "10K tokens",
      source: "codex-usage-api",
      observedAt: "2026-09-08T18:00:00.000Z",
    });
  });

  it("never promotes informational token or spend lines into quota", () => {
    const result = summarizeProviderUsageForAgent({
      provider: "codex",
      enabled: true,
      snapshot: snapshot({ limits: [] }),
      checkedAtMs: NOW_MS,
    });

    expect(result.availability).toBe("unavailable");
    expect(result.unavailableReason).toBe("missing-quota");
    expect(result.quotaWindows).toEqual([]);
    expect(result.snapshot?.usageLines).toHaveLength(1);
  });

  it("marks unknown and expired limits unavailable instead of exposing percentages", () => {
    const result = summarizeProviderUsageForAgent({
      provider: "codex",
      enabled: true,
      snapshot: snapshot({
        limits: [
          { window: "Unknown", resetsAt: "2026-09-10T00:00:00.000Z" },
          { window: "Expired", usedPercent: 50, resetsAt: "2026-09-08T17:00:00.000Z" },
          { window: "Weekly", usedPercent: 10 },
        ],
      }),
      checkedAtMs: NOW_MS,
    });

    expect(result.availability).toBe("partial");
    expect(result.quotaWindows[0]).toMatchObject({
      availability: "unavailable",
      unavailableReason: "missing-quota",
    });
    expect(result.quotaWindows[1]).toMatchObject({
      availability: "unavailable",
      unavailableReason: "expired-window",
    });
    expect(result.quotaWindows[1]).not.toHaveProperty("remainingPercent");
    expect(result.quotaWindows[2]).toMatchObject({
      availability: "available",
      remainingPercent: 90,
    });
  });

  it.each([
    [{ status: "needs-auth" as const }, "needs-auth"],
    [{ status: "unsupported" as const }, "unsupported"],
    [{ status: "error" as const }, "provider-error"],
    [{ stale: true }, "stale"],
  ])("maps unavailable snapshot state %j to %s", (overrides, reason) => {
    const result = summarizeProviderUsageForAgent({
      provider: "codex",
      enabled: true,
      snapshot: snapshot(overrides),
      checkedAtMs: NOW_MS,
    });

    expect(result.availability).toBe("unavailable");
    expect(result.unavailableReason).toBe(reason);
    expect(result.quotaWindows).toEqual([]);
  });

  it("rejects snapshots beyond the actionable freshness bound", () => {
    const result = summarizeProviderUsageForAgent({
      provider: "codex",
      enabled: true,
      snapshot: snapshot({
        updatedAt: new Date(NOW_MS - AGENT_PROVIDER_USAGE_MAX_AGE_MS - 1).toISOString(),
      }),
      checkedAtMs: NOW_MS,
    });

    expect(result.availability).toBe("unavailable");
    expect(result.unavailableReason).toBe("stale");
    expect(result.quotaWindows).toEqual([]);
  });

  it("reports disabled, missing, and timed-out reads explicitly", () => {
    expect(
      summarizeProviderUsageForAgent({
        provider: "codex",
        enabled: false,
        snapshot: null,
        checkedAtMs: NOW_MS,
      }).unavailableReason,
    ).toBe("disabled");
    expect(
      summarizeProviderUsageForAgent({
        provider: "codex",
        enabled: true,
        snapshot: null,
        checkedAtMs: NOW_MS,
      }).unavailableReason,
    ).toBe("missing-snapshot");
    expect(
      summarizeProviderUsageForAgent({
        provider: "codex",
        enabled: true,
        snapshot: null,
        timedOut: true,
        checkedAtMs: NOW_MS,
      }).unavailableReason,
    ).toBe("timed-out");
  });
});

describe("summarizeProviderUsageListForAgent", () => {
  it("preserves requested provider order and missing coverage", () => {
    const providers: ProviderKind[] = ["codex", "claudeAgent", "cursor"];
    const result = summarizeProviderUsageListForAgent({
      providers,
      enabledProviders: new Set(providers),
      snapshots: [snapshot()],
      checkedAtMs: NOW_MS,
    });

    expect(result.map((entry) => entry.provider)).toEqual(providers);
    expect(result.map((entry) => entry.unavailableReason ?? "available")).toEqual([
      "available",
      "missing-snapshot",
      "missing-snapshot",
    ]);
  });
});
