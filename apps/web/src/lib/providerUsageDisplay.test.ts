import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveProviderUsageDisplayRows,
  providerUsagePaceDetails,
  selectPrimaryProviderUsageDisplayRow,
} from "./providerUsageDisplay";

describe("providerUsageDisplay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects the most constrained display row for compact header chips", () => {
    const rows = deriveProviderUsageDisplayRows([
      {
        provider: "claudeAgent",
        updatedAt: "2099-04-08T18:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 7,
            resetsAt: "2099-04-08T20:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            window: "Weekly",
            usedPercent: 84,
            resetsAt: "2099-04-14T18:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      },
    ]);

    const primary = selectPrimaryProviderUsageDisplayRow(rows);

    expect(primary?.label).toBe("Weekly");
    expect(primary?.remainingLabel).toBe("16%");
    expect(primary?.remainingTone).toBe("warning");
  });

  it("centralizes reserve and eta details for display rows", () => {
    vi.setSystemTime("2026-06-09T12:00:00.000Z");

    const [row] = deriveProviderUsageDisplayRows([
      {
        provider: "codex",
        updatedAt: "2026-06-09T12:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 15,
            resetsAt: "2026-06-09T12:36:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
    ]);

    expect(row ? providerUsagePaceDetails(row) : null).toEqual({
      amountText: "73% in reserve",
      etaText: "Lasts until reset",
    });
  });

  it("infers standard window durations from normalized labels for pace details", () => {
    vi.setSystemTime("2026-06-09T12:00:00.000Z");

    const [row] = deriveProviderUsageDisplayRows([
      {
        provider: "codex",
        updatedAt: "2026-06-09T12:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 9,
            resetsAt: "2026-06-09T15:00:00.000Z",
          },
        ],
      },
    ]);

    expect(row?.markerPercent).toBe(60);
    expect(row ? providerUsagePaceDetails(row) : null).toEqual({
      amountText: "31% in reserve",
      etaText: "Lasts until reset",
    });
  });

  it("keeps standard and Core windows as separate usage rows", () => {
    vi.setSystemTime("2026-09-03T20:00:00.000Z");

    const rows = deriveProviderUsageDisplayRows([
      {
        provider: "droid",
        updatedAt: "2026-09-03T20:00:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 24,
            resetsAt: "2026-09-04T02:36:34.535Z",
            windowDurationMins: 300,
          },
          {
            window: "Core 5h",
            usedPercent: 5,
            resetsAt: "2026-09-04T03:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            window: "Weekly",
            usedPercent: 11,
            resetsAt: "2026-09-06T19:23:10.458Z",
            windowDurationMins: 10_080,
          },
          {
            window: "Core Weekly",
            usedPercent: 2,
            resetsAt: "2026-09-07T00:00:00.000Z",
            windowDurationMins: 10_080,
          },
        ],
      },
    ]);

    expect(rows.map((row) => row.label)).toEqual([
      "5h",
      "Weekly",
      "Core 5h",
      "Core Weekly",
    ]);
    expect(rows.find((row) => row.label === "Core 5h")?.resetText).toContain("Resets in");
  });
});
