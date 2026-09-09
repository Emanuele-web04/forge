import { describe, expect, it } from "vitest";
import { claudeTurnResultUsage, type ClaudeResultUsageBaseline } from "./claudeResultUsage";

function result(
  input: number,
  output: number,
  reads: number,
  writes: number,
  cost: number,
): ClaudeResultUsageBaseline {
  return {
    total_cost_usd: cost,
    modelUsage: {
      sonnet: {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: reads,
        cacheCreationInputTokens: writes,
        costUSD: cost,
        webSearchRequests: 0,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
  };
}

describe("Claude cumulative result accounting", () => {
  it("subtracts the preceding SDK result instead of charging prior turns again", () => {
    const first = result(6, 211, 86202, 43334, 0.1926984);
    const next = result(8, 239, 129623, 43334, 0.2018);
    const usage = claudeTurnResultUsage(next, first);
    expect(usage.modelUsage.sonnet).toMatchObject({
      inputTokens: 2,
      outputTokens: 28,
      cacheReadInputTokens: 43421,
      cacheCreationInputTokens: 0,
      contextWindow: 200000,
    });
    expect(usage.totalCostUsd).toBeCloseTo(0.0091016);
  });
  it("starts at zero for a new process, a newly used model, or reset counters", () => {
    const first = result(10, 20, 30, 40, 0.1);
    expect(claudeTurnResultUsage(first, undefined).modelUsage).toEqual(first.modelUsage);
    expect(claudeTurnResultUsage(first, result(100, 200, 300, 400, 1)).modelUsage).toEqual(
      first.modelUsage,
    );
    expect(claudeTurnResultUsage(first, { total_cost_usd: 0, modelUsage: {} }).modelUsage).toEqual(
      first.modelUsage,
    );
  });
  it("repeated counters yield zero rather than duplicating usage", () => {
    const first = result(10, 20, 30, 40, 0.1);
    expect(claudeTurnResultUsage(first, first)).toMatchObject({
      totalCostUsd: 0,
      modelUsage: {
        sonnet: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
  });
});
