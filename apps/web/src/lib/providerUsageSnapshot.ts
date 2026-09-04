// FILE: providerUsageSnapshot.ts
// Purpose: Normalize provider usage snapshots returned by the server into the
// same shapes consumed by the shared usage/rate-limit UI in the web app.

import type { ServerGetProviderUsageSnapshotResult } from "@synara/contracts";

import type { OpenUsageUsageLine } from "./openUsageRateLimits";
import type { ProviderRateLimit } from "./rateLimits";

export function isProviderUsageSnapshotNonOk(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): boolean {
  return snapshot?.status !== undefined && snapshot.status !== "ok";
}

export function normalizeServerProviderUsageRateLimit(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): ProviderRateLimit | null {
  if (!snapshot || snapshot.limits.length === 0) {
    return null;
  }

  return {
    provider: snapshot.provider,
    updatedAt: snapshot.updatedAt,
    limits: snapshot.limits.map((limit) => ({
      window: limit.window,
      ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowDurationMins !== undefined
        ? { windowDurationMins: limit.windowDurationMins }
        : {}),
    })),
  };
}

export function normalizeServerProviderUsageLines(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): OpenUsageUsageLine[] {
  if (!snapshot || snapshot.usageLines.length === 0) {
    return [];
  }

  return snapshot.usageLines.map((line) => ({
    label: line.label,
    value: line.value,
    ...(line.subtitle ? { subtitle: line.subtitle } : {}),
  }));
}
