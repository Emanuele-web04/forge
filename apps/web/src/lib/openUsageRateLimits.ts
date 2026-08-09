// FILE: openUsageRateLimits.ts
// Purpose: Normalizes OpenUsage local HTTP snapshots into the shared rate-limit
// model consumed by the local toolbar popover.

import type { ProviderKind } from "@synara/contracts";

import type { ProviderRateLimit, RateLimitWindow } from "~/lib/rateLimits";
import { normalizeRateLimitLabel } from "~/lib/rateLimits";

interface OpenUsageProgressLine {
  type?: unknown;
  label?: unknown;
  used?: unknown;
  limit?: unknown;
  resetsAt?: unknown;
  periodDurationMs?: unknown;
}

interface OpenUsageTextLine {
  type?: unknown;
  label?: unknown;
  value?: unknown;
  subtitle?: unknown;
}

interface OpenUsageSnapshot {
  providerId?: unknown;
  fetchedAt?: unknown;
  lines?: unknown;
}

export interface OpenUsageUsageLine {
  label: string;
  value: string;
  subtitle?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toWindowDurationMins(periodDurationMs: number | undefined): number | undefined {
  if (periodDurationMs === undefined) return undefined;
  return Math.round(periodDurationMs / 60_000);
}

function toUsedPercent(line: OpenUsageProgressLine): number | undefined {
  const used = asFiniteNumber(line.used);
  const limit = asFiniteNumber(line.limit);
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function toProviderKind(providerId: string | undefined): ProviderKind | null {
  switch (providerId) {
    case "codex":
      return "codex";
    case "claude":
    case "claude_code":
      return "claudeAgent";
    case "cursor":
      return "cursor";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

export function openUsageProviderIdForProvider(
  provider: ProviderKind | null | undefined,
): string | null {
  if (provider === "codex") return "codex";
  if (provider === "claudeAgent") return "claude";
  if (provider === "cursor") return "cursor";
  if (provider === "opencode") return "opencode";
  return null;
}

function normalizeProgressLine(line: OpenUsageProgressLine): RateLimitWindow | null {
  if (line.type !== "progress") return null;

  const label = asString(line.label);
  const usedPercent = toUsedPercent(line);
  const resetsAt = asString(line.resetsAt);
  const windowDurationMins = toWindowDurationMins(asFiniteNumber(line.periodDurationMs));

  if (usedPercent === undefined && !resetsAt) return null;

  return {
    window: normalizeRateLimitLabel(label, windowDurationMins),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

function normalizeTextLine(line: OpenUsageTextLine): OpenUsageUsageLine | null {
  if (line.type !== "text") return null;

  const label = asString(line.label);
  const value = asString(line.value);
  const subtitle = asString(line.subtitle);
  if (!label || !value) return null;

  return {
    label,
    value,
    ...(subtitle ? { subtitle } : {}),
  };
}

export function normalizeOpenUsageSnapshot(
  snapshot: unknown,
  preferredProvider?: ProviderKind | null,
): ProviderRateLimit | null {
  const parsed = asRecord(snapshot) as OpenUsageSnapshot | null;
  if (!parsed) return null;

  const provider =
    toProviderKind(asString(parsed.providerId)) ??
    (preferredProvider !== undefined ? preferredProvider : null);
  if (!provider) return null;

  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const limits = lines
    .map((line) => normalizeProgressLine(asRecord(line) ?? {}))
    .filter((line): line is RateLimitWindow => line !== null);

  if (limits.length === 0) return null;

  return {
    provider,
    updatedAt: asString(parsed.fetchedAt) ?? new Date().toISOString(),
    limits,
  };
}

export function normalizeOpenUsageUsageLines(snapshot: unknown): OpenUsageUsageLine[] {
  const parsed = asRecord(snapshot) as OpenUsageSnapshot | null;
  if (!parsed) return [];

  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  return lines
    .map((line) => normalizeTextLine(asRecord(line) ?? {}))
    .filter((line): line is OpenUsageUsageLine => line !== null);
}
