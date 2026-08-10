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

export interface ProfileTokenProvenance {
  /** Where the token totals on this page come from. */
  readonly source: "synara-measured" | "none";
  /**
   * How much of the recorded activity carried token telemetry. `none` means
   * the DB has no token evidence at all.
   */
  readonly coverage: "complete" | "partial" | "not-reported" | "none";
  /** Provider count with partial coverage, for the honest "X of Y providers" note. */
  readonly providersWithTokens: number;
  readonly providersWithTurns: number;
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
    return { entries: tokenStats.models, metric: "tokens" };
  }
  return { entries: stats.providerModels, metric: "turns" };
}

/**
 * Provenance of the profile token figures: they are measured locally from
 * Synara's projected context-window updates, never fetched from a provider.
 * Coverage distinguishes full, partial, and absent token evidence so the page
 * never presents a partial sum as complete.
 */
export function selectProfileTokenProvenance(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileTokenProvenance {
  const providerUsage = tokenStats?.providerUsage ?? [];
  const providersWithTurns = providerUsage.filter((entry) => entry.turnCount > 0).length;
  const providersWithTokens = providerUsage.filter(
    (entry) => entry.tokensReported || (entry.tokenCoverage ?? "not-reported") !== "not-reported",
  ).length;
  if (!tokenStats?.available) {
    return {
      source: "none",
      coverage: "none",
      providersWithTokens: 0,
      providersWithTurns,
    };
  }
  if (providersWithTurns > 0 && providersWithTokens === 0) {
    return {
      source: "synara-measured",
      coverage: "not-reported",
      providersWithTokens,
      providersWithTurns,
    };
  }
  if (tokenStats.lifetimeTotalTokens === null) {
    return {
      source: "none",
      coverage: "none",
      providersWithTokens,
      providersWithTurns,
    };
  }
  const hasPartial = providerUsage.some(
    (entry) =>
      entry.turnCount > 0 &&
      (entry.tokenCoverage ?? (entry.tokensReported ? "complete" : "not-reported")) === "partial",
  );
  return {
    source: "synara-measured",
    coverage: hasPartial ? "partial" : "complete",
    providersWithTokens,
    providersWithTurns,
  };
}
