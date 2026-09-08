import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeResultUsageBaseline = Pick<SDKResultMessage, "modelUsage" | "total_cost_usd">;

const delta = (current: number, before: number | undefined) =>
  before !== undefined && current >= before ? current - before : current;

// Claude's long-lived SDK query reports process-cumulative modelUsage and cost.
// Keep the baseline on the query context, so a new/resumed process starts at zero.
export function claudeTurnResultUsage(
  result: ClaudeResultUsageBaseline,
  previous: ClaudeResultUsageBaseline | undefined,
) {
  const modelUsage = Object.fromEntries(
    Object.entries(result.modelUsage ?? {}).map(([model, current]) => {
      const before = previous?.modelUsage?.[model];
      return [
        model,
        {
          ...current,
          inputTokens: delta(current.inputTokens, before?.inputTokens),
          outputTokens: delta(current.outputTokens, before?.outputTokens),
          cacheReadInputTokens: delta(current.cacheReadInputTokens, before?.cacheReadInputTokens),
          cacheCreationInputTokens: delta(
            current.cacheCreationInputTokens,
            before?.cacheCreationInputTokens,
          ),
          costUSD: delta(current.costUSD, before?.costUSD),
        },
      ];
    }),
  );
  return { modelUsage, totalCostUsd: delta(result.total_cost_usd, previous?.total_cost_usd) };
}
