import type { ThreadTokenUsageSnapshot } from "@synara/contracts";

import { nonNegativeInteger, positiveInteger } from "./tokenUsage.ts";

interface AntigravityPrintOutput {
  readonly response: string;
  readonly conversationId?: string;
  readonly error?: string;
  readonly usage?: ThreadTokenUsageSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The headless result's usage is cumulative over the conversation, including
// resumed invocations. Forward total_tokens unchanged: thinking is already in
// output_tokens, and cache_read_tokens must not be added to the reported total.
// https://antigravity.google/docs/cli/headless/#read-the-results
export function parseAntigravityPrintOutput(stdout: string): AntigravityPrintOutput {
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    return { response: stdout.trim() };
  }
  if (
    !isRecord(result) ||
    typeof result.response !== "string" ||
    typeof result.status !== "string"
  ) {
    return { response: stdout.trim() };
  }
  const usage = isRecord(result.usage) ? result.usage : {};
  const totalProcessedTokens = positiveInteger(usage.total_tokens);
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const cachedInputTokens = nonNegativeInteger(usage.cache_read_tokens);
  const reasoningOutputTokens = nonNegativeInteger(usage.thinking_tokens);
  return {
    response: result.response.trim(),
    ...(typeof result.conversation_id === "string" && result.conversation_id.trim()
      ? { conversationId: result.conversation_id.trim() }
      : {}),
    ...(result.status !== "SUCCESS"
      ? {
          error:
            typeof result.error === "string" && result.error.trim()
              ? result.error.trim()
              : `Antigravity CLI returned ${result.status}.`,
        }
      : {}),
    ...(totalProcessedTokens !== undefined
      ? {
          usage: {
            // These are processed-token counters, not context occupancy.
            usedTokens: 0,
            totalProcessedTokens,
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
          },
        }
      : {}),
  };
}
