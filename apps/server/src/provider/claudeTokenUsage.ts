import type {
  ModelUsage,
  NonNullableUsage,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadTokenUsageSnapshot } from "@synara/contracts";
import {
  getClaudeContextWindowSuffix,
  getDefaultAutoCompactWindow,
  getModelCapabilities,
  hasAutoCompactWindowOption,
  stripClaudeContextWindowSuffix,
  trimOrNull,
} from "@synara/shared/model";

import { positiveFiniteNumber } from "./tokenUsage.ts";

export const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

function claudeContextWindowTokensForOption(value: string | null): number | undefined {
  return value !== null && Object.hasOwn(CLAUDE_CONTEXT_WINDOW_MAX_TOKENS, value)
    ? CLAUDE_CONTEXT_WINDOW_MAX_TOKENS[value as keyof typeof CLAUDE_CONTEXT_WINDOW_MAX_TOKENS]
    : undefined;
}

const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_CONTEXT_WARNING_RATIO = 0.8;
const CLAUDE_UNCACHED_INGESTION_WARNING_TOKENS = 50_000;
const CLAUDE_LOW_CACHE_RATIO_MIN_PROMPT_TOKENS = 20_000;
const CLAUDE_LOW_CACHE_READ_RATIO = 0.2;

export type ClaudeContextUsageWarningKey = "uncached-ingestion" | "near-window" | "large-prompt";

export interface ClaudeContextUsageWarning {
  readonly key: ClaudeContextUsageWarningKey;
  readonly message: string;
}

export interface ClaudeContextUsageWarningDecisions {
  readonly first: ClaudeContextUsageWarning;
  readonly second?: ClaudeContextUsageWarning;
}

export function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = positiveFiniteNumber(value.contextWindow);
    if (contextWindow === undefined) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function finiteClaudeTokenCountOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function claudePromptTokensFromRawUsage(usage: Record<string, unknown>): number {
  return (
    finiteClaudeTokenCountOrZero(usage.input_tokens) +
    finiteClaudeTokenCountOrZero(usage.cache_creation_input_tokens) +
    finiteClaudeTokenCountOrZero(usage.cache_read_input_tokens)
  );
}

function formatApproxTokens(tokens: number): string {
  return tokens >= 1_000 ? `~${Math.round(tokens / 1_000)}k` : String(Math.round(tokens));
}

export function resolveClaudeEffectiveContextBudget(
  lastKnownAutoCompactThreshold: number | undefined,
  currentAutoCompactWindow: number | undefined,
  lastKnownContextWindow: number | undefined,
): number | undefined {
  const autoCompactBudget = lastKnownAutoCompactThreshold ?? currentAutoCompactWindow;
  if (autoCompactBudget !== undefined && lastKnownContextWindow !== undefined) {
    return Math.min(autoCompactBudget, lastKnownContextWindow);
  }
  return autoCompactBudget ?? lastKnownContextWindow;
}

export function normalizeClaudeTokenUsage(
  value: NonNullableUsage | Record<string, unknown> | undefined,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = claudePromptTokensFromRawUsage(usage);
  const outputTokens = finiteClaudeTokenCountOrZero(usage.output_tokens);
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  const maxTokens = positiveFiniteNumber(contextWindow);
  const usedTokens =
    maxTokens !== undefined ? Math.min(totalProcessedTokens, maxTokens) : totalProcessedTokens;

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof usage.tool_uses === "number" && Number.isFinite(usage.tool_uses)
      ? { toolUses: usage.tool_uses }
      : {}),
    ...(typeof usage.duration_ms === "number" && Number.isFinite(usage.duration_ms)
      ? { durationMs: usage.duration_ms }
      : {}),
  };
}

export function mergeClaudeTokenUsageSnapshot(
  previous: ThreadTokenUsageSnapshot,
  accumulated: ThreadTokenUsageSnapshot | undefined,
  contextWindow?: number,
): ThreadTokenUsageSnapshot {
  const maxTokens = positiveFiniteNumber(contextWindow);
  const usedTokens =
    maxTokens !== undefined ? Math.min(previous.usedTokens, maxTokens) : previous.usedTokens;
  const lastUsedTokens =
    previous.lastUsedTokens !== undefined
      ? maxTokens !== undefined
        ? Math.min(previous.lastUsedTokens, maxTokens)
        : previous.lastUsedTokens
      : usedTokens;
  const totalProcessedTokens = Math.max(
    previous.totalProcessedTokens ?? previous.usedTokens,
    accumulated?.totalProcessedTokens ?? accumulated?.usedTokens ?? 0,
    usedTokens,
  );

  return {
    ...previous,
    usedTokens,
    lastUsedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
  };
}

export function resolveClaudeApiModelIdContextWindowMaxTokens(
  apiModelId: string | undefined,
): number | undefined {
  if (!apiModelId) {
    return undefined;
  }
  return (
    claudeContextWindowTokensForOption(getClaudeContextWindowSuffix(apiModelId)) ??
    positiveFiniteNumber(
      getModelCapabilities("claudeAgent", stripClaudeContextWindowSuffix(apiModelId))
        .contextWindowTokens,
    )
  );
}

