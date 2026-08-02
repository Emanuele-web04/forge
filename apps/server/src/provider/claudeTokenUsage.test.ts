import type { ModelUsage, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  claudePromptTokensFromRawUsage,
  decideClaudeContextUsageWarnings,
  maxClaudeContextWindowFromModelUsage,
  mergeClaudeTokenUsageSnapshot,
  normalizeClaudeTokenUsage,
  resolveClaudeApiModelIdContextWindowMaxTokens,
  resolveClaudeEffectiveContextBudget,
  resolveEffectiveClaudeContextWindow,
  resolveSelectedClaudeAutoCompactWindow,
  snapshotFromClaudeContextUsage,
} from "./claudeTokenUsage.ts";

describe("Claude token arithmetic", () => {
  it("counts fresh, cache-write, and cache-read tokens while ignoring malformed values", () => {
    expect(
      claudePromptTokensFromRawUsage({
        input_tokens: 4,
        cache_creation_input_tokens: 2_715,
        cache_read_input_tokens: 21_144,
      }),
    ).toBe(23_863);
    expect(
      claudePromptTokensFromRawUsage({
        input_tokens: Number.NaN,
        cache_creation_input_tokens: "500",
        cache_read_input_tokens: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0);
  });

  it.each([
    {
      name: "derives totals from input and output fields",
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 2_715,
        cache_read_input_tokens: 21_144,
        output_tokens: 679,
      },
      contextWindow: 200_000,
      expected: {
        usedTokens: 24_542,
        lastUsedTokens: 24_542,
        inputTokens: 23_863,
        outputTokens: 679,
        maxTokens: 200_000,
      },
    },
    {
      name: "clamps an accumulated total to 200k",
      usage: { total_tokens: 535_000 },
      contextWindow: 200_000,
      expected: {
        usedTokens: 200_000,
        lastUsedTokens: 200_000,
        totalProcessedTokens: 535_000,
        maxTokens: 200_000,
      },
    },
    {
      name: "keeps the larger 1m window",
      usage: { total_tokens: 535_000 },
      contextWindow: 1_000_000,
      expected: {
        usedTokens: 535_000,
        lastUsedTokens: 535_000,
        maxTokens: 1_000_000,
      },
    },
  ])("$name", ({ usage, contextWindow, expected }) => {
    expect(normalizeClaudeTokenUsage(usage, contextWindow)).toEqual(expected);
  });

  it("merges accumulated totals without replacing the live context snapshot", () => {
    expect(
      mergeClaudeTokenUsageSnapshot(
        {
          usedTokens: 190_000,
          lastUsedTokens: 190_000,
          maxTokens: 200_000,
        },
        {
          usedTokens: 200_000,
          lastUsedTokens: 200_000,
          totalProcessedTokens: 535_000,
          maxTokens: 200_000,
        },
        200_000,
      ),
    ).toEqual({
      usedTokens: 190_000,
      lastUsedTokens: 190_000,
      totalProcessedTokens: 535_000,
      maxTokens: 200_000,
    });
  });

  it("normalizes the SDK live context response and prefers its auto-compact threshold", () => {
    const usage = {
      categories: [],
      totalTokens: 220_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 22,
      gridRows: [],
      model: "claude-sonnet-5",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 200_000,
      isAutoCompactEnabled: true,
      apiUsage: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 105_000,
      },
    } satisfies SDKControlGetContextUsageResponse;

    expect(snapshotFromClaudeContextUsage(usage, 535_000)).toEqual({
      usedTokens: 200_000,
      lastUsedTokens: 220_000,
      maxTokens: 200_000,
      usedPercent: 100,
      totalProcessedTokens: 535_000,
      inputTokens: 120_000,
      lastInputTokens: 120_000,
      cachedInputTokens: 105_000,
      lastCachedInputTokens: 105_000,
      outputTokens: 2_000,
      lastOutputTokens: 2_000,
      compactsAutomatically: true,
    });
  });
});

