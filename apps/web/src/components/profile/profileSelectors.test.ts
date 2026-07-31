// FILE: profileSelectors.test.ts
// Purpose: Covers profile selectors that bridge fast core stats with slower
// token telemetry.
// Layer: web profile feature tests.

import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  selectProfileHeatmap,
  selectProfileInsightRings,
  selectProfileModelUsage,
  selectProfileSparkline,
  selectProfileTopProvider,
} from "./profileSelectors";

const promptHeatmapCell = {
  day: "2026-07-01",
  count: 3,
  weekday: 3,
  intensity: 2,
};

const tokenHeatmapCell = {
  day: "2026-07-02",
  count: 6000,
  weekday: 4,
  intensity: 4,
};

const baseStats = {
  generatedAt: "2026-07-02T10:00:00.000Z",
  timezone: { utcOffsetMinutes: 0, today: "2026-07-02" },
  identity: { homeDirBasename: "synara", initials: "S", defaultHandle: "@synara" },
  activity: {
    currentStreakDays: 0,
    longestStreakDays: 0,
    totalPromptsSent: 0,
    totalThreads: 0,
    promptsToday: 0,
    heatmapMetric: "prompts",
    heatmap: [promptHeatmapCell],
  },
  activeHours: { startHour: null, endHour: null, turnCount: 0, label: null },
  insights: {
    topProvider: "codex",
    topProviderPercent: 66.7,
    topReasoning: "high",
    topReasoningPercent: 54.2,
    skillsExplored: 0,
    totalSkillsUsed: 0,
  },
  providerModels: [
    { provider: "codex", model: "gpt-5-codex", turnCount: 2, percent: 66.7 },
    { provider: "claudeAgent", model: "claude-sonnet-4-6", turnCount: 1, percent: 33.3 },
  ],
  skills: [],
  mostUsedSkill: null,
  mostWorkedProject: null,
  quota: {
    status: "unavailable",
    provider: null,
    window: null,
    usedPercent: null,
    resetsAt: null,
    planName: null,
  },
} satisfies ProfileStats;

const tokenStats = {
  available: true,
  lifetimeTotalTokens: 6000,
  peakDayTokens: 5000,
  peakDay: "2026-07-02",
  providers: ["claudeAgent", "codex"],
  unavailableProviders: [],
  topProvider: "claudeAgent",
  topProviderPercent: 83.3,
  models: [
    { provider: "claudeAgent", model: "claude-sonnet-4-6", tokens: 5000, percent: 83.3 },
    { provider: "codex", model: "gpt-5-codex", tokens: 1000, percent: 16.7 },
  ],
  heatmapMetric: "tokens",
  heatmap: [tokenHeatmapCell],
} satisfies ProfileTokenStats;

describe("profile selectors", () => {
  it("prefers token telemetry once available", () => {
    expect(selectProfileTopProvider(baseStats, tokenStats)).toEqual({
      provider: "claudeAgent",
      percent: 83.3,
      metric: "tokens",
    });
    expect(selectProfileHeatmap(baseStats, tokenStats)).toEqual({
      cells: [tokenHeatmapCell],
      unit: "tokens",
    });
    expect(selectProfileModelUsage(baseStats, tokenStats)).toEqual({
      entries: [
        {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          percent: 83.3,
          weight: 5000,
        },
        {
          provider: "codex",
          model: "gpt-5-codex",
          percent: 16.7,
          weight: 1000,
        },
      ],
      metric: "tokens",
      totalWeight: 6000,
    });
  });

  it("falls back to core profile stats while token telemetry is unavailable", () => {
    expect(selectProfileTopProvider(baseStats, null)).toEqual({
      provider: "codex",
      percent: 66.7,
      metric: "turns",
    });
    expect(selectProfileHeatmap(baseStats, null)).toEqual({
      cells: [promptHeatmapCell],
      unit: "prompts",
    });
    expect(selectProfileModelUsage(baseStats, null)).toEqual({
      entries: [
        {
          provider: "codex",
          model: "gpt-5-codex",
          percent: 66.7,
          weight: 2,
        },
        {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          percent: 33.3,
          weight: 1,
        },
      ],
      metric: "turns",
      totalWeight: 3,
    });
  });

  it("falls back to turn-based model usage when token telemetry has no model rows", () => {
    expect(selectProfileModelUsage(baseStats, { ...tokenStats, models: [] })).toEqual({
      entries: [
        {
          provider: "codex",
          model: "gpt-5-codex",
          percent: 66.7,
          weight: 2,
        },
        {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          percent: 33.3,
          weight: 1,
        },
      ],
      metric: "turns",
      totalWeight: 3,
    });
  });

  it("builds a sparkline window from the preferred heatmap series", () => {
    expect(selectProfileSparkline(baseStats, tokenStats, 28)).toEqual({
      values: [6000],
      unit: "tokens",
      hasActivity: true,
    });
    expect(selectProfileSparkline(baseStats, null, 28)).toEqual({
      values: [3],
      unit: "prompts",
      hasActivity: true,
    });
  });

  it("selects percentage insight rings for provider and reasoning", () => {
    expect(selectProfileInsightRings(baseStats, tokenStats)).toEqual({
      rings: [
        {
          id: "provider",
          label: "Claude",
          detail: "Most used provider",
          percent: 83.3,
        },
        {
          id: "reasoning",
          label: "High",
          detail: "Most used reasoning",
          percent: 54.2,
        },
      ],
    });
  });

  it("omits insight rings when percentages are missing", () => {
    const statsWithoutShares = {
      ...baseStats,
      insights: {
        ...baseStats.insights,
        topProvider: null,
        topProviderPercent: null,
        topReasoning: null,
        topReasoningPercent: null,
      },
    } satisfies ProfileStats;
    expect(
      selectProfileInsightRings(statsWithoutShares, {
        ...tokenStats,
        topProvider: null,
        topProviderPercent: null,
      }),
    ).toEqual({ rings: [] });
  });
});
