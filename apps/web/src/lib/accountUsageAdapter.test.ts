// FILE: accountUsageAdapter.test.ts
// Purpose: Unit tests for the pure UsageSummary → panel-shapes adapter:
// streak derivation, hour histogram, model row mapping, heatmap, empty summary.

import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@synara/contracts";
import {
  ACCOUNT_HEATMAP_WINDOW_DAYS,
  computeAccountStreaks,
  localDayKey,
  selectAccountHeatmap,
  selectAccountModelUsage,
  selectAccountPeakHour,
  selectAccountSkills,
  selectAccountUsageView,
} from "./accountUsageAdapter";

const EMPTY_SUMMARY: UsageSummary = {
  lifetimeTokens: 0,
  lifetimePrompts: 0,
  lifetimeTurns: 0,
  models: [],
  days: [],
  hours: [],
  skills: [],
  environments: [],
};

function day(dayKey: string, values: Partial<{ tokens: number; prompts: number; turns: number }>) {
  return { day: dayKey, tokens: 0, prompts: 0, turns: 0, ...values };
}

describe("localDayKey", () => {
  it("formats the timezone-local calendar day, not the UTC day", () => {
    // 2026-08-12T00:30 local — the UTC day may differ, but the local key must not.
    const date = new Date(2026, 7, 12, 0, 30);
    expect(localDayKey(date)).toBe("2026-08-12");
  });
});

describe("computeAccountStreaks", () => {
  it("returns zero streaks for an empty summary", () => {
    expect(computeAccountStreaks(EMPTY_SUMMARY, "2026-08-12")).toEqual({ current: 0, longest: 0 });
  });

  it("derives current and longest streaks from localized days", () => {
    const summary = {
      days: [
        day("2026-08-12", { prompts: 3 }),
        day("2026-08-11", { prompts: 1 }),
        day("2026-08-10", { prompts: 2 }),
        // gap on 2026-08-09
        day("2026-08-08", { prompts: 4 }),
        day("2026-08-07", { prompts: 4 }),
        day("2026-08-06", { prompts: 4 }),
        day("2026-08-05", { prompts: 4 }),
      ],
    };
    expect(computeAccountStreaks(summary, "2026-08-12")).toEqual({ current: 3, longest: 4 });
  });

  it("keeps the streak alive when today is still empty but yesterday was active", () => {
    const summary = {
      days: [day("2026-08-11", { prompts: 1 }), day("2026-08-10", { prompts: 1 })],
    };
    expect(computeAccountStreaks(summary, "2026-08-12").current).toBe(2);
  });

  it("breaks the current streak when the last active day is two days ago", () => {
    const summary = { days: [day("2026-08-10", { prompts: 1 })] };
    expect(computeAccountStreaks(summary, "2026-08-12").current).toBe(0);
  });

  it("counts a day active from tokens or turns even with zero prompts", () => {
    const summary = { days: [day("2026-08-12", { tokens: 500 })] };
    expect(computeAccountStreaks(summary, "2026-08-12").current).toBe(1);
  });

  it("spans a month boundary", () => {
    const summary = {
      days: [day("2026-07-31", { prompts: 1 }), day("2026-08-01", { prompts: 1 })],
    };
    expect(computeAccountStreaks(summary, "2026-08-01")).toEqual({ current: 2, longest: 2 });
  });
});

describe("selectAccountPeakHour", () => {
  it("returns null when there are no hours", () => {
    expect(selectAccountPeakHour({ hours: [] })).toBeNull();
  });

  it("returns null when every hour is empty", () => {
    expect(selectAccountPeakHour({ hours: [{ hour: 3, prompts: 0 }] })).toBeNull();
  });

  it("picks the hour with the most prompts, earliest hour winning ties", () => {
    const hours = [
      { hour: 22, prompts: 9 },
      { hour: 9, prompts: 9 },
      { hour: 14, prompts: 4 },
    ];
    expect(selectAccountPeakHour({ hours })).toBe(9);
  });
});

describe("selectAccountModelUsage", () => {
  it("maps model rows to token-based shares, folding reasoning splits together", () => {
    const models = [
      {
        provider: "claudeAgent",
        model: "fable-5",
        reasoning: "high",
        tokens: 600,
        turns: 6,
        prompts: 5,
      },
      {
        provider: "claudeAgent",
        model: "fable-5",
        reasoning: null,
        tokens: 150,
        turns: 2,
        prompts: 2,
      },
      {
        provider: "codex",
        model: "gpt-5.6",
        reasoning: "medium",
        tokens: 250,
        turns: 4,
        prompts: 3,
      },
    ];
    expect(selectAccountModelUsage({ models })).toEqual([
      { provider: "claudeAgent", model: "fable-5", percent: 75 },
      { provider: "codex", model: "gpt-5.6", percent: 25 },
    ]);
  });

  it("maps a provider outside ProviderKind to 'unknown'", () => {
    const models = [
      {
        provider: "someday-cli",
        model: "mystery",
        reasoning: null,
        tokens: 10,
        turns: 1,
        prompts: 1,
      },
    ];
    expect(selectAccountModelUsage({ models })).toEqual([
      { provider: "unknown", model: "mystery", percent: 100 },
    ]);
  });

  it("falls back to turn-based shares when no tokens were recorded", () => {
    const models = [
      { provider: "codex", model: "gpt-5.6", reasoning: null, tokens: 0, turns: 3, prompts: 3 },
      { provider: "pi", model: "pi-1", reasoning: null, tokens: 0, turns: 1, prompts: 1 },
    ];
    expect(selectAccountModelUsage({ models })).toEqual([
      { provider: "codex", model: "gpt-5.6", percent: 75 },
      { provider: "pi", model: "pi-1", percent: 25 },
    ]);
  });

  it("returns no rows for an empty summary", () => {
    expect(selectAccountModelUsage(EMPTY_SUMMARY)).toEqual([]);
  });
});

