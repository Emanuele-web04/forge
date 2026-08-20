import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("091_AutomationFailureTolerance", () => {
  it.effect("backfills legacy stop-on-error values into failure thresholds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode,
          stop_on_error, completion_policy_json, completion_policy_version,
          minimum_interval_seconds, retry_policy_json, misfire_policy,
          acknowledged_risks_json, iteration_count, created_at, updated_at
        ) VALUES
          (
            'legacy-stop', 'project', 'Stop', 'Prompt', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 0,
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z'
          ),
          (
            'legacy-continue', 'project', 'Continue', 'Prompt', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 0, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 0,
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 91 });

      const rows = yield* sql<{
        readonly id: string;
        readonly threshold: number | null;
        readonly failureCount: number;
        readonly disabledReason: string | null;
        readonly disabledAt: string | null;
      }>`
        SELECT
          automation_id AS id,
          stop_after_consecutive_failures AS threshold,
          consecutive_failure_count AS "failureCount",
          disabled_reason AS "disabledReason",
          disabled_at AS "disabledAt"
        FROM automation_definitions
        ORDER BY automation_id
      `;

      assert.deepStrictEqual(rows, [
        {
          id: "legacy-continue",
          threshold: null,
          failureCount: 0,
          disabledReason: null,
          disabledAt: null,
        },
        {
          id: "legacy-stop",
          threshold: 3,
          failureCount: 0,
          disabledReason: null,
          disabledAt: null,
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
