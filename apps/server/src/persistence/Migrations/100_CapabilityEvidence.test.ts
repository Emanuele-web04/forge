// FILE: 100_CapabilityEvidence.test.ts
// Purpose: Proves migration 100 creates an append-only capability observations
// store and is idempotent across replays (MigrationReplay re-runs every
// migration at or after id 54 over its own post-state).
// Layer: SQLite migration test

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("100_CapabilityEvidence", () => {
  it.effect("creates the capability_observations table and its index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 100 }), [
        [100, "CapabilityEvidence"],
      ]);

      const [table] = yield* sql<{ readonly exists: number }>`
        SELECT EXISTS(
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_observations'
        ) AS "exists"
      `;
      assert.strictEqual(table?.exists, 1);

      const [index] = yield* sql<{ readonly exists: number }>`
        SELECT EXISTS(
          SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'capability_observations_namespace_idx'
        ) AS "exists"
      `;
      assert.strictEqual(index?.exists, 1);

      // The store is append-only: no PITR-style columns that could be targeted
      // by an upsert-like backfill, only identity + payload + tombstone-free rows.
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('capability_observations') ORDER BY name
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "attribution",
          "capability_id",
          "created_at",
          "namespace",
          "observation_id",
          "observed_at",
          "outcome",
          "policy_json",
          "run_metadata_json",
          "runtime_identity_json",
          "source",
          "verifier_json",
        ],
      );

      const [effectiveTable] = yield* sql<{ readonly exists: number }>`
        SELECT EXISTS(
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_effective_states'
        ) AS "exists"
      `;
      assert.strictEqual(effectiveTable?.exists, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("is idempotent when re-run over its own post-state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 100 }), []);

      const [table] = yield* sql<{ readonly exists: number }>`
        SELECT EXISTS(
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_observations'
        ) AS "exists"
      `;
      assert.strictEqual(table?.exists, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
