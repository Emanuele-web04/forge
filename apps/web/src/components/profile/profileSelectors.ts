// FILE: profileSelectors.ts
// Purpose: Shared profile selectors that combine fast core stats with slower
// token telemetry for profile surfaces and export cards.
// Layer: web profile feature (pure selection logic, no I/O).

import type {
  ProfileHeatmapCell,
  ProfileStats,
  ProfileTokenStats,
  ProviderKind,
} from "@synara/contracts";
import { clampPercent } from "./profileChartGeometry";

export interface ProfileHeatmapSelection {
  readonly cells: ReadonlyArray<ProfileHeatmapCell>;
  /** Tooltip noun matching the selected series ("tokens" or "prompts"). */
  readonly unit: "tokens" | "prompts";
}

export interface ProfileTopProviderSelection {
  readonly provider: ProviderKind | null;
  readonly percent: number | null;
  readonly metric: "tokens" | "turns";
}

export interface ProfileModelUsageEntry {
  readonly provider: ProviderKind | "unknown";
  readonly model: string;
  readonly percent: number;
  /** Absolute weight when known (tokens or turns); used for donut center totals. */
  readonly weight: number | null;
}

export interface ProfileModelUsageSelection {
  readonly entries: ReadonlyArray<ProfileModelUsageEntry>;
  readonly metric: "tokens" | "turns";
  /** Sum of entry weights when every row has a weight; null otherwise. */
  readonly totalWeight: number | null;
}

export interface ProfileSparklineSelection {
  readonly values: ReadonlyArray<number>;
  readonly unit: "tokens" | "prompts";
  /** True when at least one day in the window has activity. */
  readonly hasActivity: boolean;
}

export interface ProfileInsightRing {
  readonly id: "provider" | "reasoning";
  readonly label: string;
  readonly detail: string;
  readonly percent: number;
}

export interface ProfileInsightRingsSelection {
  readonly rings: ReadonlyArray<ProfileInsightRing>;
}

// Prefer tokens/day when available; fall back to prompt counts while token stats load.
export function selectProfileHeatmap(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileHeatmapSelection {
  if (tokenStats?.available) {
    return { cells: tokenStats.heatmap, unit: "tokens" };
  }
  return { cells: stats.activity.heatmap, unit: "prompts" };
}

// Prefer token-based provider usage when telemetry is available; fall back to turn count.
export function selectProfileTopProvider(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileTopProviderSelection {
  if (tokenStats?.available && tokenStats.topProvider) {
    return {
      provider: tokenStats.topProvider,
      percent: tokenStats.topProviderPercent,
      metric: "tokens",
    };
  }

  return {
    provider: stats.insights.topProvider,
    percent: stats.insights.topProviderPercent,
    metric: "turns",
  };
}

// Prefer the token-based model mix (tokens are attributed to the model each turn
// actually ran with) and fall back to turn counts while token stats load or when
// no provider emitted token telemetry.
export function selectProfileModelUsage(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileModelUsageSelection {
  if (tokenStats?.available && tokenStats.models.length > 0) {
    const entries = tokenStats.models.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      percent: entry.percent,
      weight: entry.tokens,
    }));
    return {
      entries,
      metric: "tokens",
      totalWeight: sumWeights(entries),
    };
  }
  const entries = stats.providerModels.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    percent: entry.percent,
    weight: entry.turnCount,
  }));
  return {
    entries,
    metric: "turns",
    totalWeight: sumWeights(entries),
  };
}

/**
 * Last N days of heatmap counts for a lifetime-token (or prompt) sparkline.
 * Uses the same tokens-first series as the activity heatmap.
 */
export function selectProfileSparkline(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
  dayCount = 28,
): ProfileSparklineSelection {
  const heatmap = selectProfileHeatmap(stats, tokenStats);
  const window = heatmap.cells.slice(-Math.max(1, dayCount));
  const values = window.map((cell) => cell.count);
  return {
    values,
    unit: heatmap.unit,
    hasActivity: values.some((value) => value > 0),
  };
}

/**
 * Pull percentage-based insights into Progress Ring candidates.
 * Only includes rings with a real 0–100 share (provider / reasoning).
 */
export function selectProfileInsightRings(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileInsightRingsSelection {
  const topProvider = selectProfileTopProvider(stats, tokenStats);
  const rings: ProfileInsightRing[] = [];

  const providerPercent = clampPercent(topProvider.percent);
  if (topProvider.provider && providerPercent !== null && providerPercent > 0) {
    rings.push({
      id: "provider",
      label: formatProviderKindLabel(topProvider.provider),
      detail: "Most used provider",
      percent: providerPercent,
    });
  }

  const reasoningPercent = clampPercent(stats.insights.topReasoningPercent);
  if (stats.insights.topReasoning && reasoningPercent !== null && reasoningPercent > 0) {
    rings.push({
      id: "reasoning",
      label: capitalizeWord(stats.insights.topReasoning),
      detail: "Most used reasoning",
      percent: reasoningPercent,
    });
  }

  return { rings };
}

function sumWeights(entries: ReadonlyArray<{ weight: number | null }>): number | null {
  let total = 0;
  for (const entry of entries) {
    if (entry.weight === null || !Number.isFinite(entry.weight)) {
      return null;
    }
    total += entry.weight;
  }
  return total;
}

export function formatProviderKindLabel(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "antigravity":
      return "Antigravity";
    case "grok":
      return "Grok";
    case "droid":
      return "Droid";
    case "kilo":
      return "Kilo";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
  }
}

function capitalizeWord(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
