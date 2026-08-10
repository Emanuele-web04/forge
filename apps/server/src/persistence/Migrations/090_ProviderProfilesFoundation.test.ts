import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("090_ProviderProfilesFoundation", (it) => {
  it.effect("backfills the default profile on existing provider bindings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          lifecycle_generation,
          last_seen_at
        ) VALUES (
          'thread-legacy-profile',
          'codex',
          'codex',
          'full-access',
          'stopped',
          'legacy-profile-generation',
          '2026-08-10T00:00:00.000Z'
        )
      `;
      assert.deepStrictEqual(yield* runMigrations(), [[90, "ProviderProfilesFoundation"]]);

      const runtimeRows = yield* sql<{ readonly profileId: string }>`
        SELECT provider_profile_id AS "profileId"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-legacy-profile'
      `;
      assert.deepStrictEqual(runtimeRows, [{ profileId: "default" }]);
    }),
  );
});
