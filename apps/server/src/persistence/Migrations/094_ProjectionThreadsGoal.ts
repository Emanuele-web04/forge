import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "goal"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal TEXT
    `;
  }
});
