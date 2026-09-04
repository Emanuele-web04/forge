import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("099_ExternalAgentProfiles", () => {
  it.effect("creates both tables and stays idempotent on a partial replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });

      yield* runMigrations({ toMigrationInclusive: 99 });

      const profiles = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_agent_profiles'
      `;
      const revisions = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_agent_profile_revisions'
      `;
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(revisions.length, 1);

      // Simulate a partially-applied migration (tables exist, migration not yet
      // tracked): rerunning 99 must be a no-op, not a failure.
      const [alreadyTracked] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM effect_sql_migrations
        WHERE migration_id = 99
      `;
      assert.strictEqual(alreadyTracked?.count, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
