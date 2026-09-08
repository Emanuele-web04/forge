// FILE: providerUsage/agent.ts
// Purpose: Interpret existing provider-usage snapshots for agents without creating a second
// accounting source. Only fresh, authoritative percentage limits become actionable quota windows;
// token totals, spend lines, missing data, and stale observations remain explicitly unavailable.

import type {
  AgentProviderUsageUnavailableReason,
  ProviderKind,
  ServerAgentProviderUsage,
  ServerAgentProviderUsageWindow,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

export const AGENT_PROVIDER_USAGE_MAX_AGE_MS = 5 * 60 * 1000;

function snapshotUnavailableReason(
  snapshot: ServerProviderUsageSnapshot,
): AgentProviderUsageUnavailableReason | null {
  switch (snapshot.status ?? "ok") {
    case "needs-auth":
      return "needs-auth";
    case "unsupported":
      return "unsupported";
    case "error":
      return "provider-error";
    case "ok":
      return null;
  }
}

function unavailableResult(input: {
  provider: ProviderKind;
  checkedAt: string;
  reason: AgentProviderUsageUnavailableReason;
  snapshot: ServerProviderUsageSnapshot | null;
  ageMs?: number;
}): ServerAgentProviderUsage {
  return {
    provider: input.provider,
    availability: "unavailable",
    unavailableReason: input.reason,
    checkedAt: input.checkedAt,
    freshness: {
      stale: input.reason === "stale" || input.snapshot === null,
      ageMs: input.ageMs ?? 0,
      maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS,
    },
    snapshot: input.snapshot,
    quotaWindows: [],
  };
}

/** Pure conversion kept separate from fetching so every transport applies identical safety rules. */
export function summarizeProviderUsageForAgent(input: {
  provider: ProviderKind;
  enabled: boolean;
  snapshot: ServerProviderUsageSnapshot | null;
  checkedAtMs?: number;
  timedOut?: boolean;
}): ServerAgentProviderUsage {
  const checkedAtMs = input.checkedAtMs ?? Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  if (!input.enabled) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "disabled",
      snapshot: null,
    });
  }
  if (input.timedOut) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "timed-out",
      snapshot: null,
    });
  }
  if (!input.snapshot) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "missing-snapshot",
      snapshot: null,
    });
  }

  const originalSnapshot = input.snapshot;
  const observedAtMs = Date.parse(originalSnapshot.updatedAt);
  const ageMs = Number.isFinite(observedAtMs) ? Math.max(0, checkedAtMs - observedAtMs) : 0;
  const snapshot: ServerProviderUsageSnapshot = {
    ...originalSnapshot,
    usageLines: originalSnapshot.usageLines.map((line) => ({
      ...line,
      source: line.source ?? originalSnapshot.source,
      observedAt: line.observedAt ?? originalSnapshot.updatedAt,
    })),
  };
  const statusReason = snapshotUnavailableReason(snapshot);
  if (statusReason) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: statusReason,
      snapshot,
      ageMs,
    });
  }
  if (
    snapshot.stale === true ||
    !Number.isFinite(observedAtMs) ||
    ageMs > AGENT_PROVIDER_USAGE_MAX_AGE_MS
  ) {
    return unavailableResult({
      provider: input.provider,
      checkedAt,
      reason: "stale",
      snapshot,
      ageMs,
    });
  }

  const quotaWindows: ServerAgentProviderUsageWindow[] = snapshot.limits.map((limit) => {
    const common = {
      window: limit.window,
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowDurationMins !== undefined
        ? { windowDurationMins: limit.windowDurationMins }
        : {}),
      source: snapshot.source,
      observedAt: snapshot.updatedAt,
    };
    const resetAtMs = limit.resetsAt ? Date.parse(limit.resetsAt) : null;
    if (resetAtMs !== null && Number.isFinite(resetAtMs) && resetAtMs <= checkedAtMs) {
      return { ...common, availability: "unavailable", unavailableReason: "expired-window" };
    }
    if (limit.usedPercent === undefined) {
      return { ...common, availability: "unavailable", unavailableReason: "missing-quota" };
    }
    return {
      ...common,
      availability: "available",
      usedPercent: limit.usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - limit.usedPercent)),
    };
  });
  const availableCount = quotaWindows.filter((window) => window.availability === "available").length;
  if (availableCount === 0) {
    return {
      provider: input.provider,
      availability: "unavailable",
      unavailableReason:
        quotaWindows[0]?.unavailableReason === "expired-window"
          ? "expired-window"
          : "missing-quota",
      checkedAt,
      freshness: { stale: false, ageMs, maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS },
      snapshot,
      quotaWindows,
    };
  }

  return {
    provider: input.provider,
    availability: availableCount === quotaWindows.length ? "available" : "partial",
    checkedAt,
    freshness: { stale: false, ageMs, maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS },
    snapshot,
    quotaWindows,
  };
}

export function summarizeProviderUsageListForAgent(input: {
  providers: ReadonlyArray<ProviderKind>;
  enabledProviders: ReadonlySet<ProviderKind>;
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>;
  checkedAtMs?: number;
}): ServerAgentProviderUsage[] {
  const byProvider = new Map(input.snapshots.map((snapshot) => [snapshot.provider, snapshot]));
  return input.providers.map((provider) =>
    summarizeProviderUsageForAgent({
      provider,
      enabled: input.enabledProviders.has(provider),
      snapshot: byProvider.get(provider) ?? null,
      ...(input.checkedAtMs === undefined ? {} : { checkedAtMs: input.checkedAtMs }),
    }),
  );
}
