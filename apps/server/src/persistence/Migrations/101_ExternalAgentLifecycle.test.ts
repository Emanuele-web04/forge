// FILE: 101_ExternalAgentLifecycle.test.ts
// Purpose: Proves migration 101 adds the lifecycle/trust/attribution columns and
// normalizes legacy `tombstoned` rows (KAR-522) to `retired` so the tight
// AgentProfileStatus contract keeps decoding after the migration.
// Layer: SQLite migration test

import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { AgentProfile as AgentProfileSchema } from "@synara/contracts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("101_ExternalAgentLifecycle", () => {
  it.effect("adds the lifecycle, trust, and turn-attribution columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 101 }), [
        [101, "ExternalAgentLifecycle"],
      ]);

      const profileColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('external_agent_profiles') ORDER BY name
      `;
      assert.deepStrictEqual(
        profileColumns.map((column) => column.name),
        [
          "created_at",
          "current_revision_id",
          "lifecycle_event_json",
          "name",
          "profile_id",
          "status",
          "trust_json",
          "updated_at",
        ],
      );

      const turnColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_turns') ORDER BY name
      `;
      assert.include(
        turnColumns.map((column) => column.name),
        "external_agent_revision_id",
      );
      assert.include(
        turnColumns.map((column) => column.name),
        "spawning_profile_id",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("normalizes legacy tombstoned rows to retired", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });

      // KAR-522 wrote `status = 'tombstoned'`, which no longer decodes after
      // the AgentProfileStatus contract narrowed to active/quarantined/retired.
      yield* sql`
        INSERT INTO external_agent_profiles (
          profile_id, name, current_revision_id, status, created_at, updated_at
        ) VALUES (
          'agentprofile_legacy-tombstoned', 'Legacy Tombstoned', 'rev_legacy',
          'tombstoned', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 101 });

      const rows = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM external_agent_profiles
        WHERE profile_id = 'agentprofile_legacy-tombstoned'
      `;
      assert.deepStrictEqual(rows, [{ status: "retired" }]);

      // Idempotent: a replay over the normalized state changes nothing.
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 101 }), []);
      const replayRows = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM external_agent_profiles
        WHERE profile_id = 'agentprofile_legacy-tombstoned'
      `;
      assert.deepStrictEqual(replayRows, [{ status: "retired" }]);

      // The normalized row decodes against the tight AgentProfileStatus
      // contract (a leftover tombstoned value would throw here), and a
      // tombstoned value no longer decodes at all.
      const baseRow = {
        profileId: "agentprofile_legacy-tombstoned",
        name: "Legacy Tombstoned",
        currentRevisionId: "rev_legacy",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      assert.doesNotThrow(() =>
        Schema.decodeUnknownSync(AgentProfileSchema)({ ...baseRow, status: "retired" }),
      );
      assert.throws(() =>
        Schema.decodeUnknownSync(AgentProfileSchema)({ ...baseRow, status: "tombstoned" }),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("leaves non-tombstoned rows untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });

      yield* sql`
        INSERT INTO external_agent_profiles (
          profile_id, name, current_revision_id, status, created_at, updated_at
        ) VALUES (
          'agentprofile_legacy-active', 'Legacy Active', 'rev_legacy-active',
          'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 101 });

      const rows = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM external_agent_profiles
        WHERE profile_id = 'agentprofile_legacy-active'
      `;
      assert.deepStrictEqual(rows, [{ status: "active" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
