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

export interface ProfileHeatmapSelection {
  readonly cells: ReadonlyArray<ProfileHeatmapCell>;
  /** Tooltip noun matching the selected series ("tokens" or "prompts"). */
  readonly unit: "tokens" | "prompts";
}

export interface ProfileTopProviderSelection {
  readonly provider: ProviderKind | null;
  readonly percent: number | null;
  readonly metric: "tokens" | "turns";
  /**
   * Providers with real turns that never emitted token telemetry, so they
   * cannot be ranked by tokens. Only populated when `metric === "tokens"`;
   * empty when ranking already fell back to turn counts (every provider is
   * represented there). Callers should disclose this list rather than let
   * those providers silently read as unused (see #1007).
   */
  readonly unavailableProviders: ReadonlyArray<ProviderKind>;
}

export interface ProfileModelUsageEntry {
  readonly provider: ProviderKind | "unknown";
  readonly model: string;
  readonly percent: number;
}

export interface ProfileModelUsageSelection {
  readonly entries: ReadonlyArray<ProfileModelUsageEntry>;
  readonly metric: "tokens" | "turns";
  /** See {@link ProfileTopProviderSelection.unavailableProviders}. */
  readonly unavailableProviders: ReadonlyArray<ProviderKind>;
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
      unavailableProviders: tokenStats.unavailableProviders,
    };
  }

  return {
    provider: stats.insights.topProvider,
    percent: stats.insights.topProviderPercent,
    metric: "turns",
    unavailableProviders: [],
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
    return {
      entries: tokenStats.models,
      metric: "tokens",
      unavailableProviders: tokenStats.unavailableProviders,
    };
  }
  return { entries: stats.providerModels, metric: "turns", unavailableProviders: [] };
}
