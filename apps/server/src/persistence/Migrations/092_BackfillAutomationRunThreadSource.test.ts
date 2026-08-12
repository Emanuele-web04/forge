import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("092_BackfillAutomationRunThreadSource", () => {
  it.effect("marks only standalone run threads, in both the event log and the projection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });

      const runThreadId = "automation:automation-run:legacy-run:thread";
      const dedicatedThreadId = "automation:automation-run:dedicated-home:thread";
      const normalThreadId = "normal-thread";

      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'project', 'Project', '/workspace/project', '[]',
          '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
        )
      `;
      // A dedicated automation still references its home thread; that thread is a
      // persistent conversation and must survive the backfill unmarked.
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode,
          target_thread_id, stop_on_error, completion_policy_json, completion_policy_version,
          minimum_interval_seconds, retry_policy_json, misfire_policy,
          acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES
          (
            'dedicated-automation', 'project-1', 'Dedicated', 'Prompt', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'dedicated', ${dedicatedThreadId}, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 0,
            '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
          ),
          (
            'null-target-automation', 'project-1', 'Null target', 'Prompt',
            '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', NULL, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 0,
            '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at,
          runtime_mode, interaction_mode, env_mode
        ) VALUES
          (
            ${runThreadId}, 'project-1', 'Run',
            '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
            'full-access', 'default', 'local'
          ),
          (
            ${dedicatedThreadId}, 'project-1', 'Dedicated home',
            '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
            'full-access', 'default', 'local'
          ),
          (
            ${normalThreadId}, 'project-1', 'Normal',
            '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z',
            'full-access', 'default', 'local'
          )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-run', 'thread', ${runThreadId}, 1, 'thread.created',
            '2026-08-01T10:00:00.000Z', 'command-run', 'server',
            ${`{"threadId":"${runThreadId}","title":"Run"}`}, '{}'
          ),
          (
            'event-dedicated', 'thread', ${dedicatedThreadId}, 1, 'thread.created',
            '2026-08-01T10:00:00.000Z', 'command-dedicated', 'server',
            ${`{"threadId":"${dedicatedThreadId}","title":"Dedicated home"}`}, '{}'
          ),
          (
            'event-normal', 'thread', ${normalThreadId}, 1, 'thread.created',
            '2026-08-01T10:00:00.000Z', 'command-normal', 'client',
            ${`{"threadId":"${normalThreadId}","title":"Normal","creationSource":"synara_mcp"}`}, '{}'
          )
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 92 }), [
        [92, "BackfillAutomationRunThreadSource"],
      ]);

      const threads = yield* sql<{
        readonly threadId: string;
        readonly creationSource: string | null;
      }>`
        SELECT thread_id AS "threadId", creation_source AS "creationSource"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(threads, [
        { threadId: dedicatedThreadId, creationSource: null },
        { threadId: runThreadId, creationSource: "automation_run" },
        { threadId: normalThreadId, creationSource: null },
      ]);

      const events = yield* sql<{
        readonly eventId: string;
        readonly payloadJson: string;
      }>`
        SELECT event_id AS "eventId", payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY event_id
      `;
      assert.deepStrictEqual(
        events.map((event) => ({
          eventId: event.eventId,
          creationSource: (JSON.parse(event.payloadJson) as { creationSource?: string })
            .creationSource,
        })),
        [
          { eventId: "event-dedicated", creationSource: undefined },
          { eventId: "event-normal", creationSource: "synara_mcp" },
          { eventId: "event-run", creationSource: "automation_run" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
