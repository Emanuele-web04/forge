import { performance } from "node:perf_hooks";

import { EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { THREAD_DETAIL_EVENT_TYPES } from "@synara/shared/threadDetailEvents";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";

import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";

type BenchmarkMode = "global" | "scoped";

interface Sample {
  readonly wallMs: number;
  readonly cpuTotalMs: number;
  readonly maxObservedRssBytes: number;
  readonly rssGrowthBytes: number;
  readonly encodedResponseBytes: number;
  readonly decodedEvents: number;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function modeArgument(): BenchmarkMode {
  const mode = argument("mode") ?? "scoped";
  if (mode !== "global" && mode !== "scoped") {
    throw new Error("--mode must be global or scoped");
  }
  return mode;
}

function forceGc(): void {
  if (typeof Bun.gc === "function") Bun.gc(true);
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summary(values: ReadonlyArray<number>) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    mean: values.reduce((total, value) => total + value, 0) / Math.max(1, values.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

async function run(): Promise<void> {
  const mode = modeArgument();
  const eventCount = positiveInteger("events", 8_000);
  const catchupEventCount = Math.min(positiveInteger("catchup-events", 400), eventCount);
  const threadCount = positiveInteger("threads", 4);
  const catchupBurstsPerSample = positiveInteger("bursts", 40);
  const warmups = positiveInteger("warmups", 1);
  const sampleCount = positiveInteger("samples", 7);
  const runtime = ManagedRuntime.make(
    OrchestrationEventStoreLive.pipe(Layer.provide(SqlitePersistenceMemory)),
  );

  try {
    const eventStore = await runtime.runPromise(Effect.service(OrchestrationEventStore));
    const collectEvents = (
      stream: Stream.Stream<OrchestrationEvent, unknown>,
    ): Promise<ReadonlyArray<OrchestrationEvent>> =>
      runtime.runPromise(
        Stream.runCollect(stream).pipe(Effect.map((events) => Array.from(events))),
      );
    const threadIds = Array.from({ length: threadCount }, (_, index) =>
      ThreadId.makeUnsafe(`benchmark-thread-${index}`),
    );
    const occurredAt = "2026-08-07T00:00:00.000Z";
    for (let index = 0; index < eventCount; index += 1) {
      const threadId = threadIds[index % threadCount]!;
      await runtime.runPromise(
        eventStore.append({
          type: "thread.unarchived",
          eventId: EventId.makeUnsafe(`benchmark-thread-event-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId, updatedAt: occurredAt },
        }),
      );
    }

    const fromSequenceExclusive = eventCount - catchupEventCount;
    const runSample = async (): Promise<Sample> => {
      forceGc();
      const rssBeforeBytes = process.memoryUsage().rss;
      let maxObservedRssBytes = rssBeforeBytes;
      let encodedResponseBytes = 0;
      let decodedEvents = 0;
      const cpuBefore = process.cpuUsage();
      const startedAt = performance.now();
      for (let burst = 0; burst < catchupBurstsPerSample; burst += 1) {
        for (const threadId of threadIds) {
          const events = await collectEvents(
            mode === "global"
              ? eventStore.readFromSequence(fromSequenceExclusive)
              : eventStore.readThreadEventsFromSequence(
                  threadId,
                  fromSequenceExclusive,
                  undefined,
                  undefined,
                  THREAD_DETAIL_EVENT_TYPES,
                ),
          );
          decodedEvents += events.length;
          encodedResponseBytes += Buffer.byteLength(JSON.stringify(events));
        }
        maxObservedRssBytes = Math.max(maxObservedRssBytes, process.memoryUsage().rss);
      }
      const cpu = process.cpuUsage(cpuBefore);
      return {
        wallMs: performance.now() - startedAt,
        cpuTotalMs: (cpu.user + cpu.system) / 1_000,
        maxObservedRssBytes,
        rssGrowthBytes: Math.max(0, maxObservedRssBytes - rssBeforeBytes),
        encodedResponseBytes,
        decodedEvents,
      };
    };

    for (let index = 0; index < warmups; index += 1) await runSample();
    const samples: Sample[] = [];
    for (let index = 0; index < sampleCount; index += 1) samples.push(await runSample());

    process.stdout.write(
      `${JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
          workload: {
            mode,
            eventCount,
            catchupEventCount,
            threadCount,
            catchupBurstsPerSample,
            warmups,
            samples: sampleCount,
            persistence: "SQLite in-memory with production migrations and event decoding",
            responseWork: "JSON encode every visible thread response in repeated catch-up bursts",
          },
          summary: {
            wallMs: summary(samples.map((sample) => sample.wallMs)),
            cpuTotalMs: summary(samples.map((sample) => sample.cpuTotalMs)),
            maxObservedRssBytes: summary(samples.map((sample) => sample.maxObservedRssBytes)),
            rssGrowthBytes: summary(samples.map((sample) => sample.rssGrowthBytes)),
            encodedResponseBytes: summary(samples.map((sample) => sample.encodedResponseBytes)),
            decodedEvents: summary(samples.map((sample) => sample.decodedEvents)),
          },
          samples,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await runtime.dispose();
  }
}

await run();
