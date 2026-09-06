// Opt-in CPU probe; no provider, database, network, or browser is needed.
// SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/tool-output.json bun run --cwd apps/web test perf/toolOutput.perf.test.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { MessageId } from "@synara/contracts";
import { summarizeToolRawOutput } from "@synara/shared/toolOutputSummary";
import { expect, it } from "vitest";

import { deriveWorkLogToolDetails } from "../src/lib/toolCallDetails";
import { deriveMessagesTimelineRows } from "../src/components/chat/MessagesTimeline.logic";
import { makeActivity } from "../src/storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../src/workLog";
import type { ChatMessage } from "../src/types";

const WARMUPS = 3;
const SAMPLES = 11;
const percentile = (values: number[], p: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;

it.skipIf(process.env.SYNARA_PERF !== "1")(
  "measures tool-output and transcript CPU paths",
  () => {
    const cases: { name: string; iterations: number; run: () => unknown }[] = [];
    for (const [name, output, iterations] of [
      ["short", "result line\n".repeat(10), 1_000],
      ["multiline-24k", "result line\n".repeat(2_000), 100],
      ["whitespace-24k", `start${" ".repeat(23_980)}end`, 1],
    ] as const) {
      const input = {
        label: "Run command",
        command: "cat output.txt",
        payload: { data: { rawOutput: { stdout: output } } },
      };
      cases.push({
        name: `details/${name}`,
        iterations,
        run: () => deriveWorkLogToolDetails(input),
      });
      const activities = [
        makeActivity({
          id: `tool-${name}`,
          kind: "tool.completed",
          summary: "Command completed",
          payload: { ...input.payload, detail: output, itemType: "command_execution" },
        }),
      ];
      cases.push({
        name: `work-log/${name}`,
        iterations,
        run: () => deriveWorkLogEntries(activities, undefined),
      });
    }
    for (const lines of [10, 2_000]) {
      const rawOutput = { content: "result line\n".repeat(lines) };
      cases.push({
        name: `read-summary/${lines}-lines`,
        iterations: 1_000,
        run: () => summarizeToolRawOutput(rawOutput),
      });
    }
    // Control: a normal retained transcript with tool narration, unrelated to output parsing.
    const messages: ChatMessage[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: MessageId.makeUnsafe(`message-${index}`),
      role: index % 4 === 0 ? "user" : "assistant",
      text: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000 + 500).toISOString(),
      streaming: false,
    }));
    const timelineEntries = deriveTimelineEntries(messages, [], []);
    const timelineInput = {
      timelineEntries,
      isWorking: false,
      worktreeSetup: null,
      worktreeSetupOpen: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    cases.push({
      name: "transcript/2000-messages",
      iterations: 20,
      run: () => deriveMessagesTimelineRows(timelineInput),
    });

    const report = cases.map(({ name, iterations, run }) => {
      let result: unknown;
      const wallMs: number[] = [];
      const cpuMs: number[] = [];
      for (let sample = -WARMUPS; sample < SAMPLES; sample += 1) {
        const cpuBefore = process.cpuUsage();
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration += 1) result = run();
        const elapsed = performance.now() - start;
        const cpu = process.cpuUsage(cpuBefore);
        if (sample >= 0) {
          wallMs.push(elapsed / iterations);
          cpuMs.push((cpu.user + cpu.system) / 1_000 / iterations);
        }
      }
      expect(result).toBeDefined();
      return {
        name,
        iterations,
        wallMs,
        cpuMs,
        medianMs: percentile(wallMs, 0.5),
        p95Ms: percentile(wallMs, 0.95),
        outputHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      };
    });
    const output = {
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
        cpu: os.cpus()[0]?.model,
        memoryBytes: os.totalmem(),
      },
      warmups: WARMUPS,
      samples: SAMPLES,
      report,
    };
    console.table(report.map(({ name, medianMs, p95Ms }) => ({ name, medianMs, p95Ms })));
    writeFileSync(
      process.env.SYNARA_PERF_OUT ?? "/tmp/synara-tool-output.json",
      JSON.stringify(output, null, 2),
    );
  },
  120_000,
);
