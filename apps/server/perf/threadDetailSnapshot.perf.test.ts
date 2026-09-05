// Perf probe: cost of the per-thread detail snapshot RPC and the replay poll against a
// copy of a real Synara database. Run with:
//   SYNARA_PERF_DB=/tmp/synara-perf/state.copy.sqlite bunx vitest run perf/threadDetailSnapshot.perf.test.ts
import { writeFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";
import { ThreadId } from "@synara/contracts";
import { THREAD_DETAIL_EVENT_TYPES } from "@synara/shared/threadDetailEvents";

import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";

const DB = process.env.SYNARA_PERF_DB;
const SAMPLES = Number(process.env.SYNARA_PERF_SAMPLES ?? 5);

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

describe.skipIf(!DB)("thread detail snapshot perf", () => {
  const layer = Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive,
    OrchestrationEventStoreLive,
  ).pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(DB!)),
    Layer.provideMerge(NodeServices.layer),
  );

  it.effect(
    "measures snapshot + replay cost for p50/p90/max threads",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        const eventStore = yield* OrchestrationEventStore;
        const rows = yield* sql<{ thread_id: string; kb: number }>`
          WITH s AS (
            SELECT t.thread_id, (COALESCE(m.b,0)+COALESCE(a.b,0))/1024 AS kb
            FROM projection_threads t
            LEFT JOIN (SELECT thread_id, sum(length(text)) b FROM projection_thread_messages GROUP BY thread_id) m ON m.thread_id=t.thread_id
            LEFT JOIN (SELECT thread_id, sum(length(payload_json)) b FROM projection_thread_activities GROUP BY thread_id) a ON a.thread_id=t.thread_id
            WHERE t.deleted_at IS NULL)
          SELECT thread_id, kb FROM s ORDER BY kb`;
        const pick = (p: number) => rows[Math.min(rows.length - 1, Math.floor(rows.length * p))]!;
        const targets = [
          ["p50", pick(0.5)],
          ["p90", pick(0.9)],
          ["max", rows[rows.length - 1]!],
        ] as const;
        const highWater = yield* eventStore.getHighWaterSequence();
        const report: Record<string, unknown>[] = [];
        for (const [label, row] of targets) {
          const threadId = ThreadId.makeUnsafe(row.thread_id);
          const snapshotMs: number[] = [];
          const stringifyMs: number[] = [];
          let bytes = 0;
          let messages = 0;
          let activities = 0;
          for (let i = 0; i < SAMPLES; i += 1) {
            const t0 = performance.now();
            const snapshot = yield* query.getThreadDetailSnapshotById(threadId);
            const t1 = performance.now();
            snapshotMs.push(t1 - t0);
            if (Option.isSome(snapshot)) {
              const json = JSON.stringify(snapshot.value);
              stringifyMs.push(performance.now() - t1);
              bytes = json.length;
              if (i === 0) writeFileSync(`/tmp/synara-perf/snapshot-${label}.json`, json);
              messages = snapshot.value.thread.messages.length;
              activities = snapshot.value.thread.activities.length;
            }
          }
          // Replay poll: the client asks for thread events after its cursor; steady state = empty.
          const replayMs: number[] = [];
          for (let i = 0; i < SAMPLES; i += 1) {
            const t0 = performance.now();
            yield* Stream.runCollect(
              eventStore.readThreadEventsFromSequence(
                threadId,
                highWater - 50,
                4096,
                Number.MAX_SAFE_INTEGER,
                [...THREAD_DETAIL_EVENT_TYPES],
              ),
            );
            replayMs.push(performance.now() - t0);
          }
          report.push({
            label,
            threadId: row.thread_id,
            kbOnDisk: row.kb,
            messages,
            activities,
            jsonKB: Math.round(bytes / 1024),
            snapshotP50Ms: +percentile(snapshotMs, 0.5).toFixed(1),
            snapshotMaxMs: +Math.max(...snapshotMs).toFixed(1),
            stringifyP50Ms: +percentile(stringifyMs, 0.5).toFixed(1),
            replayP50Ms: +percentile(replayMs, 0.5).toFixed(2),
          });
        }
        writeFileSync(
          process.env.SYNARA_PERF_OUT ?? "/tmp/synara-perf/snapshot-report.json",
          JSON.stringify({ threads: rows.length, highWater, samples: SAMPLES, report }, null, 2),
        );
      }).pipe(Effect.provide(layer)),
    { timeout: 300_000 },
  );
});
