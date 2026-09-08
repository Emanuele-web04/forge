import { EventId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { deriveConversationUsage, deriveMessageUsageByTurnId } from "./messageUsage";
const turn = TurnId.makeUnsafe("one");
function event(
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
  turnId: TurnId | null = turn,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`${kind}-${turnId}`),
    kind,
    payload,
    turnId,
    tone: "info",
    summary: kind,
    createdAt: "2026-09-05T00:00:00.000Z",
  };
}
const codex = (input: number, output: number, read: number, turnId = turn, session = "c1") =>
  event(
    "context-window.updated",
    {
      provider: "codex",
      usageSessionId: session,
      usedTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 0,
      cumulativeUsage: { inputTokens: input, outputTokens: output, cachedInputTokens: read },
    },
    turnId,
  );
const values = (list: readonly { label: string; value: string }[]) =>
  Object.fromEntries(list.map((metric) => [metric.label, metric.value]));
const metrics = (events: OrchestrationThreadActivity[]) =>
  deriveMessageUsageByTurnId(events).get(turn) ?? [];

describe("turn and conversation usage", () => {
  it("uses Codex cumulative differences across tool requests, not the latest request", () => {
    const other = TurnId.makeUnsafe("two");
    const events = [
      codex(1000, 20, 0),
      codex(3000, 60, 1800),
      codex(3000, 60, 1800),
      codex(7000, 100, 5400, other),
    ];
    const usage = deriveConversationUsage(events);
    expect(values(usage.byTurnId.get(turn)!)).toEqual({
      "↑": "3k",
      "↓": "60",
      R: "1.8k",
      W: "—",
      CH: "60.0%",
    });
    expect(values(usage.byTurnId.get(other)!)).toEqual({
      "↑": "4k",
      "↓": "40",
      R: "3.6k",
      W: "—",
      CH: "90.0%",
    });
    expect(values(usage.cumulative)).toEqual({
      "↑": "7k",
      "↓": "100",
      R: "5.4k",
      W: "—",
      CH: "77.1%",
    });
    expect(deriveConversationUsage(JSON.parse(JSON.stringify(events)))).toEqual(usage);
  });
  it("handles process counter resets and new provider sessions without negative usage", () => {
    const two = TurnId.makeUnsafe("two"),
      three = TurnId.makeUnsafe("three");
    const usage = deriveConversationUsage([
      codex(3000, 60, 1000),
      codex(1000, 20, 0, two),
      codex(5000, 100, 2000, three, "c2"),
    ]);
    expect(values(usage.byTurnId.get(two)!)["↑"]).toBe("1k");
    expect(values(usage.byTurnId.get(three)!)["↑"]).toBe("5k");
    expect(values(usage.cumulative)["↑"]).toBe("9k");
  });
  it("reports Claude input including reads/writes and weights the conversation cache ratio", () => {
    const completion = (input: number, read: number, write: number, id = turn) =>
      event(
        "turn.completed",
        {
          modelUsage: {
            primary: {
              inputTokens: input,
              outputTokens: 59,
              cacheReadInputTokens: read,
              cacheCreationInputTokens: write,
            },
          },
        },
        id,
      );
    const usage = deriveConversationUsage([
      completion(38164, 0, 38162),
      completion(40000, 38000, 0, TurnId.makeUnsafe("two")),
    ]);
    expect(values(usage.byTurnId.get(turn)!)).toEqual({
      "↑": "38k",
      "↓": "59",
      R: "0",
      W: "38k",
      CH: "0.0%",
    });
    expect(values(usage.cumulative).CH).toBe("48.6%");
    expect(values(usage.cumulative).W).toBe("38k");
  });
  it("does not combine incomplete model cache counters with unrelated context snapshots", () => {
    const result = metrics([
      codex(3000, 60, 1000),
      event("turn.completed", {
        modelUsage: {
          main: { inputTokens: 1000, outputTokens: 40, cacheReadInputTokens: 800 },
          agent: { inputTokens: 1000, outputTokens: 10 },
        },
      }),
    ]);
    expect(values(result)).toEqual({ "↑": "2k", "↓": "50", R: "—", W: "—", CH: "—" });
  });
  it("includes Antigravity turn totals without inventing cache writes or context", () => {
    const result = metrics([
      event("turn.completed", {
        provider: "antigravity",
        usage: { inputTokens: 10000, outputTokens: 20, cachedInputTokens: 9000 },
      }),
    ]);
    expect(values(result)).toEqual({ "↑": "10k", "↓": "20", R: "9k", W: "—", CH: "90.0%" });
  });
  it("does not count repeated completion events or borrow unowned events", () => {
    const result = event("turn.completed", {
      provider: "antigravity",
      usage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0 },
    });
    const usage = deriveConversationUsage([
      result,
      result,
      codex(9999, 999, 9000, null as unknown as TurnId),
    ]);
    expect(values(usage.cumulative)["↑"]).toBe("1k");
    expect(values(usage.cumulative).CH).toBe("0.0%");
  });
  it("explicitly labels legacy Codex request-only metrics and does not invent turn totals", () => {
    const events = [
      event("context-window.updated", {
        provider: "codex",
        usedTokens: 21812,
        inputTokens: 21796,
        outputTokens: 16,
        cachedInputTokens: 0,
      }),
    ];
    expect(metrics(events)[0]?.detail).toContain("Latest request only");
    expect(deriveConversationUsage(events).cumulative).toEqual([]);
  });
  it("keeps usage even if context is compacted; omits a ratio for zero input", () => {
    const result = metrics([codex(0, 10, 0), event("context-compaction", { state: "compacted" })]);
    expect(values(result)).toEqual({ "↑": "0", "↓": "10", R: "0", W: "—", CH: "—" });
    expect(metrics([event("turn.completed", {})])).toEqual([]);
  });
});

