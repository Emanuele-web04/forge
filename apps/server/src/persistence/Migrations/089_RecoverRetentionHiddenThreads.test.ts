import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("089_RecoverRetentionHiddenThreads", (it) => {
  it.effect("moves only retention-deleted threads into the restorable archive", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'project', 'Project', '/workspace/project', '[]',
          '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, deleted_at,
          runtime_mode, interaction_mode, env_mode
        ) VALUES
          (
            'retained-thread', 'project-1', 'Retained',
            '2026-07-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z',
            '2026-08-01T11:00:00.000Z', 'full-access', 'default', 'local'
          ),
          (
            'manual-thread', 'project-1', 'Manual',
            '2026-07-01T10:00:00.000Z', '2026-08-01T12:00:00.000Z',
            '2026-08-01T12:00:00.000Z', 'full-access', 'default', 'local'
          )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-retention', 'thread', 'retained-thread', 1, 'thread.deleted',
            '2026-08-01T11:00:00.000Z', 'thread-retention:test', 'server',
            '{"threadId":"retained-thread","deletedAt":"2026-08-01T11:00:00.000Z"}', '{}'
          ),
          (
            'event-manual', 'thread', 'manual-thread', 1, 'thread.deleted',
            '2026-08-01T12:00:00.000Z', 'manual-delete', 'client',
            '{"threadId":"manual-thread","deletedAt":"2026-08-01T12:00:00.000Z"}', '{}'
          )
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 89 }), [
        [89, "RecoverRetentionHiddenThreads"],
      ]);

      const threads = yield* sql<{
        readonly threadId: string;
        readonly archivedAt: string | null;
        readonly deletedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(threads, [
        {
          threadId: "manual-thread",
          archivedAt: null,
          deletedAt: "2026-08-01T12:00:00.000Z",
        },
        {
          threadId: "retained-thread",
          archivedAt: "2026-08-01T11:00:00.000Z",
          deletedAt: null,
        },
      ]);

      const events = yield* sql<{
        readonly commandId: string | null;
        readonly eventType: string;
        readonly payloadJson: string;
      }>`
        SELECT
          command_id AS "commandId",
          event_type AS "eventType",
          payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY event_id
      `;
      assert.deepStrictEqual(
        events.map((event) => ({
          commandId: event.commandId,
          eventType: event.eventType,
          payload: JSON.parse(event.payloadJson),
        })),
        [
          {
            commandId: "manual-delete",
            eventType: "thread.deleted",
            payload: {
              threadId: "manual-thread",
              deletedAt: "2026-08-01T12:00:00.000Z",
            },
          },
          {
            commandId: "thread-retention:test",
            eventType: "thread.archived",
            payload: {
              threadId: "retained-thread",
              archivedAt: "2026-08-01T11:00:00.000Z",
              updatedAt: "2026-08-01T11:00:00.000Z",
            },
          },
        ],
      );
    }),
  );
});
