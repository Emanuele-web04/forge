// FILE: profileSelectors.test.ts
// Purpose: Covers profile selectors that bridge fast core stats with slower
// token telemetry.
// Layer: web profile feature tests.

import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  selectProfileHeatmap,
  selectProfileModelUsage,
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
    topReasoning: null,
    topReasoningPercent: null,
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
      unavailableProviders: [],
    });
    expect(selectProfileHeatmap(baseStats, tokenStats)).toEqual({
      cells: [tokenHeatmapCell],
      unit: "tokens",
    });
    expect(selectProfileModelUsage(baseStats, tokenStats)).toEqual({
      entries: tokenStats.models,
      metric: "tokens",
      unavailableProviders: [],
    });
  });

  it("falls back to core profile stats while token telemetry is unavailable", () => {
    expect(selectProfileTopProvider(baseStats, null)).toEqual({
      provider: "codex",
      percent: 66.7,
      metric: "turns",
      unavailableProviders: [],
    });
    expect(selectProfileHeatmap(baseStats, null)).toEqual({
      cells: [promptHeatmapCell],
      unit: "prompts",
    });
    expect(selectProfileModelUsage(baseStats, null)).toEqual({
      entries: baseStats.providerModels,
      metric: "turns",
      unavailableProviders: [],
    });
  });

  it("falls back to turn-based model usage when token telemetry has no model rows", () => {
    expect(selectProfileModelUsage(baseStats, { ...tokenStats, models: [] })).toEqual({
      entries: baseStats.providerModels,
      metric: "turns",
      unavailableProviders: [],
    });
  });

  // #1007: a provider with real turns (Grok) that never emits token telemetry
  // must not silently disappear from the ranking once any other provider has
  // token stats — callers need the list to disclose it instead.
  it("surfaces providers with turns but no token telemetry instead of dropping them", () => {
    const grokStats = {
      ...baseStats,
      insights: { ...baseStats.insights, topProvider: "grok", topProviderPercent: 100 },
      providerModels: [
        ...baseStats.providerModels,
        { provider: "grok", model: "grok-4.6", turnCount: 3, percent: 50 },
      ],
    } satisfies ProfileStats;
    const tokenStatsMissingGrok = {
      ...tokenStats,
      unavailableProviders: ["grok"],
    } satisfies ProfileTokenStats;

    const topProvider = selectProfileTopProvider(grokStats, tokenStatsMissingGrok);
    expect(topProvider.metric).toBe("tokens");
    expect(topProvider.unavailableProviders).toEqual(["grok"]);

    const modelUsage = selectProfileModelUsage(grokStats, tokenStatsMissingGrok);
    expect(modelUsage.metric).toBe("tokens");
    expect(modelUsage.unavailableProviders).toEqual(["grok"]);
  });

  it("reports no unavailable providers once telemetry fully falls back to turns", () => {
    // available: false forces the turns-based branch; that branch's providers
    // are all represented by definition, so the stale unavailableProviders
    // list from a not-yet-available token payload must not leak through.
    const notAvailable = {
      ...tokenStats,
      available: false,
      unavailableProviders: ["grok"],
    } satisfies ProfileTokenStats;
    expect(selectProfileTopProvider(baseStats, notAvailable).unavailableProviders).toEqual([]);
    expect(selectProfileModelUsage(baseStats, notAvailable).unavailableProviders).toEqual([]);
  });
});
