import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const memoryColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('mind_memories')
  `;
  if (!memoryColumns.some(({ name }) => name === "provenance_kind")) {
    yield* sql`ALTER TABLE mind_memories ADD COLUMN provenance_kind TEXT NOT NULL DEFAULT 'user' CHECK (provenance_kind IN ('user', 'agent'))`;
    yield* sql`
      UPDATE mind_memories
      SET provenance_kind = 'agent'
      WHERE source_thread_id IS NOT NULL AND source_provider IS NOT NULL
    `;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS mind_operation_receipts (
      project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      op TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, operation_id)
    )
  `;
});
