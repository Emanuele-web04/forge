import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  const existing = new Set(columns.map(({ name }) => name));

  if (!existing.has("race_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN race_id TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_race_id
    ON projection_threads (race_id)
  `;
});
