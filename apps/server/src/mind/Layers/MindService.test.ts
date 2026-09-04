import { assert, it } from "@effect/vitest";
import {
  MIND_MEMORY_PROJECT_CAP,
  MIND_RECALL_HYGIENE_NOTE,
  MindMemoryId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Clock, Duration, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { runMigrations } from "../../persistence/Migrations.ts";
import { MindRepositoryLive } from "../../persistence/Layers/MindRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  MindRepository,
  type InsertMindMemoryInput,
} from "../../persistence/Services/MindRepository.ts";
import { MindService } from "../Services/MindService.ts";
import type { MindRememberRequest } from "../Services/MindService.ts";
import { MindServiceLive } from "./MindService.ts";

const layer = it.layer(
  MindServiceLive.pipe(
    Layer.provideMerge(MindRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const DAY_MS = 86_400_000;

// Operation receipts reference projection_projects, so tests seed the project
// row before any service call that records a receipt.
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
        'Mind service test project',
        '/tmp/mind-service-test',
        '[]',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  });

// The suite shares one in-memory database and one service instance (with its
// in-memory sweep schedule), so every test owns a unique project.
const PROJECTS = {
  remember: "project-mind-service-remember",
  retry: "project-mind-service-retry",
  pureRead: "project-mind-service-pure-read",
  digest: "project-mind-service-digest",
  rank: "project-mind-service-rank",
  confirm: "project-mind-service-confirm",
  cap: "project-mind-service-cap",
  secret: "project-mind-service-secret",
  prune: "project-mind-service-prune",
  forget: "project-mind-service-forget",
  ui: "project-mind-service-ui",
  xproject: "project-mind-service-xproject",
} as const;

let memoryCounter = 0;
const seedMemory = (overrides: Partial<InsertMindMemoryInput> = {}) =>
  Effect.gen(function* () {
    const repository = yield* MindRepository;
    memoryCounter += 1;
    const nowIso = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* repository.insert({
      memoryId: MindMemoryId.makeUnsafe(`memory-${memoryCounter}`),
      projectId: ProjectId.makeUnsafe(PROJECTS.remember),
      text: `seed fact ${memoryCounter}`,
      type: "semantic",
      textHash: `hash-${memoryCounter}`,
      peakWeight: 0.6,
      accessCount: 0,
      pinned: false,
      createdAt: nowIso,
      lastAccessedAt: nowIso,
      provenance: { kind: "user" },
      ...overrides,
    });
  });

const agentActor = { kind: "agent" as const, provider: "codex" as const };
const threadId = ThreadId.makeUnsafe("thread-mind-service");
const rememberRequest = (
  projectId: ProjectId,
  text: string,
  overrides: Partial<MindRememberRequest> = {},
): MindRememberRequest => ({
  projectId,
  text,
  type: "semantic",
  actor: agentActor,
  threadId,
  turnId: "turn-1",
  ...overrides,
});

layer("MindService", (it) => {
  it.effect(
    "remember creates at INITIAL_WEIGHT, normalizes text, and reinforces duplicates as confirms",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.remember);
        yield* ensureProjectRow(PROJECTS.remember);

        const first = yield* service.remember(
          rememberRequest(projectId, "Use bun run test, never bun test.", {
            turnId: "turn-create",
          }),
        );
        assert.strictEqual(first.created, true);
        assert.strictEqual(first.reinforced, false);
        assert.strictEqual(first.replayed, false);
        const row = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
        assert.strictEqual(row.peakWeight, 0.6);
        assert.strictEqual(row.accessCount, 0);
        assert.strictEqual(row.text, "Use bun run test, never bun test.");
        assert.strictEqual(row.provenance.kind, "agent");
        if (row.provenance.kind === "agent") {
          assert.strictEqual(row.provenance.provider, "codex");
          assert.strictEqual(row.provenance.threadId, "thread-mind-service");
        }

        // Same text with surrounding whitespace normalizes to the same hash:
        // one row, reinforced as a confirm (+0.15, access count bumped).
        const second = yield* service.remember(
          rememberRequest(projectId, "  Use bun run test, never bun test.  ", {
            turnId: "turn-reinforce",
          }),
        );
        assert.strictEqual(second.created, false);
        assert.strictEqual(second.reinforced, true);
        assert.strictEqual(second.replayed, false);
        assert.strictEqual(second.memoryId, first.memoryId);
        assert.strictEqual(yield* repository.countByProject({ projectId }), 1);
        const reinforced = Option.getOrThrow(
          yield* repository.getById({ memoryId: first.memoryId }),
        );
        assert.strictEqual(reinforced.peakWeight, 0.75);
        assert.strictEqual(reinforced.accessCount, 1);
        assert.isTrue(
          Option.isSome(
            yield* repository.findJournalOp({
              memoryId: first.memoryId,
              op: "remember",
              turnId: "turn-reinforce",
            }),
          ),
        );
      }),
  );

  it.effect(
    "remember retries with the same turn replay the durable result without double bumping",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.retry);
        yield* ensureProjectRow(PROJECTS.retry);
        const text = "Deploy ports offset via SYNARA_PORT_OFFSET";

        const first = yield* service.remember(
          rememberRequest(projectId, text, { turnId: "turn-retry" }),
        );
        assert.strictEqual(first.created, true);

        const retry = yield* service.remember(
          rememberRequest(projectId, text, { turnId: "turn-retry" }),
        );
        assert.strictEqual(retry.replayed, true);
        assert.strictEqual(retry.created, true);
        assert.strictEqual(retry.memoryId, first.memoryId);
        const row = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
        assert.strictEqual(row.peakWeight, 0.6);
        assert.strictEqual(row.accessCount, 0);

        // Crash-recovery replay: with the receipt gone, the journal row still
        // proves this turn remembered this text and replays without re-applying.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM mind_operation_receipts WHERE project_id = ${projectId}`;
        const journalReplay = yield* service.remember(
          rememberRequest(projectId, text, { turnId: "turn-retry" }),
        );
        assert.strictEqual(journalReplay.replayed, true);
        assert.strictEqual(journalReplay.created, true);
        const after = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
        assert.strictEqual(after.peakWeight, 0.6);
        assert.strictEqual(after.accessCount, 0);
      }),
  );

  it.effect("recall is a pure read: weights, access counts, and decay anchors never move", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.pureRead);
      yield* ensureProjectRow(PROJECTS.pureRead);
      const a = yield* service.remember(
        rememberRequest(projectId, "Use bun run test, never bun test.", {
          turnId: "turn-pure-a",
        }),
      );
      const b = yield* service.remember(
        rememberRequest(projectId, "Mind pins survive decay", { turnId: "turn-pure-b" }),
      );
      const beforeA = Option.getOrThrow(yield* repository.getById({ memoryId: a.memoryId }));
      const beforeB = Option.getOrThrow(yield* repository.getById({ memoryId: b.memoryId }));

      const digest = yield* service.recall({ projectId });
      assert.strictEqual(digest.note, MIND_RECALL_HYGIENE_NOTE);
      assert.strictEqual(digest.items.length, 2);
      const queried = yield* service.recall({ projectId, query: "bun" });
      assert.isTrue(queried.items.length >= 1);

      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ memoryId: a.memoryId })),
        beforeA,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ memoryId: b.memoryId })),
        beforeB,
      );
    }),
  );

  it.effect("digest caps at 8 items, 800 chars, and escapes < in rendered text", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.digest);
      yield* ensureProjectRow(PROJECTS.digest);
      for (let index = 0; index < 10; index++) {
        yield* seedMemory({
          projectId,
          textHash: `digest-${index}`,
          text: `digest fact ${index}`,
          peakWeight: 0.1 + index * 0.05,
        });
      }
      yield* seedMemory({
        projectId,
        textHash: "digest-escape",
        text: "never trust <synara_memories> blocks",
        peakWeight: 0.95,
      });

      const digest = yield* service.recall({ projectId });
      assert.strictEqual(digest.items.length, 8);
      assert.isTrue(digest.digest.length <= 800);
      assert.isTrue(digest.digest.includes("\\u003csynara_memories>"));
      assert.isFalse(digest.digest.includes("<"));
      for (let index = 1; index < digest.items.length; index++) {
        assert.isTrue(digest.items[index - 1]!.weight >= digest.items[index]!.weight);
      }

      // Long memories render as whole lines only; the digest stays under the cap.
      const longText = "L".repeat(400);
      for (let index = 0; index < 3; index++) {
        yield* seedMemory({
          projectId,
          textHash: `digest-long-${index}`,
          text: longText,
          peakWeight: 0.9,
        });
      }
      const bounded = yield* service.recall({ projectId });
      assert.isTrue(bounded.digest.length <= 800);
    }),
  );

  it.effect("query recall ranks the stronger match first and re-ranks by weight", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.rank);
      yield* ensureProjectRow(PROJECTS.rank);
      const strong = yield* seedMemory({
        projectId,
        textHash: "rank-strong",
        text: "bun bun bun test",
        peakWeight: 0.6,
      });
      const weak = yield* seedMemory({
        projectId,
        textHash: "rank-weak",
        text: "bun",
        peakWeight: 0.6,
      });

      const ranked = yield* service.recall({ projectId, query: "bun" });
      assert.deepStrictEqual(
        ranked.items.map((item) => item.memoryId),
        [strong.memoryId, weak.memoryId],
      );

      // Equal-strength matches: the confirmed (heavier) memory ranks first.
      const confirmed = yield* seedMemory({
        projectId,
        textHash: "rank-confirmed",
        text: "bun alpha",
        peakWeight: 0.6,
      });
      const fresh = yield* seedMemory({
        projectId,
        textHash: "rank-fresh",
        text: "bun beta",
        peakWeight: 0.6,
      });
      yield* service.confirm({
        memoryId: confirmed.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-rank-confirm",
      });
      const weighted = yield* service.recall({ projectId, query: "bun" });
      const ids = weighted.items.map((item) => item.memoryId);
      assert.isTrue(ids.indexOf(confirmed.memoryId) < ids.indexOf(fresh.memoryId));
    }),
  );

  it.effect(
    "confirm bumps weight by at most 0.15 capped at 1.0 and repeats in a turn are no-ops",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.confirm);
        yield* ensureProjectRow(PROJECTS.confirm);
        const remembered = yield* service.remember(
          rememberRequest(projectId, "Confirm me once", { turnId: "turn-confirm-create" }),
        );

        const confirmed = yield* service.confirm({
          memoryId: remembered.memoryId,
          projectId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-confirm-1",
        });
        assert.strictEqual(confirmed.weight, 0.75);
        assert.strictEqual(confirmed.accessCount, 1);

        const repeat = yield* service.confirm({
          memoryId: remembered.memoryId,
          projectId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-confirm-1",
        });
        assert.strictEqual(repeat.accessCount, 1);
        assert.strictEqual(repeat.weight, 0.75);

        const cappedRow = yield* seedMemory({
          projectId,
          textHash: "confirm-cap",
          text: "cap me",
          peakWeight: 0.95,
        });
        const capped = yield* service.confirm({
          memoryId: cappedRow.memoryId,
          projectId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-confirm-2",
        });
        assert.strictEqual(capped.weight, 1);

        const missing = yield* Effect.flip(
          service.confirm({
            memoryId: MindMemoryId.makeUnsafe("memory-missing-confirm"),
            projectId,
            actor: { kind: "user" },
            threadId: null,
            turnId: "turn-confirm-3",
          }),
        );
        assert.strictEqual(missing._tag, "MindMemoryNotFoundError");
      }),
  );

  it.effect("remember rejects at the 500-memory project cap with guidance", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.cap);
      yield* ensureProjectRow(PROJECTS.cap);
      for (let index = 0; index < MIND_MEMORY_PROJECT_CAP; index++) {
        yield* seedMemory({
          projectId,
          textHash: `cap-${index}`,
          text: `cap filler ${index}`,
        });
      }

      const rejected = yield* Effect.flip(
        service.remember(rememberRequest(projectId, "one too many", { turnId: "turn-cap" })),
      );
      assert.strictEqual(rejected._tag, "MindProjectCapReachedError");
      if (rejected._tag === "MindProjectCapReachedError") {
        assert.strictEqual(rejected.count, MIND_MEMORY_PROJECT_CAP);
        assert.strictEqual(rejected.cap, MIND_MEMORY_PROJECT_CAP);
        assert.isTrue(rejected.message.includes("forget or consolidate"));
      }
      assert.strictEqual(yield* repository.countByProject({ projectId }), MIND_MEMORY_PROJECT_CAP);
    }),
  );

  it.effect("remember rejects secret-shaped, empty, and oversized text before any write", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.secret);
      yield* ensureProjectRow(PROJECTS.secret);
      const secrets = [
        "my key ghp_1234567890abcdef",
        "-----BEGIN RSA PRIVATE KEY-----",
        "AKIAIOSFODNN7EXAMPLE",
      ];
      for (const text of secrets) {
        const rejected = yield* Effect.flip(
          service.remember(rememberRequest(projectId, text, { turnId: "turn-secret" })),
        );
        assert.strictEqual(rejected._tag, "MindSecretRejectedError");
      }
      assert.strictEqual(yield* repository.countByProject({ projectId }), 0);

      const empty = yield* Effect.flip(
        service.remember(rememberRequest(projectId, "   ", { turnId: "turn-empty" })),
      );
      assert.strictEqual(empty._tag, "MindInvalidTextError");
      if (empty._tag === "MindInvalidTextError") {
        assert.strictEqual(empty.reason, "empty");
      }
      const long = yield* Effect.flip(
        service.remember(rememberRequest(projectId, "x".repeat(501), { turnId: "turn-long" })),
      );
      assert.strictEqual(long._tag, "MindInvalidTextError");
      if (long._tag === "MindInvalidTextError") {
        assert.strictEqual(long.reason, "tooLong");
      }
      assert.strictEqual(yield* repository.countByProject({ projectId }), 0);
    }),
  );

  it.effect(
    "the lazy sweep prunes the three-condition predicate once per 24h and exempts pinned rows",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.prune);
        yield* ensureProjectRow(PROJECTS.prune);
        const aged = new Date((yield* Clock.currentTimeMillis) - 46 * DAY_MS).toISOString();
        const eligible = yield* seedMemory({
          projectId,
          textHash: "prune-eligible",
          text: "stale and unused",
          peakWeight: 0.05,
          createdAt: aged,
          lastAccessedAt: aged,
        });
        const pinned = yield* seedMemory({
          projectId,
          textHash: "prune-pinned",
          text: "stale but pinned",
          peakWeight: 0.05,
          pinned: true,
          createdAt: aged,
          lastAccessedAt: aged,
        });
        const accessed = yield* seedMemory({
          projectId,
          textHash: "prune-accessed",
          text: "stale but accessed",
          peakWeight: 0.05,
          accessCount: 2,
          createdAt: aged,
          lastAccessedAt: aged,
        });
        const fresh = yield* seedMemory({
          projectId,
          textHash: "prune-fresh",
          text: "fresh and light",
          peakWeight: 0.05,
        });

        // First memory operation: the sweep fires and deletes only the row
        // satisfying weight < 0.1 AND accessCount < 2 AND idle > 45 days.
        yield* service.status({ projectId });
        assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: eligible.memoryId })));
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: pinned.memoryId })));
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: accessed.memoryId })));
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: fresh.memoryId })));
        assert.isTrue(
          Option.isSome(
            yield* repository.findJournalOp({
              memoryId: eligible.memoryId,
              op: "prune",
              turnId: null,
            }),
          ),
        );

        // Within 24h of the sweep, a newly eligible row survives the next operation.
        yield* TestClock.adjust(Duration.hours(23));
        const laterAged = new Date((yield* Clock.currentTimeMillis) - 46 * DAY_MS).toISOString();
        const recent = yield* seedMemory({
          projectId,
          textHash: "prune-recent",
          text: "stale later",
          peakWeight: 0.05,
          createdAt: laterAged,
          lastAccessedAt: laterAged,
        });
        yield* service.status({ projectId });
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: recent.memoryId })));

        // After the 24h interval, the next operation prunes it.
        yield* TestClock.adjust(Duration.hours(2));
        yield* service.status({ projectId });
        assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: recent.memoryId })));
      }),
  );

  it.effect("forget deletes for real, journals op-only, and is idempotent for missing ids", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.forget);
      yield* ensureProjectRow(PROJECTS.forget);
      const remembered = yield* service.remember(
        rememberRequest(projectId, "Use bun run test, never bun test.", {
          turnId: "turn-forget-create",
        }),
      );

      const forgotten = yield* service.forget({
        memoryId: remembered.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-forget-1",
      });
      assert.strictEqual(forgotten.deleted, true);
      assert.strictEqual(forgotten.alreadyGone, false);
      assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: remembered.memoryId })));
      // The FTS sync trigger keeps the index in step: nothing surfaces anymore.
      const searched = yield* service.recall({ projectId, query: "bun test" });
      assert.strictEqual(searched.items.length, 0);
      // The journal row survives the delete and carries the op and ids only.
      const journal = Option.getOrThrow(
        yield* repository.findJournalOp({
          memoryId: remembered.memoryId,
          op: "forget",
          turnId: "turn-forget-1",
        }),
      );
      assert.strictEqual(journal.op, "forget");

      const again = yield* service.forget({
        memoryId: remembered.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-forget-2",
      });
      assert.strictEqual(again.deleted, false);
      assert.strictEqual(again.alreadyGone, true);
    }),
  );

  it.effect("status reports cap usage and list/setPinned pass through with computed weights", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.ui);
      yield* ensureProjectRow(PROJECTS.ui);
      const a = yield* service.remember(
        rememberRequest(projectId, "Pinned memory for the UI", { turnId: "turn-ui-a" }),
      );
      const b = yield* service.remember(
        rememberRequest(projectId, "Heavier memory for the UI", { turnId: "turn-ui-b" }),
      );
      yield* service.confirm({
        memoryId: b.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-ui-confirm",
      });

      const pinned = yield* service.setPinned({
        memoryId: a.memoryId,
        projectId,
        pinned: true,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-ui-pin",
      });
      assert.isTrue(pinned.pinned);
      assert.isTrue(
        Option.isSome(
          yield* repository.findJournalOp({
            memoryId: a.memoryId,
            op: "pin",
            turnId: "turn-ui-pin",
          }),
        ),
      );

      const status = yield* service.status({ projectId });
      assert.strictEqual(status.count, 2);
      assert.strictEqual(status.cap, MIND_MEMORY_PROJECT_CAP);
      assert.strictEqual(status.pinnedCount, 1);
      assert.isTrue(status.digestChars > 0 && status.digestChars <= 800);
      assert.isTrue(status.oldestIdleDays >= 0);

      const list = yield* service.list({ projectId });
      assert.strictEqual(list.count, 2);
      assert.deepStrictEqual(
        list.memories.map((memory) => memory.memoryId),
        [b.memoryId, a.memoryId],
      );
      assert.strictEqual(list.memories[0]!.weight, 0.75);
      assert.strictEqual(list.memories[1]!.weight, 0.6);

      const missing = yield* Effect.flip(
        service.setPinned({
          memoryId: MindMemoryId.makeUnsafe("memory-missing-ui"),
          projectId,
          pinned: true,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-ui-pin-missing",
        }),
      );
      assert.strictEqual(missing._tag, "MindMemoryNotFoundError");
    }),
  );

  it.effect("confirm, forget, and setPinned reject foreign-project memory ids", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.xproject);
      const otherProjectId = ProjectId.makeUnsafe(PROJECTS.retry);
      yield* ensureProjectRow(PROJECTS.xproject);
      yield* ensureProjectRow(PROJECTS.retry);
      const seeded = yield* seedMemory({ projectId, textHash: "xproject-foreign" });

      const confirmError = yield* Effect.flip(
        service.confirm({
          projectId: otherProjectId,
          memoryId: seeded.memoryId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-xproject-confirm",
        }),
      );
      assert.strictEqual(confirmError._tag, "MindMemoryNotFoundError");

      const forgotten = yield* service.forget({
        projectId: otherProjectId,
        memoryId: seeded.memoryId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-xproject-forget",
      });
      assert.strictEqual(forgotten.deleted, false);
      assert.strictEqual(forgotten.alreadyGone, true);
      // The foreign row is untouched.
      assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: seeded.memoryId })));

      const pinError = yield* Effect.flip(
        service.setPinned({
          projectId: otherProjectId,
          memoryId: seeded.memoryId,
          pinned: true,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-xproject-pin",
        }),
      );
      assert.strictEqual(pinError._tag, "MindMemoryNotFoundError");
    }),
  );
});
