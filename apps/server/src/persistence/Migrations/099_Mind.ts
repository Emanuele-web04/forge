import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mind_memories (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      text TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mind_memories_project_id
    ON mind_memories(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mind_memories_project_id_updated
    ON mind_memories(project_id, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mind_memories_project_id_pinned
    ON mind_memories(project_id, pinned)
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS mind_memories_fts USING fts5(
      text,
      content='mind_memories',
      content_rowid='rowid'
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mind_memory_journal (
      journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_id TEXT,
      op TEXT NOT NULL,
      weight_delta REAL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mind_memory_journal_memory_id
    ON mind_memory_journal(memory_id)
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS mind_memories_fts_insert
    AFTER INSERT ON mind_memories
    BEGIN
      INSERT INTO mind_memories_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS mind_memories_fts_update
    AFTER UPDATE ON mind_memories
    BEGIN
      INSERT INTO mind_memories_fts(mind_memories_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
      INSERT INTO mind_memories_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS mind_memories_fts_delete
    AFTER DELETE ON mind_memories
    BEGIN
      INSERT INTO mind_memories_fts(mind_memories_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
    END
  `;
});
