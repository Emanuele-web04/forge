import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "goal_started_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_started_at TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "goal_paused_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_paused_at TEXT
    `;
  }
});
