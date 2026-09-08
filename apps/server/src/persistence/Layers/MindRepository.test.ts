import { assert, it } from "@effect/vitest";
import { MindMemoryId, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import {
  buildMindFtsMatchExpr,
  MindRepository,
  type InsertMindMemoryInput,
} from "../Services/MindRepository.ts";
import { MindRepositoryLive } from "./MindRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(MindRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

// The suite shares one in-memory database, so every test owns a unique project.
const PROJECTS = {
  dedupe: "project-mind-dedupe",
  list: "project-mind-list",
  listOther: "project-mind-list-other",
  search: "project-mind-search",
  searchOther: "project-mind-search-other",
  confirm: "project-mind-confirm",
  pin: "project-mind-pin",
  forget: "project-mind-forget",
  journal: "project-mind-journal",
  count: "project-mind-count",
  countOther: "project-mind-count-other",
  receipt: "project-mind-receipt",
  receiptOther: "project-mind-receipt-other",
} as const;

let memoryCounter = 0;
const memoryInput = (overrides: Partial<InsertMindMemoryInput> = {}): InsertMindMemoryInput => {
  memoryCounter += 1;
  return {
    memoryId: MindMemoryId.makeUnsafe(`memory-${memoryCounter}`),
    projectId: ProjectId.makeUnsafe(PROJECTS.dedupe),
    text: "Use bun run test, never bun test.",
    type: "decision",
    textHash: `hash-${memoryCounter}`,
    peakWeight: 0.6,
    accessCount: 0,
    pinned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastAccessedAt: "2026-09-01T00:00:00.000Z",
    provenance: { kind: "user" },
    ...overrides,
  };
};

const agentProvenance = {
  kind: "agent" as const,
  threadId: ThreadId.makeUnsafe("thread-mind-1"),
  provider: "codex" as const,
};

const ensureProjectRow = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id,
        title,
        workspace_root,
        scripts_json,
        created_at,
        updated_at
      )
      VALUES (
        ${projectId},
        'Mind test project',
        '/tmp/mind-test',
        '[]',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  });

