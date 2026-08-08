import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const EVENT_COUNT = readPositiveInteger("SYNARA_BENCH_EVENTS", 10_000);
const SAMPLE_COUNT = readPositiveInteger("SYNARA_BENCH_SAMPLES", 8);

type Strategy = "legacy-select-transaction-insert" | "insert-on-conflict-returning";
type AppendRuntimeEvent = (params: Record<string, string>) => unknown;
type Workload = {
  readonly name: "unique-events" | "ten-percent-retries";
  readonly sourceEventIndex: (attemptIndex: number) => number;
};

const STRATEGIES: readonly Strategy[] = [
  "legacy-select-transaction-insert",
  "insert-on-conflict-returning",
];

const WORKLOADS: readonly Workload[] = [
  {
    name: "unique-events",
    sourceEventIndex: (attemptIndex) => attemptIndex,
  },
  {
    name: "ten-percent-retries",
    sourceEventIndex: (attemptIndex) =>
      attemptIndex > 0 && attemptIndex % 10 === 0 ? attemptIndex - 1 : attemptIndex,
  },
];

function readPositiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function createDatabase(): { readonly database: Database; readonly dispose: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-journal-bench-"));
  const database = new Database(path.join(directory, "runtime.sqlite"), { strict: true });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE provider_runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      persisted_at TEXT NOT NULL
    )
  `);
  return {
    database,
    dispose: () => {
      database.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

function eventParams(sourceEventIndex: number): Record<string, string> {
  const eventId = `event-${sourceEventIndex}`;
  return {
    eventId,
    threadId: `thread-${sourceEventIndex % 3}`,
    eventType: "content.delta",
    eventJson: JSON.stringify({
      eventId,
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: `token-${sourceEventIndex}` },
    }),
    persistedAt: "2026-08-09T00:00:00.000Z",
  };
}

function createAppendRuntimeEvent(database: Database, strategy: Strategy): AppendRuntimeEvent {
  const lookup = database.query(
    `SELECT sequence, event_json AS eventJson
     FROM provider_runtime_events
     WHERE event_id = $eventId`,
  );
  const insert = database.query(
    `INSERT INTO provider_runtime_events (
       event_id, thread_id, event_type, event_json, persisted_at
     ) VALUES ($eventId, $threadId, $eventType, $eventJson, $persistedAt)
     RETURNING sequence, event_json AS eventJson`,
  );
  const insertOnConflict = database.query(
    `INSERT INTO provider_runtime_events (
       event_id, thread_id, event_type, event_json, persisted_at
     ) VALUES ($eventId, $threadId, $eventType, $eventJson, $persistedAt)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING sequence, event_json AS eventJson`,
  );
  const legacyAppend = database.transaction((params: Record<string, string>) => {
    const existing = lookup.get(params);
    return existing ?? insert.get(params);
  });
  if (strategy === "legacy-select-transaction-insert") return legacyAppend;
  return (params) => insertOnConflict.get(params) ?? lookup.get(params);
}

function appendWorkload(
  appendRuntimeEvent: AppendRuntimeEvent,
  workload: Workload,
  eventCount: number,
): number {
  const startedAt = performance.now();
  for (let attemptIndex = 0; attemptIndex < eventCount; attemptIndex += 1) {
    appendRuntimeEvent(eventParams(workload.sourceEventIndex(attemptIndex)));
  }
  return performance.now() - startedAt;
}

function runSample(strategy: Strategy, workload: Workload, eventCount: number): number {
  const { database, dispose } = createDatabase();
  try {
    return appendWorkload(createAppendRuntimeEvent(database, strategy), workload, eventCount);
  } finally {
    dispose();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function strategyOrder(sampleIndex: number): readonly Strategy[] {
  return sampleIndex % 2 === 0 ? STRATEGIES : [...STRATEGIES].reverse();
}

function measureWorkload(workload: Workload) {
  const samplesByStrategy = new Map<Strategy, number[]>(
    STRATEGIES.map((strategy) => [strategy, []]),
  );
  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    for (const strategy of strategyOrder(sampleIndex)) {
      samplesByStrategy.get(strategy)!.push(runSample(strategy, workload, EVENT_COUNT));
    }
  }
  return {
    workload: workload.name,
    results: STRATEGIES.map((strategy) => {
      const samplesMs = samplesByStrategy.get(strategy)!;
      const medianMs = median(samplesMs);
      return {
        strategy,
        eventCount: EVENT_COUNT,
        samplesMs,
        medianMs,
        attemptsPerSecond: EVENT_COUNT / (medianMs / 1_000),
      };
    }),
  };
}

for (const workload of WORKLOADS) {
  for (const strategy of STRATEGIES) {
    runSample(strategy, workload, Math.min(1_000, EVENT_COUNT));
  }
}

console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      storage: "file-backed SQLite, WAL, synchronous=NORMAL",
      sampleCount: SAMPLE_COUNT,
      workloads: WORKLOADS.map(measureWorkload),
    },
    null,
    2,
  ),
);
