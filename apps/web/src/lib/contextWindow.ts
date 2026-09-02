import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@synara/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asContextWindowPercent(value: unknown): number | null {
  const percent = asFiniteNumber(value);
  if (percent === null) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export interface ContextWindowState {
  readonly snapshot: ContextWindowSnapshot | null;
  readonly invalidatedByCompaction: boolean;
}

export interface ContextWindowSelectionStatus {
  readonly activeLabel: string | null;
  readonly selectedLabel: string | null;
  readonly pendingSelectedLabel: string | null;
}

export interface ContextWindowMeterDisplay {
  readonly usedPercentageLabel: string | null;
  readonly tokenUsageLabel: string;
  readonly hasReliableTokenRatio: boolean;
  readonly normalizedPercentage: number;
  readonly compactLabel: string;
  readonly ariaLabel: string;
}

const KNOWN_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

export function isCompletedContextCompaction(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-compaction") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.state === "compacted" || payload?.status === "completed";
}

// Read the latest token-usage snapshot emitted by the runtime.
function deriveLatestUsageContextWindowState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowState {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) {
      continue;
    }
    if (isCompletedContextCompaction(activity)) {
      return { snapshot: null, invalidatedByCompaction: true };
    }
    if (activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const rawUsedTokens = asFiniteNumber(payload?.usedTokens);
    const usedTokens = rawUsedTokens ?? 0;
    const payloadUsedPercent = asContextWindowPercent(payload?.usedPercent);
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (usedTokens <= 0 && payloadUsedPercent === null && (maxTokens === null || maxTokens <= 0)) {
      continue;
    }

    const usedPercentage =
      payloadUsedPercent ??
      (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
    const hasReliableTokenUsage =
      rawUsedTokens !== null &&
      (usedTokens > 0 || payloadUsedPercent === null || (maxTokens !== null && maxTokens > 0));
    const remainingTokens =
      maxTokens !== null && hasReliableTokenUsage
        ? Math.max(0, Math.round(maxTokens - usedTokens))
        : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      snapshot: {
        usedTokens,
        usedPercent: payloadUsedPercent,
        totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
        maxTokens,
        remainingTokens,
        usedPercentage,
        remainingPercentage,
        inputTokens: asFiniteNumber(payload?.inputTokens),
        cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
        outputTokens: asFiniteNumber(payload?.outputTokens),
        reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
        lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
        lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
        lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
        lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
        lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
        toolUses: asFiniteNumber(payload?.toolUses),
        durationMs: asFiniteNumber(payload?.durationMs),
        compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
        updatedAt: activity.createdAt,
      },
      invalidatedByCompaction: false,
    };
  }

  return { snapshot: null, invalidatedByCompaction: false };
}

// Use the configured session window as the source of truth for the meter denominator.
function deriveLatestConfiguredContextWindowMaxTokens(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.configured") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    return maxTokens !== null && maxTokens > 0 ? maxTokens : null;
  }

  return null;
}