describe("selectAccountHeatmap", () => {
  it("covers the full rolling window ending today, with correct weekdays", () => {
    const { cells, unit } = selectAccountHeatmap(EMPTY_SUMMARY, "2026-08-12");
    expect(cells).toHaveLength(ACCOUNT_HEATMAP_WINDOW_DAYS);
    expect(cells.at(-1)?.day).toBe("2026-08-12");
    expect(cells.at(-1)?.weekday).toBe(3); // 2026-08-12 is a Wednesday.
    expect(cells.every((cell) => cell.count === 0 && cell.intensity === 0)).toBe(true);
    expect(unit).toBe("prompts");
  });

  it("uses tokens/day when any tokens synced and ranks intensities", () => {
    const summary = {
      days: [
        day("2026-08-12", { tokens: 4_000_000, prompts: 1 }),
        day("2026-08-11", { tokens: 1_000, prompts: 9 }),
      ],
    };
    const { cells, unit } = selectAccountHeatmap(summary, "2026-08-12");
    expect(unit).toBe("tokens");
    const today = cells.at(-1)!;
    const yesterday = cells.at(-2)!;
    expect(today.count).toBe(4_000_000);
    expect(today.intensity).toBe(4);
    expect(yesterday.count).toBe(1_000);
    // Rank-based bucketing: the small day still gets a visible level, not 0.
    expect(yesterday.intensity).toBeGreaterThanOrEqual(1);
  });

  it("ignores days outside the window", () => {
    const summary = { days: [day("2020-01-01", { prompts: 50 })] };
    const { cells } = selectAccountHeatmap(summary, "2026-08-12");
    expect(cells.every((cell) => cell.count === 0)).toBe(true);
  });
});

describe("selectAccountSkills", () => {
  it("sorts by runs and prefixes display names like the local dashboard", () => {
    const summary = {
      skills: [
        { name: "reviewer", kind: "agent" as const, runs: 2 },
        { name: "tdd", kind: "skill" as const, runs: 7 },
      ],
    };
    expect(selectAccountSkills(summary)).toEqual([
      { name: "tdd", displayName: "$tdd", kind: "skill", runCount: 7 },
      { name: "reviewer", displayName: "@reviewer", kind: "agent", runCount: 2 },
    ]);
  });
});

describe("selectAccountUsageView", () => {
  it("produces an inert view from an empty summary", () => {
    const view = selectAccountUsageView(EMPTY_SUMMARY, "2026-08-12");
    expect(view.lifetimeTokens).toBe(0);
    expect(view.peakDayTokens).toBeNull();
    expect(view.currentStreakDays).toBe(0);
    expect(view.longestStreakDays).toBe(0);
    expect(view.topProvider).toEqual({ provider: null, percent: null });
    expect(view.topReasoning).toEqual({ reasoning: null, percent: null });
    expect(view.peakHour).toBeNull();
    expect(view.models).toEqual([]);
    expect(view.skills).toEqual([]);
    expect(view.skillsExplored).toBe(0);
    expect(view.totalSkillsUsed).toBe(0);
    expect(view.heatmap.cells).toHaveLength(ACCOUNT_HEATMAP_WINDOW_DAYS);
  });

  it("aggregates a populated summary into panel shapes", () => {
    const summary: UsageSummary = {
      lifetimeTokens: 1_000,
      lifetimePrompts: 12,
      lifetimeTurns: 20,
      models: [
        {
          provider: "claudeAgent",
          model: "fable-5",
          reasoning: "high",
          tokens: 750,
          turns: 15,
          prompts: 9,
        },
        { provider: "codex", model: "gpt-5.6", reasoning: null, tokens: 250, turns: 5, prompts: 3 },
      ],
      days: [
        day("2026-08-12", { tokens: 900, prompts: 10, turns: 18 }),
        day("2026-08-11", { tokens: 100, prompts: 2, turns: 2 }),
      ],
      hours: [
        { hour: 10, prompts: 8 },
        { hour: 23, prompts: 4 },
      ],
      skills: [{ name: "tdd", kind: "skill", runs: 3 }],
      environments: [{ environmentId: "env-1", tokens: 1_000, prompts: 12 }],
    };
    const view = selectAccountUsageView(summary, "2026-08-12");
    expect(view.peakDayTokens).toBe(900);
    expect(view.currentStreakDays).toBe(2);
    expect(view.topProvider).toEqual({ provider: "claudeAgent", percent: 75 });
    // Reasoning is turn-weighted among rows that carry one (null rows excluded
    // from the ranking, counted in the total).
    expect(view.topReasoning).toEqual({ reasoning: "high", percent: 75 });
    expect(view.peakHour).toBe(10);
    expect(view.totalSkillsUsed).toBe(3);
    expect(view.heatmap.unit).toBe("tokens");
  });
});
