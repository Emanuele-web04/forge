import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadDiagnosticsQuery } from "../Services/ThreadDiagnosticsQuery.ts";
import { ThreadDiagnosticsQueryLive } from "./ThreadDiagnosticsQuery.ts";

const layer = it.layer(
  ThreadDiagnosticsQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ThreadDiagnosticsQuery", (it) => {
  it.effect("pages filtered activity at a captured high-water sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const diagnostics = yield* ThreadDiagnosticsQuery;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('activity-1', 'thread-1', 'turn-1', 'info', 'tool', 'first', '{"value":1}', 10, '2026-07-20T10:00:00.000Z'),
          ('activity-2', 'thread-1', 'turn-1', 'info', 'message', 'second', '{"value":2}', 11, '2026-07-20T10:00:01.000Z'),
          ('activity-3', 'thread-1', 'turn-2', 'error', 'tool', 'third', '{"value":3}', 12, '2026-07-20T10:00:02.000Z')
      `;

      assert.deepEqual(yield* diagnostics.getActivityCoverage("thread-1"), {
        highWaterSequence: 12,
        unsequencedCount: 0,
      });
      const page = yield* diagnostics.listActivities({
        threadId: "thread-1",
        throughSequenceInclusive: 12,
        beforeSequenceExclusive: 12,
        turnId: "turn-1",
        kinds: ["tool"],
        limit: 10,
      });
      assert.deepEqual(
        page.map((row) => row.sequence),
        [10],
      );
      assert.deepEqual(page[0]?.payload, { value: 1 });
    }),
  );

  it.effect("stores bounded structured incidents and reads only the requested thread", () =>
    Effect.gen(function* () {
      const diagnostics = yield* ThreadDiagnosticsQuery;
      const recentOccurredAt = new Date(Date.now() - 60_000).toISOString();
      yield* diagnostics.recordOperationalDiagnostic({
        threadId: "thread-1",
        source: "server",
        kind: "ws.stream-admission-rejected",
        severity: "warning",
        code: "THREAD_STREAM_CAPACITY_EXCEEDED",
        detail: { reason: "thread-capacity", activeThreads: 16 },
        occurredAt: recentOccurredAt,
      });
      yield* diagnostics.recordOperationalDiagnostic({
        threadId: "thread-2",
        source: "server",
        kind: "ws.stream-admission-rejected",
        severity: "warning",
        detail: { reason: "duplicate" },
        occurredAt: recentOccurredAt,
      });

      const incidents = yield* diagnostics.listOperationalDiagnostics({
        threadId: "thread-1",
        limit: 10,
      });
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0]?.code, "THREAD_STREAM_CAPACITY_EXCEEDED");
      assert.deepEqual(incidents[0]?.detail, { reason: "thread-capacity", activeThreads: 16 });
    }),
  );
});