export function resolveSelectedClaudeAutoCompactWindow(
  model: string | null | undefined,
  selectedAutoCompactWindow: string | null | undefined,
): number | undefined {
  const caps = getModelCapabilities("claudeAgent", model);
  const selected = trimOrNull(selectedAutoCompactWindow);
  // Only an explicit override is pinned; the model-native window is left to
  // Claude Code's own resolution (server tuning, settings.json, env override).
  if (
    !selected ||
    selected === getDefaultAutoCompactWindow(caps, model) ||
    !hasAutoCompactWindowOption(caps, selected)
  ) {
    return undefined;
  }
  return claudeContextWindowTokensForOption(selected);
}

export function resolveEffectiveClaudeContextWindow(input: {
  readonly reportedContextWindow: number | undefined;
  readonly lastKnownContextWindow: number | undefined;
}): number | undefined {
  const { reportedContextWindow, lastKnownContextWindow } = input;
  if (reportedContextWindow !== undefined && lastKnownContextWindow !== undefined) {
    // Some SDK result payloads still report the historical 200k window for
    // native-1M models. Never downgrade a known model capacity from that field.
    return Math.max(reportedContextWindow, lastKnownContextWindow);
  }
  return reportedContextWindow ?? lastKnownContextWindow;
}

export function snapshotFromClaudeContextUsage(
  usage: SDKControlGetContextUsageResponse,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot {
  const effectiveMaxTokens =
    positiveFiniteNumber(usage.autoCompactThreshold) ??
    positiveFiniteNumber(usage.maxTokens) ??
    positiveFiniteNumber(usage.rawMaxTokens);
  const usedTokens = Math.max(0, Math.round(usage.totalTokens));
  const rawApiUsage = usage.apiUsage as Record<string, unknown> | undefined;
  const inputTokens = Math.max(
    0,
    Math.round(rawApiUsage ? claudePromptTokensFromRawUsage(rawApiUsage) : 0),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.round(finiteClaudeTokenCountOrZero(rawApiUsage?.cache_read_input_tokens)),
  );
  const outputTokens = Math.max(
    0,
    Math.round(finiteClaudeTokenCountOrZero(rawApiUsage?.output_tokens)),
  );
  return {
    usedTokens:
      effectiveMaxTokens !== undefined ? Math.min(usedTokens, effectiveMaxTokens) : usedTokens,
    lastUsedTokens: usedTokens,
    ...(effectiveMaxTokens !== undefined
      ? {
          maxTokens: effectiveMaxTokens,
          usedPercent: Math.min(100, (usedTokens / effectiveMaxTokens) * 100),
        }
      : {}),
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    compactsAutomatically: usage.isAutoCompactEnabled,
  };
}

export function decideClaudeContextUsageWarnings(
  rawUsage: Record<string, unknown>,
  contextBudget: number | undefined,
  emittedWarnings: ReadonlySet<string>,
): ClaudeContextUsageWarningDecisions | undefined {
  const promptTokens = claudePromptTokensFromRawUsage(rawUsage);
  if (promptTokens <= 0) {
    return undefined;
  }

  const cachedReadTokens = finiteClaudeTokenCountOrZero(rawUsage.cache_read_input_tokens);
  const uncachedTokens = Math.max(0, promptTokens - cachedReadTokens);
  const composition =
    cachedReadTokens > 0
      ? ` (${formatApproxTokens(cachedReadTokens)} cached reads, ${formatApproxTokens(uncachedTokens)} new/cache-write)`
      : "";
  const cacheReadRatio = cachedReadTokens / promptTokens;
  let first: ClaudeContextUsageWarning | undefined;

  if (
    (uncachedTokens > CLAUDE_UNCACHED_INGESTION_WARNING_TOKENS ||
      (promptTokens > CLAUDE_LOW_CACHE_RATIO_MIN_PROMPT_TOKENS &&
        cacheReadRatio < CLAUDE_LOW_CACHE_READ_RATIO)) &&
    !emittedWarnings.has("uncached-ingestion")
  ) {
    first = {
      key: "uncached-ingestion",
      message: `Claude ingested ${formatApproxTokens(uncachedTokens)} uncached prompt tokens in one request (${Math.round(cacheReadRatio * 100)}% cache reads). This usually means a fresh session, a session restart replaying history via resume, or a first turn over a large context; uncached input consumes usage limits fastest.`,
    };
  }

  const effectiveContextBudget = contextBudget ?? CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (
    promptTokens > effectiveContextBudget * CLAUDE_CONTEXT_WARNING_RATIO &&
    !emittedWarnings.has("near-window")
  ) {
    const warning: ClaudeContextUsageWarning = {
      key: "near-window",
      message: `Claude context is above 80% of the ${Math.round(effectiveContextBudget / 1_000)}k auto-compact budget (${formatApproxTokens(promptTokens)} logical prompt tokens${composition}). Consider compacting or starting a fresh thread; cached reads cost less than fresh input.`,
    };
    return first ? { first, second: warning } : { first: warning };
  }

  if (promptTokens > CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS && !emittedWarnings.has("large-prompt")) {
    const warning: ClaudeContextUsageWarning = {
      key: "large-prompt",
      message: `Claude is processing ${formatApproxTokens(promptTokens)} logical prompt tokens per request${composition}. Large active contexts can consume usage faster; cached reads cost less than fresh input.`,
    };
    return first ? { first, second: warning } : { first: warning };
  }

  return first ? { first } : undefined;
}