describe("Claude context selection", () => {
  it.each([
    [undefined, undefined, undefined, undefined],
    [undefined, 200_000, 1_000_000, 200_000],
    [180_000, 200_000, 1_000_000, 180_000],
    [1_000_000, 200_000, 200_000, 200_000],
  ] as const)(
    "resolves threshold=%s selected=%s capacity=%s to %s",
    (threshold, selected, capacity, expected) => {
      expect(resolveClaudeEffectiveContextBudget(threshold, selected, capacity)).toBe(expected);
    },
  );

  it.each([
    ["claude-opus-4-6", "200k", 200_000],
    ["claude-opus-4-6", "1m", 1_000_000],
    ["claude-opus-4-6", undefined, 200_000],
    ["claude-opus-4-5", "1m", undefined],
    ["claude-opus-4-6", "2m", undefined],
    // #367: custom/proxy Claude slugs inherit the flagship auto-compact ladder.
    ["claude/custom-opus", undefined, 200_000],
    ["my-proxy/custom-opus", "1m", 1_000_000],
  ] as const)("resolves model=%s selection=%s to %s", (model, selected, expected) => {
    expect(resolveSelectedClaudeAutoCompactWindow(model, selected)).toBe(expected);
  });

  it("preserves known 1m model capacity when result metadata reports a stale 200k window", () => {
    expect(
      resolveClaudeApiModelIdContextWindowMaxTokens(
        "claude-opus-4-6[thinking=true,context=1m,effort=high,fast=false]",
      ),
    ).toBe(1_000_000);
    expect(
      resolveEffectiveClaudeContextWindow({
        reportedContextWindow: 200_000,
        lastKnownContextWindow: 1_000_000,
      }),
    ).toBe(1_000_000);
  });

  it("takes the largest valid context window from model usage", () => {
    const modelUsage = {
      stale: { contextWindow: 200_000 },
      current: { contextWindow: 1_000_000 },
      malformed: { contextWindow: Number.NaN },
    } as unknown as Record<string, ModelUsage>;

    expect(maxClaudeContextWindowFromModelUsage(modelUsage)).toBe(1_000_000);
  });
});

describe("Claude context warning decisions", () => {
  it.each([
    {
      name: "does nothing for a small prompt",
      rawUsage: { input_tokens: 1_000 },
      contextBudget: 200_000,
      emitted: [],
      keys: [],
    },
    {
      name: "warns for a large mostly-uncached request",
      rawUsage: {
        input_tokens: 5_000,
        cache_creation_input_tokens: 55_000,
        cache_read_input_tokens: 1_000,
      },
      contextBudget: 200_000,
      emitted: [],
      keys: ["uncached-ingestion"],
    },
    {
      name: "warns near the 200k auto-compact threshold",
      rawUsage: { input_tokens: 2, cache_read_input_tokens: 170_000 },
      contextBudget: 200_000,
      emitted: [],
      keys: ["near-window"],
    },
    {
      name: "uses the large-prompt warning below the 1m threshold",
      rawUsage: { input_tokens: 2, cache_read_input_tokens: 320_000 },
      contextBudget: 1_000_000,
      emitted: [],
      keys: ["large-prompt"],
    },
    {
      name: "preserves warning order when two policies match",
      rawUsage: { input_tokens: 190_000 },
      contextBudget: 200_000,
      emitted: [],
      keys: ["uncached-ingestion", "near-window"],
    },
    {
      name: "does not repeat warnings already emitted by the session",
      rawUsage: { input_tokens: 190_000 },
      contextBudget: 200_000,
      emitted: ["uncached-ingestion", "near-window", "large-prompt"],
      keys: [],
    },
  ])("$name", ({ rawUsage, contextBudget, emitted, keys }) => {
    const decisions = decideClaudeContextUsageWarnings(rawUsage, contextBudget, new Set(emitted));
    const actualKeys = decisions
      ? [decisions.first.key, ...(decisions.second ? [decisions.second.key] : [])]
      : [];

    expect(actualKeys).toEqual(keys);
  });

  it("defers the large-prompt warning until a later call after near-window is de-duplicated", () => {
    const rawUsage = { input_tokens: 220_000 };
    const firstCall = decideClaudeContextUsageWarnings(rawUsage, 200_000, new Set());
    expect([firstCall?.first.key, firstCall?.second?.key]).toEqual([
      "uncached-ingestion",
      "near-window",
    ]);

    const secondCall = decideClaudeContextUsageWarnings(
      rawUsage,
      200_000,
      new Set(["uncached-ingestion", "near-window"]),
    );
    expect(secondCall).toMatchObject({
      first: { key: "large-prompt" },
    });
    expect(secondCall?.second).toBeUndefined();
  });
});
