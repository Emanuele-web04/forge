import { assert, it } from "@effect/vitest";
import { ProjectId, TurnId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { MindRepository } from "../Services/MindRepository.ts";
import { MindRepositoryLive } from "./MindRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(MindRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const projectId = ProjectId.makeUnsafe("project-mind");
const turnId = TurnId.makeUnsafe("turn-1");

const setupMindTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO projects (project_id)
      VALUES (${projectId}), (${makeProjectId("list")}), (${makeProjectId("count")})
    `;
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

const makeProjectId = (name: string) => ProjectId.makeUnsafe(`project-${name}`);

layer("MindRepository", (it) => {
  it.effect("creates and reinforces a memory by projectId and normalized text", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const first = yield* repository.remember({
        projectId,
        text: "  hello   world  ",
        now: "2026-06-16T10:00:00.000Z",
      });
      const second = yield* repository.remember({
        projectId,
        text: "hello world",
        turnId,
        now: "2026-06-16T10:00:01.000Z",
      });

      assert.strictEqual(first.memoryId, second.memoryId);
      assert.strictEqual(first.text, "hello world");
      assert.strictEqual(second.text, "hello world");
      assert.strictEqual(second.accessCount, 1);
      assert.strictEqual(second.weight, 1.0);
      assert.strictEqual(second.updatedAt, "2026-06-16T10:00:01.000Z");

      const found = yield* repository.findByText({ projectId, text: "hello world" });
      assert.isTrue(Option.isSome(found));
      if (Option.isSome(found)) {
        assert.strictEqual(found.value.accessCount, 1);
      }
    }),
  );

  it.effect("recall is a pure read and does not mutate weight or access_count", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const memory = yield* repository.remember({
        projectId,
        text: "synara is helpful",
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* repository.recall({
        projectId,
        query: "synara",
      });

      assert.lengthOf(results, 1);
      assert.strictEqual(results[0]?.memoryId, memory.memoryId);

      const reloaded = yield* repository.getById({
        projectId,
        memoryId: memory.memoryId,
      });
      assert.isTrue(Option.isSome(reloaded));
      if (Option.isSome(reloaded)) {
        assert.strictEqual(reloaded.value.weight, memory.weight);
        assert.strictEqual(reloaded.value.accessCount, memory.accessCount);
        assert.strictEqual(reloaded.value.updatedAt, memory.updatedAt);
      }
    }),
  );

  it.effect("confirm bumps weight by min(0.15, 1.0 - weight) and resets updatedAt", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const memory = yield* repository.remember({
        projectId,
        text: "important fact",
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* sql`
        UPDATE mind_memories
        SET weight = 0.7, updated_at = '2026-06-16T09:00:00.000Z'
        WHERE memory_id = ${memory.memoryId}
      `;

      const confirmed = yield* repository.confirm({
        projectId,
        memoryId: memory.memoryId,
        now: "2026-06-16T10:05:00.000Z",
      });

      assert.closeTo(confirmed.weight, 0.85, 0.001);
      assert.strictEqual(confirmed.accessCount, memory.accessCount);
      assert.strictEqual(confirmed.updatedAt, "2026-06-16T10:05:00.000Z");
    }),
  );

  it.effect("forget removes the memory row", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const memory = yield* repository.remember({
        projectId,
        text: "forgettable fact",
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.forget({ projectId, memoryId: memory.memoryId });

      const reloaded = yield* repository.getById({
        projectId,
        memoryId: memory.memoryId,
      });
      assert.isTrue(Option.isNone(reloaded));
    }),
  );

  it.effect("pin prevents prune from deleting a memory", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const unpinned = yield* repository.remember({
        projectId,
        text: "unpinned stale memory",
        now: "2026-06-16T10:00:00.000Z",
      });
      const pinned = yield* repository.remember({
        projectId,
        text: "pinned stale memory",
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.pin({
        projectId,
        memoryId: pinned.memoryId,
        pinned: true,
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* sql`
        UPDATE mind_memories
        SET weight = 0.05, access_count = 1, updated_at = '2026-04-01T00:00:00.000Z'
        WHERE memory_id IN (${unpinned.memoryId}, ${pinned.memoryId})
      `;

      const deletedIds = yield* repository.prune({
        projectId,
        now: "2026-06-16T10:00:00.000Z",
      });

      assert.deepStrictEqual(deletedIds, [unpinned.memoryId]);

      const unpinnedReloaded = yield* repository.getById({
        projectId,
        memoryId: unpinned.memoryId,
      });
      assert.isTrue(Option.isNone(unpinnedReloaded));

      const pinnedReloaded = yield* repository.getById({
        projectId,
        memoryId: pinned.memoryId,
      });
      assert.isTrue(Option.isSome(pinnedReloaded));
    }),
  );

  it.effect("prune deletes weight-1.0 memories once decayed below threshold", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const stale = yield* repository.remember({
        projectId,
        text: "stale weight-1.0 memory",
        now: "2026-04-01T00:00:00.000Z",
      });
      const fresh = yield* repository.remember({
        projectId,
        text: "fresh weight-1.0 memory",
        now: "2026-06-16T10:00:00.000Z",
      });

      const deletedIds = yield* repository.prune({
        projectId,
        now: "2026-06-16T10:00:00.000Z",
      });

      assert.deepStrictEqual(deletedIds, [stale.memoryId]);

      const freshReloaded = yield* repository.getById({
        projectId,
        memoryId: fresh.memoryId,
      });
      assert.isTrue(Option.isSome(freshReloaded));
    }),
  );

  it.effect("journal entry for forget has no text and records the correct columns", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const memory = yield* repository.remember({
        projectId,
        text: "memory with journal",
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.recordJournal({
        memoryId: memory.memoryId,
        projectId,
        turnId,
        op: "forget",
        createdAt: "2026-06-16T10:05:00.000Z",
      });

      const rows = yield* sql<{
        readonly journal_id: number;
        readonly memory_id: string;
        readonly project_id: string;
        readonly turn_id: string | null;
        readonly op: string;
        readonly weight_delta: number | null;
        readonly created_at: string;
      }>`
        SELECT journal_id, memory_id, project_id, turn_id, op, weight_delta, created_at
        FROM mind_memory_journal
      `;

      assert.lengthOf(rows, 1);
      const entry = rows[0];
      if (entry === undefined) {
        return assert.fail("Expected a journal entry.");
      }
      assert.strictEqual(entry.op, "forget");
      assert.strictEqual(entry.memory_id, memory.memoryId);
      assert.strictEqual(entry.project_id, projectId);
      assert.strictEqual(entry.turn_id, turnId);
      assert.isNull(entry.weight_delta);
      assert.isUndefined((entry as { readonly text?: string }).text);
    }),
  );

  it.effect("lists memories for a project with optional query filtering", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const p2 = makeProjectId("list");
      yield* repository.remember({
        projectId: p2,
        text: "alpha",
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.remember({
        projectId: p2,
        text: "beta",
        now: "2026-06-16T10:00:01.000Z",
      });
      yield* repository.remember({
        projectId: p2,
        text: "gamma",
        now: "2026-06-16T10:00:02.000Z",
      });

      const all = yield* repository.list({ projectId: p2 });
      assert.deepStrictEqual(
        all.map((m) => m.text),
        ["gamma", "beta", "alpha"],
      );

      const filtered = yield* repository.list({ projectId: p2, query: "beta" });
      assert.lengthOf(filtered, 1);
      assert.strictEqual(filtered[0]?.text, "beta");
    }),
  );

  it.effect("recall tolerates FTS operator characters in the query", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const memory = yield* repository.remember({
        projectId,
        text: "deploy or rollback friday plan",
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* repository.recall({
        projectId,
        query: 'friday "deploy',
      });

      assert.lengthOf(results, 1);
      assert.strictEqual(results[0]?.memoryId, memory.memoryId);
    }),
  );

  it.effect("counts memories by project", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* setupMindTables(sql);

      const p3 = makeProjectId("count");
      const countBefore = yield* repository.countByProject({ projectId: p3 });
      assert.strictEqual(countBefore, 0);

      yield* repository.remember({
        projectId: p3,
        text: "one",
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.remember({
        projectId: p3,
        text: "two",
        now: "2026-06-16T10:00:01.000Z",
      });

      const countAfter = yield* repository.countByProject({ projectId: p3 });
      assert.strictEqual(countAfter, 2);
    }),
  );
});
