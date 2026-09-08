// FILE: profileSelectors.test.ts
// Purpose: Covers profile selectors that bridge fast core stats with slower
// token telemetry.
// Layer: web profile feature tests.

import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTokenProvenance,
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
    });
    expect(selectProfileHeatmap(baseStats, tokenStats)).toEqual({
      cells: [tokenHeatmapCell],
      unit: "tokens",
    });
    expect(selectProfileModelUsage(baseStats, tokenStats)).toEqual({
      entries: tokenStats.models,
      metric: "tokens",
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
      entries: baseStats.providerModels,
      metric: "turns",
    });
  });

  it("falls back to turn-based model usage when token telemetry has no model rows", () => {
    expect(selectProfileModelUsage(baseStats, { ...tokenStats, models: [] })).toEqual({
      entries: baseStats.providerModels,
      metric: "turns",
    });
  });
});

describe("selectProfileTokenProvenance", () => {
  const baseTokenStats: ProfileTokenStats = {
    available: true,
    lifetimeTotalTokens: 100_000,
    peakDayTokens: 30_000,
    peakDay: "2026-07-02",
    providers: ["codex", "claudeAgent"] as const,
    unavailableProviders: [] as const,
    topProvider: "codex",
    topProviderPercent: 60,
    models: [],
    providerUsage: [
      {
        provider: "codex" as const,
        tokens: 60_000,
        tokensReported: true,
        tokenCoverage: "complete" as const,
        turnCount: 6,
        threadCount: 2,
        costUsd: 1.2,
        costCoverage: "complete" as const,
        lastUsedAt: "2026-07-02T09:00:00.000Z",
        models: [],
        history: [],
      },
      {
        provider: "claudeAgent" as const,
        tokens: 40_000,
        tokensReported: true,
        tokenCoverage: "partial" as const,
        turnCount: 4,
        threadCount: 1,
        costUsd: null,
        costCoverage: "not-reported" as const,
        lastUsedAt: null,
        models: [],
        history: [],
      },
    ],
    heatmapMetric: "tokens" as const,
    heatmap: [],
  };

  it("labels full token coverage as synara-measured and complete", () => {
    const result = selectProfileTokenProvenance(baseStats, {
      ...baseTokenStats,
      providerUsage: (baseTokenStats.providerUsage ?? []).map((entry) => ({
        ...entry,
        tokenCoverage: "complete" as const,
      })),
    });
    expect(result).toMatchObject({ source: "synara-measured", coverage: "complete" });
  });

  it("labels mixed coverage as partial and counts the providers honestly", () => {
    const result = selectProfileTokenProvenance(baseStats, baseTokenStats);
    expect(result).toMatchObject({
      source: "synara-measured",
      coverage: "partial",
      providersWithTokens: 2,
      providersWithTurns: 2,
    });
  });

  it("returns none when token stats are unavailable", () => {
    const result = selectProfileTokenProvenance(baseStats, null);
    expect(result).toMatchObject({ source: "none", coverage: "none" });
  });

  it("returns not-reported when turns exist but no token telemetry", () => {
    const result = selectProfileTokenProvenance(baseStats, {
      ...baseTokenStats,
      lifetimeTotalTokens: null,
      providerUsage: (baseTokenStats.providerUsage ?? []).map((entry) => ({
        ...entry,
        tokens: 0,
        tokensReported: false,
        tokenCoverage: "not-reported" as const,
      })),
    });
    expect(result).toMatchObject({ source: "synara-measured", coverage: "not-reported" });
  });
});
