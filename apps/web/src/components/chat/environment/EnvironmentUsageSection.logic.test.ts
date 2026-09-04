import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";

import { resolveEnvironmentProviderUsageSummary } from "./EnvironmentUsageSection.logic";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    updatedAt: "2026-08-30T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    status: "ok",
    ...input,
  };
}

describe("resolveEnvironmentProviderUsageSummary", () => {
  it("keeps both the five-hour and weekly limits in compact display order", () => {
    const providerSnapshot = snapshot({
      limits: [
        { window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 },
        { window: "5h", usedPercent: 5, windowDurationMins: 300 },
      ],
    });
    const rows = deriveProviderUsageDisplayRows([
      {
        provider: providerSnapshot.provider,
        updatedAt: providerSnapshot.updatedAt,
        limits: providerSnapshot.limits,
      },
    ]);

    const summary = resolveEnvironmentProviderUsageSummary({
      providerName: "Codex",
      rows,
      snapshot: providerSnapshot,
      hasUsageLines: false,
    });

    expect(summary.rows.map((row) => [row.label, row.remainingLabel])).toEqual([
      ["5h", "95%"],
      ["Weekly", "82%"],
    ]);
    expect(summary.ariaLabel).toBe("Codex usage: 5h 95% remaining, Weekly 82% remaining");
  });

  it.each([
    ["needs-auth", "Sign in"],
    ["unsupported", "Unsupported"],
    ["error", "Unavailable"],
    ["ok", "No data"],
  ] as const)("uses the %s fallback when no limit rows are available", (status, label) => {
    const providerSnapshot = snapshot({ status });

    const summary = resolveEnvironmentProviderUsageSummary({
      providerName: "Codex",
      rows: [],
      snapshot: providerSnapshot,
      hasUsageLines: false,
    });

    expect(summary.statusLabel).toBe(label);
    expect(summary.ariaLabel).toBe(`Codex usage: ${label}`);
  });

  it("falls back to No data when the batch has no snapshot for the provider", () => {
    const summary = resolveEnvironmentProviderUsageSummary({
      providerName: "Claude",
      rows: [],
      snapshot: undefined,
      hasUsageLines: false,
    });

    expect(summary.statusLabel).toBe("No data");
    expect(summary.ariaLabel).toBe("Claude usage: No data");
  });

  it("reports connected when an ok provider only exposes usage text", () => {
    const providerSnapshot = snapshot({
      usageLines: [{ label: "Limits", value: "Remaining limits stay in the provider CLI." }],
    });

    const summary = resolveEnvironmentProviderUsageSummary({
      providerName: "Droid",
      rows: [],
      snapshot: providerSnapshot,
      hasUsageLines: true,
    });

    expect(summary.statusLabel).toBe("Connected");
    expect(summary.ariaLabel).toBe("Droid usage: Connected");
  });
});
