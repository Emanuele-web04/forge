import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS outbound_mcp_connections (
      connection_id TEXT PRIMARY KEY NOT NULL,
      preset_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL,
      error_category TEXT,
      catalog_fingerprint TEXT,
      last_validated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;
});
