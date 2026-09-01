import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mind_memories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
    type TEXT NOT NULL CHECK (type IN ('semantic','episodic','procedural','decision')),
    text_hash TEXT NOT NULL,
    peak_weight REAL NOT NULL CHECK (peak_weight BETWEEN 0 AND 1),
    access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    source_thread_id TEXT,
    source_provider TEXT,
    UNIQUE (project_id, text_hash)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_mind_memories_project ON mind_memories(project_id, pinned, last_accessed_at)`;
  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS mind_memories_fts USING fts5(text, content='mind_memories', content_rowid='rowid', tokenize='unicode61')`;
  yield* sql`CREATE TABLE IF NOT EXISTS mind_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('remember','confirm','forget','pin','unpin','prune')),
    actor TEXT NOT NULL,
    thread_id TEXT,
    turn_id TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_mind_journal_turn ON mind_journal(memory_id, op, turn_id)`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS mind_memories_fts_insert AFTER INSERT ON mind_memories BEGIN INSERT INTO mind_memories_fts(rowid, text) VALUES (new.rowid, new.text); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS mind_memories_fts_update AFTER UPDATE OF text ON mind_memories BEGIN INSERT INTO mind_memories_fts(mind_memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO mind_memories_fts(rowid, text) VALUES (new.rowid, new.text); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS mind_memories_fts_delete AFTER DELETE ON mind_memories BEGIN INSERT INTO mind_memories_fts(mind_memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END`;
});
