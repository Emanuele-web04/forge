import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("100_ThreadTitleRefresh", () => {
  it.effect("adds title-refresh columns with safe defaults and stays idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      assert.isFalse(before.some((column) => column.name === "manual_title_pinned"));

      yield* runMigrations({ toMigrationInclusive: 100 });

      const afterThreads = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      for (const column of ["manual_title_pinned", "title_refresh_mode", "pending_suggested_title"]) {
        assert.isTrue(
          afterThreads.some((entry) => entry.name === column),
          `missing projection_threads.${column}`,
        );
      }

      const afterProjects = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      assert.isTrue(afterProjects.some((entry) => entry.name === "title_refresh_mode"));

      // Rerun must stay safe (columnExists guards).
      yield* runMigrations({ toMigrationInclusive: 100 });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
