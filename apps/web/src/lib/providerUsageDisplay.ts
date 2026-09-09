// FILE: providerUsageDisplay.ts
// Purpose: Single source of truth for provider usage rows shown in Settings,
// the chat header usage chip, and compact environment/Local popovers.

import {
  deriveVisibleRateLimitRows,
  formatRateLimitRemainingPercent,
  formatRateLimitResetCountdown,
  type ProviderRateLimit,
  type VisibleRateLimitRow,
} from "~/lib/rateLimits";
import { deriveUsagePace, type UsagePaceSummary } from "~/lib/usagePace";

export type ProviderUsageTone = "healthy" | "warning" | "danger";

export interface ProviderUsageDisplayRow extends VisibleRateLimitRow {
  remainingLabel: string;
  leftText: string;
  resetText: string | null;
  pace: UsagePaceSummary | null;
  markerPercent: number | null;
  remainingTone: ProviderUsageTone;
  paceTone: ProviderUsageTone;
}

export interface ProviderUsageProgressTrackProps {
  label: string;
  remainingPercent: number;
  markerPercent: number | null;
  fillClassName: string;
  markerClassName: string;
}

export interface ProviderUsagePaceDetails {
  amountText: string | null;
  etaText: string | null;
}

export const PROVIDER_USAGE_TONE_CLASS_NAME: Record<ProviderUsageTone, string> = {
  healthy: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function remainingTone(remainingPercent: number): ProviderUsageTone {
  if (remainingPercent <= 10) return "danger";
  if (remainingPercent <= 25) return "warning";
  return "healthy";
}

function paceTone(status: UsagePaceSummary["status"]): ProviderUsageTone {
  switch (status) {
    case "behind":
      return "danger";
    case "on-track":
      return "warning";
    case "ahead":
      return "healthy";
  }
}

function windowDurationMinsForRow(row: VisibleRateLimitRow): number | undefined {
  if (row.windowDurationMins !== undefined) {
    return row.windowDurationMins;
  }
  if (row.label === "5h") {
    return 300;
  }
  if (row.label === "Weekly") {
    return 10_080;
  }
  if (row.label === "Daily") {
    return 1_440;
  }
  return undefined;
}

export function providerUsageToneClassName(tone: ProviderUsageTone): string {
  return PROVIDER_USAGE_TONE_CLASS_NAME[tone];
}

export function providerUsageProgressTrackProps(
  row: ProviderUsageDisplayRow,
): ProviderUsageProgressTrackProps {
  return {
    label: `${row.label} remaining`,
    remainingPercent: row.remainingPercent,
    markerPercent: row.markerPercent,
    fillClassName: providerUsageToneClassName(row.remainingTone),
    markerClassName: providerUsageToneClassName(row.paceTone),
  };
}

export function providerUsagePaceDetails(
  row: ProviderUsageDisplayRow,
): ProviderUsagePaceDetails | null {
  if (!row.pace?.amountText && !row.pace?.etaText) {
    return null;
  }
  return {
    amountText: row.pace.amountText,
    etaText: row.pace.etaText,
  };
}

export function deriveProviderUsageDisplayRow(row: VisibleRateLimitRow): ProviderUsageDisplayRow {
  const remainingPercent = clampPercent(row.remainingPercent);
  const pace = deriveUsagePace({
    remainingPercent,
    resetsAt: row.resetsAt,
    windowDurationMins: windowDurationMinsForRow(row),
  });
  const remainingLabel = formatRateLimitRemainingPercent(remainingPercent);
  const usageRemainingTone = remainingTone(remainingPercent);
  const usagePaceTone = pace ? paceTone(pace.status) : usageRemainingTone;

  return {
    ...row,
    remainingPercent,
    remainingLabel,
    leftText: `${remainingLabel} left`,
    resetText: row.resetsAt ? formatRateLimitResetCountdown(row.resetsAt) : null,
    pace,
    markerPercent: pace ? clampPercent(pace.expectedRemainingPercent) : null,
    remainingTone: usageRemainingTone,
    paceTone: usagePaceTone,
  };
}

export function deriveProviderUsageDisplayRows(
  rateLimits: ReadonlyArray<ProviderRateLimit>,
): ProviderUsageDisplayRow[] {
  return deriveVisibleRateLimitRows(rateLimits).map(deriveProviderUsageDisplayRow);
}

export function selectPrimaryProviderUsageDisplayRow(
  rows: ReadonlyArray<ProviderUsageDisplayRow>,
): ProviderUsageDisplayRow | null {
  return rows.reduce<ProviderUsageDisplayRow | null>((selected, row) => {
    if (!selected || row.remainingPercent < selected.remainingPercent) {
      return row;
    }
    return selected;
  }, null);
}
