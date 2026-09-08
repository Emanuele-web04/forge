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
import type { AccountUsageView } from "~/lib/accountUsageAdapter";

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
}

export interface ProfileModelUsageSelection {
  readonly entries: ReadonlyArray<ProfileModelUsageEntry>;
  readonly metric: "tokens" | "turns";
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

/**
 * Everything the shareable card renders, scope-neutral: built from the local
 * device stats or from the account-wide usage summary, so the exported PNG
 * always shows the numbers the user selected in the panel's scope toggle.
 */
export interface ShareCardStats {
  readonly lifetimeTokens: number | null;
  readonly peakDayTokens: number | null;
  readonly currentStreakDays: number;
  readonly longestStreakDays: number;
  readonly topProvider: {
    readonly provider: ProviderKind | null;
    readonly percent: number | null;
  };
  readonly heatmapCells: ReadonlyArray<ProfileHeatmapCell>;
}

/** The This-device share card: same tokens-first series as the profile page. */
export function selectDeviceShareCardStats(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ShareCardStats {
  const topProvider = selectProfileTopProvider(stats, tokenStats);
  return {
    lifetimeTokens: tokenStats?.lifetimeTotalTokens ?? null,
    peakDayTokens: tokenStats?.peakDayTokens ?? null,
    currentStreakDays: stats.activity.currentStreakDays,
    longestStreakDays: stats.activity.longestStreakDays,
    topProvider: { provider: topProvider.provider, percent: topProvider.percent },
    heatmapCells: selectProfileHeatmap(stats, tokenStats).cells,
  };
}

/** The Account share card, from the already-derived account usage view. */
export function selectAccountShareCardStats(view: AccountUsageView): ShareCardStats {
  return {
    lifetimeTokens: view.lifetimeTokens,
    peakDayTokens: view.peakDayTokens,
    currentStreakDays: view.currentStreakDays,
    longestStreakDays: view.longestStreakDays,
    topProvider: view.topProvider,
    heatmapCells: view.heatmap.cells,
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
    return { entries: tokenStats.models, metric: "tokens" };
  }
  return { entries: stats.providerModels, metric: "turns" };
}
