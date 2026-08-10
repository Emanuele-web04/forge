import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "provider_session_runtime", "provider_profile_id"))) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN provider_profile_id TEXT NOT NULL DEFAULT 'default'
    `;
  }
});
