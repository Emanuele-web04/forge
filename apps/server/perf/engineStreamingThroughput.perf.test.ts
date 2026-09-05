// Perf probe: orchestration engine throughput for streaming assistant deltas across T
// concurrently streaming threads (file-backed WAL SQLite, real engine + projection pipeline).
// Capacity probe only: provider journal, transport, renderer and provider children are excluded.
//   SYNARA_PERF=1 bunx vitest run perf/engineStreamingThroughput.perf.test.ts
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../src/config.ts";

const ENABLED = process.env.SYNARA_PERF === "1";
const DELTAS_PER_THREAD = Number(process.env.SYNARA_PERF_DELTAS ?? 1_500);
if (!Number.isInteger(DELTAS_PER_THREAD) || DELTAS_PER_THREAD <= 0) {
  throw new Error("SYNARA_PERF_DELTAS must be a positive integer per thread");
}
const DELTA_TEXT = "x".repeat(66); // real DB average: ~66 chars per thread.message-sent event
const THREAD_COUNTS = [1, 5, 10];

async function createSystem(dbPath: string) {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "synara-engine-perf-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return { engine, runtime };
}

describe.skipIf(!ENABLED)("engine streaming throughput", () => {
  it("measures ms per delta for 1/5/10 concurrently streaming threads", async () => {
    const report: Record<string, unknown>[] = [];
    for (let repeat = -1; repeat < 3; repeat += 1) {
      for (const threadCount of (repeat % 2 === 0 ? [...THREAD_COUNTS].reverse() : THREAD_COUNTS)) {
        const directory = mkdtempSync(join(tmpdir(), "synara-engine-measure-"));
        const dbPath = join(directory, "state.sqlite");
        const { engine, runtime } = await createSystem(dbPath);
        try {
          const createdAt = new Date().toISOString();
          const projectId = ProjectId.makeUnsafe("project-perf");
          await runtime.runPromise(
            engine.dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe("cmd-project"),
              projectId,
              title: "Perf",
              workspaceRoot: "/tmp/perf",
              defaultModelSelection: null,
              createdAt,
            }),
          );
          const threadIds = Array.from({ length: threadCount }, (_, index) =>
            ThreadId.makeUnsafe(`thread-${index}`),
          );
          for (const threadId of threadIds) {
            await runtime.runPromise(
              engine.dispatch({
                type: "thread.create",
                commandId: CommandId.makeUnsafe(`cmd-create-${threadId}`),
                threadId,
                projectId,
                title: `Thread ${threadId}`,
                modelSelection: { provider: "codex", model: "gpt-5-codex" },
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                runtimeMode: "full-access",
                branch: null,
                worktreePath: null,
                createdAt,
              }),
            );
          }
          const perThread = repeat < 0 ? 30 : DELTAS_PER_THREAD;
          // Each thread streams one message of `perThread` deltas; threads stream concurrently,
          // each as a sequential producer. This bypasses the shared provider journal pump.
          const dispatchMs: number[] = [];
          let peakRss = process.memoryUsage().rss;
          const streamThread = (threadId: ThreadId, threadIndex: number) =>
            Effect.gen(function* () {
              const messageId = MessageId.makeUnsafe(`msg-${threadIndex}`);
              for (let index = 0; index < perThread; index += 1) {
                const dispatchStarted = performance.now();
                yield* engine.dispatch({
                  type: "thread.message.assistant.delta",
                  commandId: CommandId.makeUnsafe(`cmd-delta-${threadIndex}-${index}`),
                  threadId,
                  messageId,
                  delta: DELTA_TEXT,
                  createdAt: new Date().toISOString(),
                });
                dispatchMs.push(performance.now() - dispatchStarted);
                if (index % 50 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
              }
            });
          const cpuBefore = process.cpuUsage();
          const rssBefore = process.memoryUsage().rss;
          const startedAt = performance.now();
          await runtime.runPromise(
            Effect.all(
              threadIds.map((threadId, index) => streamThread(threadId, index)),
              { concurrency: "unbounded" },
            ),
          );
          const elapsedMs = performance.now() - startedAt;
          const deltas = perThread * threadCount;
          const cpu = process.cpuUsage(cpuBefore);
          dispatchMs.sort((a, b) => a - b);
          if (repeat >= 0) report.push({
            repeat,
            cpuMs: (cpu.user + cpu.system) / 1000,
            rssBefore, peakRss, rssAfter: process.memoryUsage().rss,
            dispatchP95Ms: dispatchMs[Math.floor(dispatchMs.length * 0.95)],
            dispatchMaxMs: dispatchMs.at(-1),
            walBytes: (() => { try { return statSync(dbPath + "-wal").size; } catch { return 0; } })(),
            threads: threadCount,
            deltas,
            elapsedMs: +elapsedMs.toFixed(0),
            msPerDelta: +(elapsedMs / deltas).toFixed(3),
            deltasPerSecond: +((deltas / elapsedMs) * 1000).toFixed(0),
            finalMessageChars: perThread * DELTA_TEXT.length,
          });
          const readModel = await runtime.runPromise(engine.getReadModel());
          expect(readModel.threads).toHaveLength(threadCount);
          for (const thread of readModel.threads) {
            expect(thread.messages[0]?.text).toBe(DELTA_TEXT.repeat(perThread));
          }
        } finally {
          await runtime.dispose();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
    writeFileSync(
      process.env.SYNARA_PERF_OUT ?? "/tmp/synara-perf/engine-report.json",
      JSON.stringify({ deltasPerThread: DELTAS_PER_THREAD, report }, null, 2),
    );
  }, 600_000);
});
