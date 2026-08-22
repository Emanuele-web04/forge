import { performance } from "node:perf_hooks";

import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ProviderRuntimeEventRepositoryLive } from "../src/persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderRuntimeEventRepository } from "../src/persistence/Services/ProviderRuntimeEvents.ts";

type BenchmarkMode = "once" | "duplicate";

interface Sample {
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly cpuTotalMs: number;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
  readonly maxObservedRssBytes: number;
  readonly heapUsedBeforeBytes: number;
  readonly heapUsedAfterBytes: number;
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
  const mode = argument("mode") ?? "once";
  if (mode !== "once" && mode !== "duplicate") {
    throw new Error("--mode must be once or duplicate");
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
  const mean = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function runtimeEvent(index: number, threadCount: number): ProviderRuntimeEvent {
  const threadIndex = index % threadCount;
  return {
    type: "content.delta",
    eventId: EventId.makeUnsafe(`benchmark-event-${index}`),
    provider: "codex",
    createdAt: "2026-08-07T00:00:00.000Z",
    threadId: ThreadId.makeUnsafe(`benchmark-thread-${threadIndex}`),
    turnId: TurnId.makeUnsafe(`benchmark-turn-${threadIndex}`),
    payload: {
      streamKind: "assistant_text",
      delta: `provider-neutral streamed text ${index.toString().padStart(8, "0")}\n`,
    },
  };
}

async function runSample(input: {
  readonly mode: BenchmarkMode;
  readonly eventCount: number;
  readonly threadCount: number;
}): Promise<Sample> {
  const runtime = ManagedRuntime.make(
    ProviderRuntimeEventRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
  );
  try {
    const repository = await runtime.runPromise(Effect.service(ProviderRuntimeEventRepository));
    forceGc();
    const before = process.memoryUsage();
    let maxObservedRssBytes = before.rss;
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();

    for (let index = 0; index < input.eventCount; index += 1) {
      const event = runtimeEvent(index, input.threadCount);
      await runtime.runPromise(repository.append(event));
      if (input.mode === "duplicate") {
        await runtime.runPromise(repository.append(event));
      }
      if ((index & 127) === 0) {
        maxObservedRssBytes = Math.max(maxObservedRssBytes, process.memoryUsage().rss);
      }
    }

    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    const after = process.memoryUsage();
    maxObservedRssBytes = Math.max(maxObservedRssBytes, after.rss);
    return {
      wallMs,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      cpuTotalMs: (cpu.user + cpu.system) / 1_000,
      rssBeforeBytes: before.rss,
      rssAfterBytes: after.rss,
      maxObservedRssBytes,
      heapUsedBeforeBytes: before.heapUsed,
      heapUsedAfterBytes: after.heapUsed,
    };
  } finally {
    await runtime.dispose();
  }
}

async function run(): Promise<void> {
  const mode = modeArgument();
  const eventCount = positiveInteger("events", 2_000);
  const threadCount = positiveInteger("threads", 4);
  const warmups = positiveInteger("warmups", 1);
  const sampleCount = positiveInteger("samples", 5);

  for (let index = 0; index < warmups; index += 1) {
    await runSample({ mode, eventCount, threadCount });
  }

  const samples: Sample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await runSample({ mode, eventCount, threadCount }));
  }

  const wall = summary(samples.map((sample) => sample.wallMs));
  const cpu = summary(samples.map((sample) => sample.cpuTotalMs));
  const maxRss = summary(samples.map((sample) => sample.maxObservedRssBytes));
  const result = {
    createdAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    workload: {
      mode,
      eventCount,
      threadCount,
      warmups,
      samples: sampleCount,
      payload: "provider-neutral assistant text delta",
      persistence: "SQLite in-memory with production migrations and repository",
    },
    summary: {
      wallMs: wall,
      cpuTotalMs: cpu,
      maxObservedRssBytes: maxRss,
      eventsPerWallSecondAtP50: wall.p50 === 0 ? 0 : (eventCount * 1_000) / wall.p50,
      eventsPerCpuSecondAtP50: cpu.p50 === 0 ? 0 : (eventCount * 1_000) / cpu.p50,
    },
    samples,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await run();