export function deriveLatestContextWindowState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowState {
  const usageState = deriveLatestUsageContextWindowState(activities);
  if (usageState.invalidatedByCompaction) {
    return usageState;
  }

  const usageSnapshot = usageState.snapshot;
  const configuredMaxTokens = deriveLatestConfiguredContextWindowMaxTokens(activities);

  if (usageSnapshot === null && configuredMaxTokens === null) {
    return usageState;
  }

  const usedTokens = usageSnapshot?.usedTokens ?? 0;
  const maxTokens = configuredMaxTokens ?? usageSnapshot?.maxTokens ?? null;
  const usedPercentage =
    usageSnapshot?.usedPercent ??
    (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
  const hasReliableTokenUsage =
    usageSnapshot === null ||
    usageSnapshot.usedTokens > 0 ||
    usageSnapshot.usedPercent === null ||
    usageSnapshot.maxTokens !== null;
  const remainingTokens =
    maxTokens !== null && hasReliableTokenUsage
      ? Math.max(0, Math.round(maxTokens - usedTokens))
      : null;
  const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

  return {
    snapshot: {
      usedTokens,
      usedPercent: usageSnapshot?.usedPercent ?? null,
      totalProcessedTokens: usageSnapshot?.totalProcessedTokens ?? null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: usageSnapshot?.inputTokens ?? null,
      cachedInputTokens: usageSnapshot?.cachedInputTokens ?? null,
      outputTokens: usageSnapshot?.outputTokens ?? null,
      reasoningOutputTokens: usageSnapshot?.reasoningOutputTokens ?? null,
      lastUsedTokens: usageSnapshot?.lastUsedTokens ?? null,
      lastInputTokens: usageSnapshot?.lastInputTokens ?? null,
      lastCachedInputTokens: usageSnapshot?.lastCachedInputTokens ?? null,
      lastOutputTokens: usageSnapshot?.lastOutputTokens ?? null,
      lastReasoningOutputTokens: usageSnapshot?.lastReasoningOutputTokens ?? null,
      toolUses: usageSnapshot?.toolUses ?? null,
      durationMs: usageSnapshot?.durationMs ?? null,
      compactsAutomatically: usageSnapshot?.compactsAutomatically ?? false,
      updatedAt: usageSnapshot?.updatedAt ?? activities[activities.length - 1]?.createdAt ?? "",
    },
    invalidatedByCompaction: false,
  };
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  return deriveLatestContextWindowState(activities).snapshot;
}

export function deriveSelectedContextWindowSnapshot(
  selectedValue: string | null | undefined,
): ContextWindowSnapshot | null {
  const normalized = selectedValue?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const maxTokens =
    KNOWN_CONTEXT_WINDOW_MAX_TOKENS[normalized as keyof typeof KNOWN_CONTEXT_WINDOW_MAX_TOKENS] ??
    null;
  if (maxTokens === null) {
    return null;
  }

  return {
    usedTokens: 0,
    usedPercent: null,
    totalProcessedTokens: null,
    maxTokens,
    remainingTokens: maxTokens,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: "",
  };
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function deriveContextWindowMeterDisplay(
  usage: ContextWindowSnapshot,
): ContextWindowMeterDisplay {
  const usedPercentageLabel = formatPercentage(usage.usedPercentage);
  const tokenUsageLabel = formatContextWindowTokens(usage.usedTokens);
  const hasReliableTokenRatio =
    usage.maxTokens !== null &&
    (usage.usedTokens > 0 || usage.usedPercent === null || usage.remainingTokens !== null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  return {
    usedPercentageLabel,
    tokenUsageLabel,
    hasReliableTokenRatio,
    normalizedPercentage,
    compactLabel:
      usage.usedPercentage !== null ? `${Math.round(usage.usedPercentage)}%` : tokenUsageLabel,
    ariaLabel: usedPercentageLabel
      ? `Context window ${usedPercentageLabel} used`
      : `Context window ${tokenUsageLabel} tokens used`,
  };
}

export function deriveCumulativeCostUsd(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  let turnDeltaTotal = 0;
  let latestCumulative: number | null = null;
  let foundTurnDelta = false;
  for (const activity of activities) {
    if (activity.kind !== "turn.completed") continue;
    const payload = asRecord(activity.payload);
    const cumulativeCost = asFiniteNumber(payload?.cumulativeCostUsd);
    if (cumulativeCost !== null) {
      latestCumulative = cumulativeCost;
      continue;
    }
    const cost = asFiniteNumber(payload?.totalCostUsd);
    if (cost === null) continue;
    turnDeltaTotal += cost;
    foundTurnDelta = true;
  }
  if (latestCumulative !== null) {
    return latestCumulative + turnDeltaTotal;
  }
  return foundTurnDelta ? turnDeltaTotal : null;
}

export function formatContextWindowSelectionLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1m") {
    return "1M";
  }
  if (normalized === "200k") {
    return "200k";
  }
  return normalized.replace(/m$/u, "M");
}

export function inferContextWindowSelectionValue(
  maxTokens: number | null | undefined,
): string | null {
  if (maxTokens == null || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return null;
  }
  const bestMatch = Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).reduce<{
    value: string | null;
    relativeDistance: number;
  }>(
    (best, [value, knownMaxTokens]) => {
      const relativeDistance = Math.abs(maxTokens - knownMaxTokens) / knownMaxTokens;
      return relativeDistance < best.relativeDistance ? { value, relativeDistance } : best;
    },
    { value: null, relativeDistance: Number.POSITIVE_INFINITY },
  );
  return bestMatch.relativeDistance <= 0.2 ? bestMatch.value : null;
}

export function deriveContextWindowSelectionStatus(input: {
  activeSnapshot: ContextWindowSnapshot | null;
  selectedValue: string | null | undefined;
}): ContextWindowSelectionStatus {
  const activeValue = inferContextWindowSelectionValue(input.activeSnapshot?.maxTokens ?? null);
  const selectedValue = input.selectedValue?.trim().toLowerCase() ?? null;
  const activeLabel =
    formatContextWindowSelectionLabel(activeValue) ??
    (input.activeSnapshot?.maxTokens != null
      ? formatContextWindowTokens(input.activeSnapshot.maxTokens)
      : null);
  const selectedLabel = formatContextWindowSelectionLabel(selectedValue);
  const pendingSelectedLabel =
    selectedLabel !== null && activeValue !== null && selectedValue !== activeValue
      ? selectedLabel
      : null;

  return {
    activeLabel,
    selectedLabel,
    pendingSelectedLabel,
  };
}

export function formatCostUsd(value: number): string {
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatContextWindowTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
