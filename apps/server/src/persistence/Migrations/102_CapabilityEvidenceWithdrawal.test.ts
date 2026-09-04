// FILE: 102_CapabilityEvidenceWithdrawal.test.ts
// Purpose: Proves migration 102 adds the `withdrawn_at` marker column to the
// append-only capability observations store (KAR-530). Observations are never
// rewritten: unsafe-outcome demotion marks prior rows withdrawn so policy
// derivation excludes them while the raw history stays intact for audit.
// Layer: SQLite migration test

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("102_CapabilityEvidenceWithdrawal", () => {
  it.effect("adds the withdrawn_at marker column for evidence withdrawal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 101 });

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 102 }), [
        [102, "CapabilityEvidenceWithdrawal"],
      ]);

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('capability_observations') ORDER BY name
      `;
      assert.include(
        columns.map((column) => column.name),
        "withdrawn_at",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("is idempotent when re-run over its own post-state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 102 });

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 102 }), []);

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('capability_observations') ORDER BY name
      `;
      assert.include(
        columns.map((column) => column.name),
        "withdrawn_at",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
