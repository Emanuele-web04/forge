import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("094_ProjectionThreadsGoal", () => {
  it.effect("adds goal and safely accepts a pre-existing column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal TEXT`;

      yield* runMigrations({ toMigrationInclusive: 94 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      assert.strictEqual(columns.filter((column) => column.name === "goal").length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