describe("turn throughput", () => {
  const messages = [
    { role: "user" as const, createdAt: "2026-09-05T00:00:00.000Z" },
    { role: "assistant" as const, turnId: turn, createdAt: "2026-09-05T00:00:02.000Z" },
    { role: "assistant" as const, turnId: turn, createdAt: "2026-09-05T00:00:09.000Z" },
  ];
  const completed = {
    ...event("turn.completed", {}),
    createdAt: "2026-09-05T00:00:10.000Z",
  };
  it("uses the first model output marker even when thinking precedes text", () => {
    const first = {
      ...event("provider.first-output", { streamKind: "reasoning_text" }),
      createdAt: "2026-09-05T00:00:00.500Z",
    };
    const usage = deriveConversationUsage([first, codex(1000, 250, 900), completed], messages);
    expect(values(usage.byTurnId.get(turn)!).TTFT).toBe("0.5 s");
    expect(values(usage.cumulative).TTFT).toBeUndefined();
    expect(
      values(
        deriveConversationUsage([codex(1000, 250, 900), completed], messages).byTurnId.get(turn)!,
      ).TTFT,
    ).toBeUndefined();
    const invalid = { ...first, createdAt: "invalid" };
    expect(
      values(
        deriveConversationUsage([invalid, codex(1000, 250, 900)], messages).byTurnId.get(turn)!,
      ).TTFT,
    ).toBeUndefined();
  });

  it("uses full-turn output and wall time, without adding session TPS", () => {
    const usage = deriveConversationUsage([codex(1000, 250, 900), completed], messages);
    expect(values(usage.byTurnId.get(turn)!).TPS).toBe("25.0 tok/s");
    expect(values(usage.cumulative).TPS).toBeUndefined();
    expect(usage.byTurnId.get(turn)!.find((metric) => metric.label === "TPS")?.detail).toContain(
      "including thinking, tools and waiting",
    );
  });
  it("uses cumulative deltas for follow-up turns", () => {
    const next = TurnId.makeUnsafe("next");
    const usage = deriveConversationUsage(
      [
        codex(1000, 250, 900),
        completed,
        codex(2000, 350, 1800, next),
        { ...completed, turnId: next, createdAt: "2026-09-05T00:01:05.000Z" },
      ],
      [
        ...messages,
        { role: "user", createdAt: "2026-09-05T00:01:00.000Z" },
        { role: "assistant", turnId: next, createdAt: "2026-09-05T00:01:02.000Z" },
      ],
    );
    expect(values(usage.byTurnId.get(next)!).TPS).toBe("20.0 tok/s");
  });
  it.each(["claude-code", "antigravity"])("supports %s output totals", (provider) => {
    const payload =
      provider === "antigravity"
        ? { provider, usage: { inputTokens: 100, outputTokens: 300 } }
        : {
            modelUsage: {
              a: { inputTokens: 100, outputTokens: 100 },
              b: { inputTokens: 100, outputTokens: 200 },
            },
          };
    const usage = deriveConversationUsage([{ ...completed, payload }], messages);
    expect(values(usage.byTurnId.get(turn)!).TPS).toBe("30.0 tok/s");
  });
  it("omits speed for incomplete and legacy accounting", () => {
    expect(
      values(deriveConversationUsage([codex(100, 20, 50)], messages).byTurnId.get(turn)!).TPS,
    ).toBeUndefined();
    expect(
      values(deriveConversationUsage([codex(100, 20, 50), completed]).byTurnId.get(turn)!).TPS,
    ).toBeUndefined();
    const legacy = event("context-window.updated", {
      provider: "codex",
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(
      values(deriveConversationUsage([legacy, completed], messages).byTurnId.get(turn)!).TPS,
    ).toBeUndefined();
  });
  it.each(["invalid", "2026-09-05T00:00:00.000Z", "2026-09-04T00:00:00.000Z"])(
    "omits invalid elapsed time: %s",
    (createdAt) => {
      const usage = deriveConversationUsage(
        [codex(100, 20, 50), { ...completed, createdAt }],
        messages,
      );
      expect(values(usage.byTurnId.get(turn)!).TPS).toBeUndefined();
    },
  );
  it("preserves reported zero output", () => {
    const usage = deriveConversationUsage([codex(100, 0, 50), completed], messages);
    expect(values(usage.byTurnId.get(turn)!).TPS).toBe("0.0 tok/s");
  });
});
