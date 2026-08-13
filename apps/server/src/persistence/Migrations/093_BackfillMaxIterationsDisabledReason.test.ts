import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("093_BackfillMaxIterationsDisabledReason", () => {
  it.effect("backfills only active disabled definitions at their iteration cap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 92 });
      yield* sql`
        INSERT INTO automation_definitions (
          automation_id, project_id, name, prompt, schedule_json, enabled,
          model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode,
          max_iterations, stop_on_error, completion_policy_json, completion_policy_version,
          minimum_interval_seconds, retry_policy_json, misfire_policy,
          acknowledged_risks_json, iteration_count, disabled_reason, disabled_at,
          created_at, updated_at, archived_at
        ) VALUES
          (
            'disabled-at-cap', 'project', 'Matching', 'Prompt', '{"type":"manual"}', 0,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 3, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 3, NULL, NULL,
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z', NULL
          ),
          (
            'disabled-with-reason', 'project', 'Reasoned', 'Prompt', '{"type":"manual"}', 0,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 3, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 3, 'user',
            '2026-08-12T10:01:00.000Z',
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:01:00.000Z', NULL
          ),
          (
            'enabled-at-cap', 'project', 'Enabled', 'Prompt', '{"type":"manual"}', 1,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 3, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 3, NULL, NULL,
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z', NULL
          ),
          (
            'disabled-below-cap', 'project', 'Below cap', 'Prompt', '{"type":"manual"}', 0,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 3, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 2, NULL, NULL,
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z', NULL
          ),
          (
            'archived-at-cap', 'project', 'Archived', 'Prompt', '{"type":"manual"}', 0,
            '{"provider":"codex","model":"gpt-5-codex"}', 'approval-required',
            'default', 'auto', 'standalone', 3, 1, '{"type":"none"}', 0,
            60, '{"type":"none"}', 'coalesce', '[]', 3, NULL, NULL,
            '2026-08-12T10:00:00.000Z', '2026-08-12T10:01:00.000Z',
            '2026-08-12T10:01:00.000Z'
          )
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 93 }), [
        [93, "BackfillMaxIterationsDisabledReason"],
      ]);

      const rows = yield* sql<{
        readonly id: string;
        readonly disabledReason: string | null;
        readonly disabledAt: string | null;
      }>`
        SELECT
          automation_id AS id,
          disabled_reason AS "disabledReason",
          disabled_at AS "disabledAt"
        FROM automation_definitions
        ORDER BY automation_id
      `;
      assert.deepStrictEqual(rows, [
        { id: "archived-at-cap", disabledReason: null, disabledAt: null },
        { id: "disabled-at-cap", disabledReason: "max-iterations", disabledAt: null },
        { id: "disabled-below-cap", disabledReason: null, disabledAt: null },
        {
          id: "disabled-with-reason",
          disabledReason: "user",
          disabledAt: "2026-08-12T10:01:00.000Z",
        },
        { id: "enabled-at-cap", disabledReason: null, disabledAt: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
