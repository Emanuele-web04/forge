// SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/prior-transcript.json bun run --cwd apps/server test perf/priorTranscript.perf.test.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { MessageId, type OrchestrationMessage } from "@synara/contracts";
import { expect, it } from "vitest";
import { listPriorTranscriptMessages } from "../src/orchestration/handoff";

it.skipIf(process.env.SYNARA_PERF !== "1")(
  "measures prior-transcript selection at turn start",
  () => {
    const body =
      "Review the implementation.\n```ts\nfunction sum(a, b) {\n  return a + b;\n}\n```\n"
        .repeat(30)
        .slice(0, 2_048);
    const report = [];
    for (const count of [32, 1_000, 2_000]) {
      const messages: OrchestrationMessage[] = Array.from({ length: count }, (_, index) => ({
        id: MessageId.makeUnsafe(`message-${index}`),
        role: index % 2 === 0 ? "user" : "assistant",
        text: Buffer.from(`${index}: ${body}`.slice(0, 2_048)).toString(),
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-09-06T00:00:00Z",
        updatedAt: "2026-09-06T00:00:00Z",
      }));
      const thread = { messages };
      const currentMessageId = messages.at(-1)!.id;
      const iterations = count === 32 ? 1_000 : 50;
      const wallMs: number[] = [];
      let output: ReadonlyArray<OrchestrationMessage> = [];
      for (let sample = -3; sample < 11; sample += 1) {
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration += 1)
          output = listPriorTranscriptMessages(thread, currentMessageId);
        if (sample >= 0) wallMs.push((performance.now() - start) / iterations);
      }
      expect(output).toHaveLength(count - 1);
      expect(output.every((message, index) => message === messages[index])).toBe(true);
      const ordered = wallMs.toSorted((a, b) => a - b);
      report.push({
        name: `select/${count}-messages-2KiB`,
        iterations,
        wallMs,
        medianMs: ordered[5],
        p95Ms: ordered[10],
        outputHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      });
    }
    writeFileSync(
      process.env.SYNARA_PERF_OUT ?? "/tmp/synara-prior-transcript.json",
      JSON.stringify({ node: process.version, warmups: 3, samples: 11, report }, null, 2),
    );
  },
  120_000,
);
