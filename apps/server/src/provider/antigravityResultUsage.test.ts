import { describe, expect, it } from "vitest";
import { parseAntigravityPrintResult } from "./antigravityResultUsage";

const encode = (values: unknown[]) => values.map((x) => JSON.stringify(x)).join("\n");

describe("Antigravity print result", () => {
  it("recognizes completed current responses despite historical errors but rejects unfinished tools", () => {
    const agent = {
      event: "step_update",
      step_update: {
        step_index: 65,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "RECOVERED",
      },
    };
    const result = {
      event: "result",
      result: { status: "ERROR", num_turns: 13, error: "Historical error" },
    };
    expect(parseAntigravityPrintResult(encode([agent, result]))?.completedResponse).toBe(true);
    const tool = {
      event: "step_update",
      step_update: { step_index: 66, state: "ACTIVE", step_type: "tool" },
    };
    expect(parseAntigravityPrintResult(encode([agent, tool, result]))?.completedResponse).toBe(
      false,
    );
    expect(
      parseAntigravityPrintResult(encode([agent, { event: "error" }, result]))?.completedResponse,
    ).toBe(false);
  });
  it("recovers first-turn timeout after a complete response, including a textless DONE update", () => {
    const updates = [
      {
        event: "step_update",
        step_update: { step_index: 0, step_type: "user_input", state: "DONE" },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "Finished",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 50 },
        },
      },
    ];
    const result = { status: "ERROR", num_turns: 1, error: "timeout waiting for response" };
    expect(
      parseAntigravityPrintResult(encode([...updates, { event: "result", result }])),
    ).toMatchObject({ completedResponse: true, usage: { inputTokens: 150, outputTokens: 10 } });
    expect(
      parseAntigravityPrintResult(
        encode([...updates, { event: "result", result: { ...result, error: "quota exceeded" } }]),
      )?.completedResponse,
    ).toBe(false);
    expect(
      parseAntigravityPrintResult(encode([...updates.slice(0, 2), { event: "result", result }]))
        ?.completedResponse,
    ).toBe(false);
  });
  it("uses this invocation's latest per-step counters, not the cumulative envelope", () => {
    const usage = {
      input_tokens: 50,
      output_tokens: 4,
      cache_read_tokens: 100,
      thinking_tokens: 2,
    };
    const records = [
      {
        event: "step_update",
        step_update: { step_index: 4, usage: { ...usage, output_tokens: 1 } },
      },
      { event: "step_update", step_update: { step_index: 4, usage } },
      { event: "step_update", step_update: { step_index: 6, usage } },
      {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "OK",
          num_turns: 9,
          duration_seconds: 9000,
          usage: { input_tokens: 99999, output_tokens: 900 },
        },
      },
    ];
    expect(
      parseAntigravityPrintResult(records.map((x) => JSON.stringify(x)).join("\n"), 3000)?.usage,
    ).toEqual({
      inputTokens: 300,
      outputTokens: 8,
      cachedInputTokens: 200,
      reasoningOutputTokens: 4,
      durationMs: 3000,
    });
  });
  it("reads real CLI JSON without rendering the envelope as assistant text", () => {
    expect(
      parseAntigravityPrintResult(
        JSON.stringify({
          status: "SUCCESS",
          response: "SG-OK\n",
          duration_seconds: 2.79464,
          usage: {
            input_tokens: 13286,
            output_tokens: 3,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 13289,
          },
        }),
      ),
    ).toMatchObject({
      response: "SG-OK\n",
      failed: false,
      usage: {
        inputTokens: 13286,
        outputTokens: 3,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        durationMs: 2794.64,
      },
    });
  });
  it("distinguishes errors and legacy text from successful usage", () => {
    expect(parseAntigravityPrintResult("legacy text")).toBeUndefined();
    expect(
      parseAntigravityPrintResult('{"status":"ERROR","response":"","error":"failed"}'),
    ).toMatchObject({ response: "", failed: true, error: "failed", usage: undefined });
    expect(
      parseAntigravityPrintResult(
        '{"status":"SUCCESS","usage":{"input_tokens":-1,"output_tokens":4}}',
      )?.usage,
    ).toBeUndefined();
  });
  it("includes separately reported cached input in the normalized prompt total", () => {
    expect(
      parseAntigravityPrintResult(
        JSON.stringify({
          status: "SUCCESS",
          response: "AGY-SG-OK",
          duration_seconds: 3.100526,
          usage: {
            input_tokens: 5162,
            output_tokens: 6,
            cache_read_tokens: 8128,
            thinking_tokens: 0,
            total_tokens: 5168,
          },
        }),
      )?.usage,
    ).toMatchObject({ inputTokens: 13290, outputTokens: 6, cachedInputTokens: 8128 });
  });
});