layer("MindRepository", (it) => {
  it.effect("inserts, round-trips provenance, and dedupes by (project, text hash)", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.dedupe);

      const agent = yield* repository.insert(
        memoryInput({ projectId, provenance: agentProvenance, textHash: "shared-hash" }),
      );
      assert.strictEqual(agent.provenance.kind, "agent");
      if (agent.provenance.kind === "agent") {
        assert.strictEqual(agent.provenance.provider, "codex");
        assert.strictEqual(agent.provenance.threadId, "thread-mind-1");
      }

      const found = yield* repository.findByTextHash({ projectId, textHash: "shared-hash" });
      assert.isTrue(Option.isSome(found));
      assert.strictEqual(Option.getOrThrow(found).memoryId, agent.memoryId);

      // The UNIQUE (project_id, text_hash) constraint surfaces a duplicate insert
      // as a failure — never a second row.
      const duplicate = yield* Effect.flip(
        repository.insert(
          memoryInput({
            projectId,
            provenance: agentProvenance,
            textHash: "shared-hash",
          }),
        ),
      );
      assert.isDefined(duplicate);

      const missingHash = yield* repository.findByTextHash({ projectId, textHash: "no-such-hash" });
      assert.isTrue(Option.isNone(missingHash));
      assert.strictEqual(yield* repository.countByProject({ projectId }), 1);
    }),
  );

  it.effect("lists a project pinned-first, then most recently accessed, bounded by limit", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.list);

      const oldest = yield* repository.insert(
        memoryInput({ projectId, lastAccessedAt: "2026-09-01T00:00:00.000Z" }),
      );
      const newer = yield* repository.insert(
        memoryInput({ projectId, lastAccessedAt: "2026-09-02T00:00:00.000Z" }),
      );
      const pinned = yield* repository.insert(
        memoryInput({ projectId, pinned: true, lastAccessedAt: "2026-08-31T00:00:00.000Z" }),
      );
      yield* repository.insert(
        memoryInput({ projectId: ProjectId.makeUnsafe(PROJECTS.listOther) }),
      );

      const listed = yield* repository.listByProject({ projectId });
      assert.deepStrictEqual(
        listed.map((memory) => memory.memoryId),
        [pinned.memoryId, newer.memoryId, oldest.memoryId],
      );

      const bounded = yield* repository.listByProject({ projectId, limit: 2 });
      assert.deepStrictEqual(
        bounded.map((memory) => memory.memoryId),
        [pinned.memoryId, newer.memoryId],
      );
    }),
  );

  it.effect("ranks FTS candidates by bm25 and survives match-operator injection", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.search);

      const bunMemory = yield* repository.insert(
        memoryInput({ projectId, text: "Use bun run test, never bun test." }),
      );
      yield* repository.insert(
        memoryInput({ projectId, text: "Deploy ports offset via SYNARA_PORT_OFFSET" }),
      );
      yield* repository.insert(
        memoryInput({
          projectId: ProjectId.makeUnsafe(PROJECTS.searchOther),
          text: "Other project bun rule",
        }),
      );

      const candidates = yield* repository.searchCandidates({
        projectId,
        matchExpr: buildMindFtsMatchExpr("bun test"),
      });
      assert.deepStrictEqual(
        candidates.map((candidate) => candidate.memory.memoryId),
        [bunMemory.memoryId],
      );
      for (const candidate of candidates) {
        assert.isTrue(candidate.bm25 < 0);
      }

      // Quotes, asterisks, and NEAR syntax in user text cannot inject match operators.
      const hostile = 'never" OR NEAR(a b) OR "test* --';
      const safeCandidates = yield* repository.searchCandidates({
        projectId,
        matchExpr: buildMindFtsMatchExpr(hostile),
      });
      for (const candidate of safeCandidates) {
        assert.strictEqual(candidate.memory.projectId, ProjectId.makeUnsafe(PROJECTS.search));
      }

      // A match expression with no tokens yields no candidates instead of an SQL error.
      const empty = yield* repository.searchCandidates({ projectId, matchExpr: "   " });
      assert.deepStrictEqual(empty, []);
    }),
  );

  it("buildMindFtsMatchExpr quotes every token and attaches the prefix asterisk", () => {
    assert.strictEqual(
      buildMindFtsMatchExpr("  use   bun run test "),
      '"use"* "bun"* "run"* "test"*',
    );
    assert.strictEqual(buildMindFtsMatchExpr('say "hello"'), '"say"* """hello"""*');
    assert.strictEqual(buildMindFtsMatchExpr("NEAR(a b) OR x"), '"NEAR(a"* "b)"* "OR"* "x"*');
    assert.strictEqual(buildMindFtsMatchExpr(""), "");
  });

  it.effect("applyConfirm updates weight, access count, and the decay anchor", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();

      const inserted = yield* repository.insert(
        memoryInput({ projectId: ProjectId.makeUnsafe(PROJECTS.confirm) }),
      );
      const confirmed = yield* repository.applyConfirm({
        memoryId: inserted.memoryId,
        peakWeight: 0.75,
        lastAccessedAt: "2026-09-03T00:00:00.000Z",
      });
      const confirmedRow = Option.getOrThrow(confirmed);
      assert.strictEqual(confirmedRow.memoryId, inserted.memoryId);
      assert.strictEqual(confirmedRow.peakWeight, 0.75);
      assert.strictEqual(confirmedRow.accessCount, 1);
      assert.strictEqual(confirmedRow.lastAccessedAt, "2026-09-03T00:00:00.000Z");

      const missing = yield* repository.applyConfirm({
        memoryId: MindMemoryId.makeUnsafe("memory-missing-confirm"),
        peakWeight: 0.9,
        lastAccessedAt: "2026-09-03T00:00:00.000Z",
      });
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("pins and unpins a memory", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();

      const inserted = yield* repository.insert(
        memoryInput({ projectId: ProjectId.makeUnsafe(PROJECTS.pin) }),
      );
      const pinned = Option.getOrThrow(
        yield* repository.setPinned({ memoryId: inserted.memoryId, pinned: true }),
      );
      assert.isTrue(pinned.pinned);
      const unpinned = Option.getOrThrow(
        yield* repository.setPinned({ memoryId: inserted.memoryId, pinned: false }),
      );
      assert.isFalse(unpinned.pinned);

      const missing = yield* repository.setPinned({
        memoryId: MindMemoryId.makeUnsafe("memory-missing-pin"),
        pinned: true,
      });
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("deletes by id, keeps an op-only journal row, and clears the FTS index", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.forget);

      const inserted = yield* repository.insert(
        memoryInput({ projectId, textHash: "forget-hash" }),
      );
      const journalTurnId = "turn-forget-1";
      yield* repository.appendJournal({
        projectId,
        memoryId: inserted.memoryId,
        op: "remember",
        actor: { kind: "user" },
        threadId: null,
        turnId: journalTurnId,
        createdAt: "2026-09-01T00:00:00.000Z",
      });

      assert.isTrue(yield* repository.deleteById({ memoryId: inserted.memoryId }));
      assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: inserted.memoryId })));
      // Forget is idempotent: a missing id reports already-gone.
      assert.isFalse(yield* repository.deleteById({ memoryId: inserted.memoryId }));

      // The journal row survives the delete and carries no memory text.
      const journalRow = Option.getOrThrow(
        yield* repository.findJournalOp({
          memoryId: inserted.memoryId,
          op: "remember",
          turnId: journalTurnId,
        }),
      );
      assert.strictEqual(journalRow.op, "remember");
      assert.strictEqual(journalRow.turnId, journalTurnId);

      const candidates = yield* repository.searchCandidates({
        projectId,
        matchExpr: buildMindFtsMatchExpr("bun test"),
      });
      assert.deepStrictEqual(candidates, []);
    }),
  );

  it.effect("findJournalOp is the (memoryId, op, turnId) idempotency lookup", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();

      const inserted = yield* repository.insert(
        memoryInput({ projectId: ProjectId.makeUnsafe(PROJECTS.journal) }),
      );
      yield* repository.appendJournal({
        projectId: ProjectId.makeUnsafe(PROJECTS.journal),
        memoryId: inserted.memoryId,
        op: "remember",
        actor: agentProvenance,
        threadId: ThreadId.makeUnsafe("thread-mind-1"),
        turnId: "turn-retry-1",
        createdAt: "2026-09-01T00:00:00.000Z",
      });

      const hit = Option.getOrThrow(
        yield* repository.findJournalOp({
          memoryId: inserted.memoryId,
          op: "remember",
          turnId: "turn-retry-1",
        }),
      );
      assert.strictEqual(hit.op, "remember");
      assert.strictEqual(hit.actor.kind, "agent");
      if (hit.actor.kind === "agent") {
        assert.strictEqual(hit.actor.provider, "codex");
      }
      assert.strictEqual(hit.threadId, "thread-mind-1");

      const otherTurn = yield* repository.findJournalOp({
        memoryId: inserted.memoryId,
        op: "remember",
        turnId: "turn-retry-2",
      });
      assert.isTrue(Option.isNone(otherTurn));

      const otherOp = yield* repository.findJournalOp({
        memoryId: inserted.memoryId,
        op: "confirm",
        turnId: "turn-retry-1",
      });
      assert.isTrue(Option.isNone(otherOp));
    }),
  );

  it.effect("counts memories per project", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.count);
      const otherProjectId = ProjectId.makeUnsafe(PROJECTS.countOther);

      assert.strictEqual(yield* repository.countByProject({ projectId }), 0);
      yield* repository.insert(memoryInput({ projectId }));
      yield* repository.insert(memoryInput({ projectId }));
      yield* repository.insert(memoryInput({ projectId: otherProjectId }));

      assert.strictEqual(yield* repository.countByProject({ projectId }), 2);
      assert.strictEqual(yield* repository.countByProject({ projectId: otherProjectId }), 1);
    }),
  );

  it.effect("operation receipts are unique per project and replay-safe", () =>
    Effect.gen(function* () {
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.receipt);
      yield* ensureProjectRow(PROJECTS.receiptOther);

      const receipt = {
        projectId: ProjectId.makeUnsafe(PROJECTS.receipt),
        operationId: "operation-1",
        op: "remember",
        resultJson: '{"memoryId":"memory-1","created":true}',
        createdAt: "2026-09-01T00:00:00.000Z",
      };
      assert.isTrue(yield* repository.putReceipt(receipt));
      const stored = Option.getOrThrow(
        yield* repository.getReceipt({
          projectId: ProjectId.makeUnsafe(PROJECTS.receipt),
          operationId: "operation-1",
        }),
      );
      assert.strictEqual(stored.resultJson, '{"memoryId":"memory-1","created":true}');
      assert.strictEqual(stored.op, "remember");

      // Same (project, operation) again: not inserted, original result preserved.
      assert.isFalse(
        yield* repository.putReceipt({ ...receipt, resultJson: '{"overwritten":true}' }),
      );
      const replayed = Option.getOrThrow(
        yield* repository.getReceipt({
          projectId: ProjectId.makeUnsafe(PROJECTS.receipt),
          operationId: "operation-1",
        }),
      );
      assert.strictEqual(replayed.resultJson, '{"memoryId":"memory-1","created":true}');

      // The same operation id in a different project is allowed.
      assert.isTrue(
        yield* repository.putReceipt({
          ...receipt,
          projectId: ProjectId.makeUnsafe(PROJECTS.receiptOther),
        }),
      );
    }),
  );
});
