import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "manual_title_pinned"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN manual_title_pinned INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!(yield* columnExists(sql, "projection_threads", "title_refresh_mode"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_refresh_mode TEXT
    `;
  }
  if (!(yield* columnExists(sql, "projection_threads", "pending_suggested_title"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_suggested_title TEXT
    `;
  }
  if (!(yield* columnExists(sql, "projection_projects", "title_refresh_mode"))) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN title_refresh_mode TEXT
    `;
  }
});
