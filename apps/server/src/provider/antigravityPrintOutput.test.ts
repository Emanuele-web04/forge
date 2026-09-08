import { describe, expect, it } from "vitest";

import { parseAntigravityPrintOutput } from "./antigravityPrintOutput.ts";

// Sanitized agy 1.1.27 JSON results from two real turns, the second resumed.
const firstUsage = {
  input_tokens: 5952,
  output_tokens: 473,
  thinking_tokens: 465,
  cache_read_tokens: 8131,
  total_tokens: 6425,
};
const secondUsage = {
  input_tokens: 13420,
  output_tokens: 549,
  thinking_tokens: 536,
  cache_read_tokens: 16297,
  total_tokens: 13969,
};
const envelope = (usage: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    conversation_id: "test-conversation",
    status: "SUCCESS",
    response: "hello\n",
    usage,
    ...extra,
  });

describe("parseAntigravityPrintOutput", () => {
  it("unwraps the response and preserves native cumulative totals across resume", () => {
    const first = parseAntigravityPrintOutput(envelope(firstUsage));
    const second = parseAntigravityPrintOutput(envelope(secondUsage, { num_turns: 2 }));
    expect(first).toEqual({
      response: "hello",
      conversationId: "test-conversation",
      usage: {
        usedTokens: 0,
        inputTokens: 5952,
        outputTokens: 473,
        reasoningOutputTokens: 465,
        cachedInputTokens: 8131,
        totalProcessedTokens: 6425,
      },
    });
    expect(second.usage?.totalProcessedTokens).toBe(13969);
    expect(second.usage?.totalProcessedTokens! - first.usage?.totalProcessedTokens!).toBe(7544);
    expect(first.usage?.maxTokens).toBeUndefined();
    expect(first.usage?.usedPercent).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    {},
    { total_tokens: 0 },
    { total_tokens: -1 },
    { total_tokens: 1.5 },
    { total_tokens: "100" },
  ])("does not fabricate usage for %j", (usage) => {
    expect(parseAntigravityPrintOutput(envelope(usage)).usage).toBeUndefined();
  });

  it("ignores invalid optional dimensions without losing a valid total", () => {
    expect(
      parseAntigravityPrintOutput(
        envelope({ total_tokens: 100, input_tokens: -1, output_tokens: "20" }),
      ).usage,
    ).toEqual({ usedTokens: 0, totalProcessedTokens: 100 });
  });

  it("preserves plain output from older wrappers and arbitrary JSON responses", () => {
    for (const text of ["hello", '{"answer":42}', "{truncated", "[]"]) {
      expect(parseAntigravityPrintOutput(text)).toEqual({ response: text });
    }
  });

  it("surfaces envelope errors while retaining any reported consumption", () => {
    expect(
      parseAntigravityPrintOutput(
        envelope(firstUsage, { status: "ERROR", response: "", error: "model unavailable" }),
      ),
    ).toMatchObject({
      response: "",
      error: "model unavailable",
      usage: { totalProcessedTokens: 6425 },
    });
  });
});
