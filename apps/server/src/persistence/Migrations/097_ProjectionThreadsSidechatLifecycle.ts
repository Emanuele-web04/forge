import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "sidechat_last_activity_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidechat_last_activity_at TEXT
    `;
  }
  if (!(yield* columnExists(sql, "projection_threads", "sidechat_expired_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidechat_expired_at TEXT
    `;
  }
  yield* sql`
    UPDATE projection_threads
    SET sidechat_last_activity_at = COALESCE(sidechat_last_activity_at, updated_at, created_at)
    WHERE sidechat_source_thread_id IS NOT NULL
  `;
});
