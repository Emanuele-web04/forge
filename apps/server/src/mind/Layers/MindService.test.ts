import { MindMemory, MindMemoryId, ProjectId, TurnId } from "@synara/contracts";
import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";

import { type MindRepositoryShape } from "../../persistence/Services/MindRepository.ts";
import { makeMindService } from "./MindService.ts";

const projectId = ProjectId.makeUnsafe("project-mind");
const turnId = TurnId.makeUnsafe("turn-1");

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function memoryIdFor(projectId: string, text: string): MindMemoryId {
  const normalized = normalizeText(text);
  const hash = createHash("sha256").update(`memory:${projectId}:${normalized}`).digest("base64url");
  return MindMemoryId.makeUnsafe(hash);
}

interface FakeMindRepositoryState {
  readonly memories: Map<string, MindMemory>;
  readonly journals: {
    memoryId: MindMemoryId;
    projectId: ProjectId;
    turnId: string | null;
    op: string;
    weightDelta: number | undefined;
    createdAt: string;
  }[];
}

function makeFakeMindRepository(): MindRepositoryShape & {
  readonly state: FakeMindRepositoryState;
} {
  const state: FakeMindRepositoryState = {
    memories: new Map(),
    journals: [],
  };

  const findByText: MindRepositoryShape["findByText"] = ({ projectId, text }) =>
    Effect.sync(() => {
      const normalized = normalizeText(text);
      for (const memory of state.memories.values()) {
        if (memory.projectId === projectId && memory.text === normalized) {
          return Option.some(memory);
        }
      }
      return Option.none();
    });

  const getById: MindRepositoryShape["getById"] = ({ projectId, memoryId }) =>
    Effect.sync(() => {
      const memory = state.memories.get(String(memoryId));
      if (memory && memory.projectId === projectId) return Option.some(memory);
      return Option.none();
    });

  const remember: MindRepositoryShape["remember"] = ({ projectId, text, now }) =>
    Effect.sync(() => {
      const normalized = normalizeText(text);
      const memoryId = memoryIdFor(projectId, normalized);
      const existing = state.memories.get(String(memoryId));
      if (existing) {
        const updated: MindMemory = {
          ...existing,
          weight: Math.min(1.0, existing.weight + 0.02),
          accessCount: existing.accessCount + 1,
          updatedAt: now,
        };
        state.memories.set(String(memoryId), updated);
        return updated;
      }
      const created: MindMemory = {
        memoryId,
        projectId,
        text: normalized,
        weight: 1.0,
        accessCount: 0,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      };
      state.memories.set(String(memoryId), created);
      return created;
    });

  const confirm: MindRepositoryShape["confirm"] = ({ projectId, memoryId, now }) =>
    Effect.sync(() => {
      const existing = state.memories.get(String(memoryId));
      if (!existing || existing.projectId !== projectId) {
        throw new Error("Memory not found");
      }
      const weight = Math.min(1.0, existing.weight + Math.min(0.15, 1.0 - existing.weight));
      const updated: MindMemory = { ...existing, weight, updatedAt: now };
      state.memories.set(String(memoryId), updated);
      return updated;
    });

  const forget: MindRepositoryShape["forget"] = ({ projectId, memoryId }) =>
    Effect.sync(() => {
      const existing = state.memories.get(String(memoryId));
      if (existing && existing.projectId === projectId) {
        state.memories.delete(String(memoryId));
      }
    });

  const pin: MindRepositoryShape["pin"] = ({ projectId, memoryId, pinned, now }) =>
    Effect.sync(() => {
      const existing = state.memories.get(String(memoryId));
      if (!existing || existing.projectId !== projectId) {
        throw new Error("Memory not found");
      }
      const updated: MindMemory = { ...existing, pinned, updatedAt: now };
      state.memories.set(String(memoryId), updated);
      return updated;
    });

  const list: MindRepositoryShape["list"] = ({ projectId }) =>
    Effect.sync(() =>
      [...state.memories.values()]
        .filter((m) => m.projectId === projectId)
        .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)),
    );

  const recall: MindRepositoryShape["recall"] = ({ projectId }) => list({ projectId });

  const countByProject: MindRepositoryShape["countByProject"] = ({ projectId }) =>
    Effect.sync(() => [...state.memories.values()].filter((m) => m.projectId === projectId).length);

  const prune: MindRepositoryShape["prune"] = ({ projectId, now }) =>
    Effect.sync(() => {
      const cutoff = new Date(new Date(now).getTime() - 45 * 86400_000).toISOString();
      const deletedIds: MindMemoryId[] = [];
      for (const [id, memory] of state.memories) {
        if (
          memory.projectId === projectId &&
          memory.weight < 0.1 &&
          memory.accessCount < 2 &&
          memory.updatedAt < cutoff &&
          !memory.pinned
        ) {
          deletedIds.push(memory.memoryId);
          state.memories.delete(id);
        }
      }
      return deletedIds;
    });

  const recordJournal: MindRepositoryShape["recordJournal"] = (entry) =>
    Effect.sync(() => {
      state.journals.push({
        memoryId: entry.memoryId,
        projectId: entry.projectId,
        turnId: entry.turnId,
        op: entry.op,
        weightDelta: entry.weightDelta,
        createdAt: entry.createdAt,
      });
    });

  return {
    state,
    findByText,
    getById,
    remember,
    confirm,
    forget,
    pin,
    list,
    recall,
    countByProject,
    prune,
    recordJournal,
  };
}

const now = "2026-06-16T10:00:00.000Z";

