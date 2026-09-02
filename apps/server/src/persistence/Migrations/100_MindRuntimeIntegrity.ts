import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const memoryColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('mind_memories')
  `;
  if (!memoryColumns.some(({ name }) => name === "provenance_kind")) {
    yield* sql`ALTER TABLE mind_memories ADD COLUMN provenance_kind TEXT NOT NULL DEFAULT 'user' CHECK (provenance_kind IN ('user', 'agent'))`;
  }
  // Outside the column guard so a replayed migration body re-backfills rows
  // inserted after the first run; idempotent because it only touches rows with
  // complete source metadata.
  yield* sql`
    UPDATE mind_memories
    SET provenance_kind = 'agent'
    WHERE source_thread_id IS NOT NULL AND source_provider IS NOT NULL
  `;
  // No FK on project_id: projection repair deletes and reinserts
  // projection_projects, so a cascading (or restricting) FK would wipe or block
  // receipts. Matches mind_memories and mind_journal.
  yield* sql`
    CREATE TABLE IF NOT EXISTS mind_operation_receipts (
      project_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('remember','confirm','forget','pin','unpin','prune')),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, operation_id)
    )
  `;
});
