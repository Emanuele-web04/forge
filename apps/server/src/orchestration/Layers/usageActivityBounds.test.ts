import { EventId, ThreadId, TurnId, type OrchestrationEvent } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { projectEvent } from "../projector.ts";

it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)("accounting activity bounds", (it) => {
  it.effect(
    "keeps 3000 accounting turns durable while snapshots and the projector remain capped",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at)
      VALUES('accounting-project','Accounting','/tmp/accounting','{"provider":"codex","model":"gpt-5-codex"}','[]','2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z',NULL)`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,branch,worktree_path,latest_turn_id,created_at,updated_at,deleted_at)
      VALUES('accounting-thread','accounting-project','Accounting','{"provider":"codex","model":"gpt-5-codex"}',NULL,NULL,NULL,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z',NULL)`;
        yield* sql`INSERT INTO projection_thread_activities(activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<6000)
      SELECT 'activity-'||i,'accounting-thread','turn-'||((i+1)/2),'info',CASE WHEN i%2=0 THEN 'turn.completed' ELSE 'context-window.updated' END,'Accounting',CASE WHEN i%2=0 THEN '{"totalCostUsd":1}' ELSE '{"usedTokens":10}' END,i,'2026-09-08T00:00:00.000Z' FROM n`;
        const snapshot = yield* query.getSnapshot();
        const detail = yield* query.getThreadDetailById(ThreadId.makeUnsafe("accounting-thread"));
        assert.isTrue(Option.isSome(detail));
        const rows = Array.from({ length: 6000 }, (_, i) => ({
          id: EventId.makeUnsafe("activity-" + (i + 1)),
          turnId: TurnId.makeUnsafe("turn-" + Math.floor((i + 2) / 2)),
          tone: "info" as const,
          kind: i % 2 === 0 ? "context-window.updated" : "turn.completed",
          summary: "Accounting",
          payload: {},
          sequence: i + 1,
          createdAt: "2026-09-08T00:00:00.000Z",
        }));
        const tool = {
          ...rows[0]!,
          id: EventId.makeUnsafe("tool-new"),
          turnId: TurnId.makeUnsafe("new-turn"),
          kind: "tool.completed",
          sequence: 6001,
        };
        const seed = {
          ...snapshot,
          threads: snapshot.threads.map((t) => ({ ...t, activities: rows })),
        };
        const projected = yield* projectEvent(seed, {
          sequence: 6001,
          eventId: EventId.makeUnsafe("domain-new"),
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("accounting-thread"),
          occurredAt: "2026-09-08T00:00:01.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId: ThreadId.makeUnsafe("accounting-thread"), activity: tool },
        } as OrchestrationEvent);
        const counts = {
          bulk: snapshot.threads[0]!.activities.length,
          detail: Option.isSome(detail) ? detail.value.activities.length : 0,
          projector: projected.threads[0]!.activities.length,
        };
        assert.deepEqual(counts, { bulk: 500, detail: 2000, projector: 500 });
        const durable = yield* sql<{
          count: number;
          cost: number;
        }>`SELECT COUNT(*) AS count, SUM(json_extract(payload_json, '$.totalCostUsd')) AS cost FROM projection_thread_activities WHERE thread_id = 'accounting-thread'`;
        assert.equal(durable[0]?.count, 6000);
        assert.equal(durable[0]?.cost, 3000);
      }),
  );
});