it.effect("rejects text that exceeds the max length", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    const service = makeMindService(repo, { nowOverride: now });
    const text = "x".repeat(600);
    const error = yield* service.remember({ projectId, text }).pipe(Effect.flip);
    assert.strictEqual(error.code, "mind.text-too-long");
  }),
);

it.effect("rejects text that contains a secret pattern", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    const service = makeMindService(repo, { nowOverride: now });
    const error = yield* service
      .remember({ projectId, text: "my api_key=supersecret12345678" })
      .pipe(Effect.flip);
    assert.strictEqual(error.code, "mind.secret-pattern");
  }),
);

it.effect("reinforces an existing memory and is idempotent by turnId", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    const service = makeMindService(repo, { nowOverride: now });

    const first = yield* service.remember({ projectId, text: "persistent fact", turnId });
    assert.strictEqual(first.status, "created");
    assert.strictEqual(first.memory.accessCount, 0);
    assert.strictEqual(first.memory.weight, 1.0);

    const sameTurn = yield* service.remember({ projectId, text: "persistent fact", turnId });
    assert.strictEqual(sameTurn.status, "reinforced");
    assert.strictEqual(sameTurn.memory.accessCount, 0);
    assert.strictEqual(sameTurn.memory.weight, 1.0);

    const nextTurn = yield* service.remember({
      projectId,
      text: "persistent fact",
      turnId: TurnId.makeUnsafe("turn-2"),
    });
    assert.strictEqual(nextTurn.status, "reinforced");
    assert.strictEqual(nextTurn.memory.accessCount, 1);
  }),
);

it.effect("enforces the project memory cap for new memories", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    for (let i = 0; i < 500; i += 1) {
      const id = MindMemoryId.makeUnsafe(`mem:${i}`);
      repo.state.memories.set(String(id), {
        memoryId: id,
        projectId,
        text: `filler ${i}`,
        weight: 1.0,
        accessCount: 0,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      } as MindMemory);
    }
    const service = makeMindService(repo, { nowOverride: now });

    const error = yield* service.remember({ projectId, text: "one too many" }).pipe(Effect.flip);
    assert.strictEqual(error.code, "mind.memory-cap-reached");
  }),
);

it.effect("recall is a read-only operation", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    const service = makeMindService(repo, { nowOverride: now });

    const remembered = yield* service.remember({ projectId, text: "recall me" });

    const recalled = yield* service.recall({ projectId }).pipe(Effect.provide(TestClock.layer()));

    assert.strictEqual(recalled.items.length, 1);
    const recalledItem = recalled.items[0]!;
    assert.strictEqual(recalledItem.memory.memoryId, remembered.memory.memoryId);

    const reloaded = yield* repo.getById({
      projectId,
      memoryId: remembered.memory.memoryId,
    });
    const reloadedValue = Option.getOrThrow(reloaded);
    assert.strictEqual(reloadedValue.accessCount, 0);
    assert.strictEqual(reloadedValue.weight, 1.0);
  }),
);

it.effect("confirm is idempotent by turnId", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    const service = makeMindService(repo, { nowOverride: now });

    const created = yield* service.remember({
      projectId,
      text: "confirm me",
      turnId,
    });

    // Lower weight manually so confirm has a visible effect.
    repo.state.memories.set(String(created.memory.memoryId), {
      ...created.memory,
      weight: 0.5,
    } as MindMemory);

    const first = yield* service.confirm({
      projectId,
      memoryId: created.memory.memoryId,
      turnId,
    });
    assert.strictEqual(first.alreadyConfirmedInTurn, false);
    assert.strictEqual(first.memory.weight, 0.65);

    const sameTurn = yield* service.confirm({
      projectId,
      memoryId: created.memory.memoryId,
      turnId,
    });
    assert.strictEqual(sameTurn.alreadyConfirmedInTurn, true);
    assert.strictEqual(sameTurn.memory.weight, 0.65);

    const nextTurn = yield* service.confirm({
      projectId,
      memoryId: created.memory.memoryId,
      turnId: TurnId.makeUnsafe("turn-2"),
    });
    assert.strictEqual(nextTurn.alreadyConfirmedInTurn, false);
    assert.strictEqual(nextTurn.memory.weight, 0.8);
  }),
);

it.effect("prune removes stale, low-weight memories but never pinned ones", () =>
  Effect.gen(function* () {
    const repo = makeFakeMindRepository();
    const service = makeMindService(repo, { nowOverride: now });

    const staleDate = new Date(new Date(now).getTime() - 60 * 86400_000).toISOString();

    const pinnedId = MindMemoryId.makeUnsafe("pinned");
    repo.state.memories.set(String(pinnedId), {
      memoryId: pinnedId,
      projectId,
      text: "pinned stale",
      weight: 0.05,
      accessCount: 0,
      pinned: true,
      createdAt: staleDate,
      updatedAt: staleDate,
    } as MindMemory);

    const prunableId = MindMemoryId.makeUnsafe("prunable");
    repo.state.memories.set(String(prunableId), {
      memoryId: prunableId,
      projectId,
      text: "prunable stale",
      weight: 0.05,
      accessCount: 0,
      pinned: false,
      createdAt: staleDate,
      updatedAt: staleDate,
    } as MindMemory);

    const result = yield* service.prune({ projectId });

    assert.deepStrictEqual(result.deletedIds, [prunableId]);
    assert.isTrue(repo.state.memories.has(String(pinnedId)));
    assert.isFalse(repo.state.memories.has(String(prunableId)));
  }),
);
