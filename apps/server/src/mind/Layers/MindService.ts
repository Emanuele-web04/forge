import { createHash, randomUUID } from "node:crypto";

import {
  MIND_MEMORY_PROJECT_CAP,
  MIND_MEMORY_TEXT_MAX_CHARS,
  MIND_RECALL_CANDIDATE_MAX_ITEMS,
  MIND_RECALL_HYGIENE_NOTE,
  MIND_RECALL_MAX_DIGEST_CHARS,
  MIND_RECALL_MAX_ITEMS,
  MIND_RECALL_QUERY_MAX_CHARS,
  MindMemoryId,
  type MindListResult,
  type MindMemory,
  type MindRecallItem,
  type MindRecallResult,
  type ProjectId,
} from "@synara/contracts";
import { Clock, Effect, Layer, Option } from "effect";

import {
  buildMindFtsMatchExpr,
  MindRepository,
  type MindMemoryRow,
} from "../../persistence/Services/MindRepository.ts";
import {
  MindInvalidTextError,
  MindMemoryNotFoundError,
  MindProjectCapReachedError,
  MindSecretRejectedError,
} from "../Errors.ts";
import { isMindSecret } from "../secretPatterns.ts";
import {
  INITIAL_WEIGHT,
  confirmedWeight,
  effectiveWeight,
  rankCandidates,
  shouldPrune,
} from "../scoring.ts";
import {
  MindService,
  type MindConfirmRequest,
  type MindForgetRequest,
  type MindForgetResult,
  type MindListRequest,
  type MindRememberRequest,
  type MindRememberResult,
  type MindRecallRequest,
  type MindServiceError,
  type MindServiceShape,
  type MindSetPinnedRequest,
  type MindStatusRequest,
  type MindStatusResult,
} from "../Services/MindService.ts";

const DAY_MS = 86_400_000;
/** Lazy prune sweep cadence: at most once per 24h per project (plan 05 §6.2). */
const PRUNE_SWEEP_INTERVAL_MS = DAY_MS;
/** Query-recall default (plan 05 §6.3); the result is always bounded by the contracts' 8-item cap. */
const RECALL_DEFAULT_LIMIT = 10;
/** Digest line format mirrors mind's ACTIVE.md hot-memories list. */
const roundTo = (value: number, decimals: number) => Number(value.toFixed(decimals));

const normalizeMindText = (text: string): string => text.trim();
const hashMindText = (normalized: string): string =>
  createHash("sha256").update(normalized).digest("hex");

/**
 * `<` never survives into rendered digest text (it becomes the literal six
 * characters `\u003c`), so stored memories can neither terminate nor forge a
 * `<synara_memories>`/host-context block (plan 05 §6.5).
 */
const escapeDigestText = (text: string): string => text.replace(/</g, "\\u003c");

const renderDigestLine = (item: MindRecallItem): string =>
  `- [${item.type}] ${escapeDigestText(item.text)}`;

/** Renders whole lines only, stopping before the digest char cap would be exceeded. */
const renderDigest = (items: ReadonlyArray<MindRecallItem>): string => {
  const lines: string[] = [];
  for (const item of items) {
    const line = renderDigestLine(item);
    const candidate = lines.length === 0 ? line : `${lines.join("\n")}\n${line}`;
    if (candidate.length > MIND_RECALL_MAX_DIGEST_CHARS) break;
    lines.push(line);
  }
  return lines.join("\n");
};

const toRecallItem = (row: MindMemoryRow, weight: number, nowIso: string): MindRecallItem => ({
  memoryId: row.memoryId,
  type: row.type,
  text: row.text,
  weight: roundTo(weight, 4),
  ageDays: roundTo(Math.max(0, (Date.parse(nowIso) - Date.parse(row.createdAt)) / DAY_MS), 2),
});

const toMindMemory = (row: MindMemoryRow, nowIso: string): MindMemory => ({
  memoryId: row.memoryId,
  projectId: row.projectId,
  text: row.text,
  type: row.type,
  weight: roundTo(effectiveWeight(row, nowIso), 4),
  accessCount: row.accessCount,
  pinned: row.pinned,
  createdAt: row.createdAt,
  lastAccessedAt: row.lastAccessedAt,
  provenance: row.provenance,
});

const idleDaysOf = (row: MindMemoryRow, nowIso: string): number =>
  Math.max(0, (Date.parse(nowIso) - Date.parse(row.lastAccessedAt)) / DAY_MS);

/** Top memories by effective weight (deterministic id tie-break) — the digest source. */
const topDigestRows = (
  rows: ReadonlyArray<MindMemoryRow>,
  nowIso: string,
): ReadonlyArray<{ readonly row: MindMemoryRow; readonly weight: number }> =>
  rows
    .map((row) => ({ row, weight: effectiveWeight(row, nowIso) }))
    .toSorted((a, b) => b.weight - a.weight || a.row.memoryId.localeCompare(b.row.memoryId))
    .slice(0, MIND_RECALL_MAX_ITEMS);

const decodeRememberReceipt = (resultJson: string): MindRememberResult | undefined => {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.memoryId === "string" &&
        typeof record.created === "boolean" &&
        typeof record.reinforced === "boolean"
      ) {
        return {
          memoryId: MindMemoryId.makeUnsafe(record.memoryId),
          created: record.created,
          reinforced: record.reinforced,
          replayed: true,
        };
      }
    }
  } catch {
    // A malformed receipt falls through to the live path; the journal lookup still guards.
  }
  return undefined;
};

const makeMindService = Effect.gen(function* () {
  const repository = yield* MindRepository;

  // In-memory sweep schedule (plan 05 §6.2 decision): the cadence is process-local
  // hygiene timing, while operation idempotency stays durable in receipts + journal.
  const lastSweepAtByProject = new Map<string, number>();

  const nowIsoNow = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

  /**
   * Runs the prune sweep at most once per 24h per project, on the first memory
   * operation after the interval. Deletes prune-eligible rows (journaling
   * op:'prune' per id); pinned rows are exempt via shouldPrune.
   */
  const maybeSweep = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const lastSweepAt = lastSweepAtByProject.get(projectId);
      if (lastSweepAt !== undefined && nowMillis - lastSweepAt < PRUNE_SWEEP_INTERVAL_MS) {
        return;
      }
      lastSweepAtByProject.set(projectId, nowMillis);
      const nowIso = new Date(nowMillis).toISOString();
      const rows = yield* repository.listByProject({ projectId });
      const pruneIds = rows.filter((row) => shouldPrune(row, nowIso)).map((row) => row.memoryId);
      for (const memoryId of pruneIds) {
        const deleted = yield* repository.deleteById({ memoryId });
        if (deleted) {
          yield* repository.appendJournal({
            projectId,
            memoryId,
            op: "prune",
            // Prune is system hygiene, not an agent or user action.
            actor: { kind: "user" },
            threadId: null,
            turnId: null,
            createdAt: nowIso,
          });
        }
      }
    });

  const remember = (
    input: MindRememberRequest,
  ): Effect.Effect<MindRememberResult, MindServiceError> =>
    Effect.gen(function* () {
      const normalized = normalizeMindText(input.text);
      if (normalized.length === 0) {
        return yield* Effect.fail(
          new MindInvalidTextError({
            reason: "empty",
            message: "Memory text is empty after trimming; save a non-empty declarative fact.",
          }),
        );
      }
      if (normalized.length > MIND_MEMORY_TEXT_MAX_CHARS) {
        return yield* Effect.fail(
          new MindInvalidTextError({
            reason: "tooLong",
            message: `Memory text is ${normalized.length} characters after trimming; keep it at ${MIND_MEMORY_TEXT_MAX_CHARS} or fewer.`,
          }),
        );
      }
      if (isMindSecret(normalized)) {
        return yield* Effect.fail(
          new MindSecretRejectedError({
            message:
              "Memory text matches a credential or secret pattern and was rejected; keep secrets in a secret store, never in project memory.",
          }),
        );
      }

      // The sweep runs before the mutation so pruned rows free cap slots.
      yield* maybeSweep(input.projectId);
      const nowMillis = yield* Clock.currentTimeMillis;
      const nowIso = new Date(nowMillis).toISOString();
      const textHash = hashMindText(normalized);
      const operationId = input.turnId === null ? null : `remember:${input.turnId}:${textHash}`;

      if (operationId !== null) {
        const receipt = yield* repository.getReceipt({
          projectId: input.projectId,
          operationId,
        });
        if (Option.isSome(receipt)) {
          const replayed = decodeRememberReceipt(receipt.value.resultJson);
          if (replayed !== undefined) return replayed;
        }
      }

      const existing = yield* repository.findByTextHash({
        projectId: input.projectId,
        textHash,
      });
      if (Option.isSome(existing)) {
        const row = existing.value;
        if (operationId !== null) {
          const journaled = yield* repository.findJournalOp({
            memoryId: row.memoryId,
            op: "remember",
            turnId: input.turnId,
          });
          if (Option.isSome(journaled)) {
            // Crash-recovery replay: the receipt is missing but the journal proves
            // this turn already remembered this text. The row was created by this
            // turn exactly when its creation instant equals the journal instant.
            const createdThisTurn = row.createdAt === journaled.value.createdAt;
            return {
              memoryId: row.memoryId,
              created: createdThisTurn,
              reinforced: !createdThisTurn,
              replayed: true,
            };
          }
        }
        // Reinforce-as-confirm: same (project, text hash) never becomes a second row.
        const updated = yield* repository.applyConfirm({
          memoryId: row.memoryId,
          peakWeight: confirmedWeight(row.peakWeight),
          lastAccessedAt: nowIso,
        });
        if (Option.isNone(updated)) {
          return yield* Effect.fail(
            new MindMemoryNotFoundError({
              memoryId: row.memoryId,
              message: "The matching memory disappeared while reinforcing; retry the remember.",
            }),
          );
        }
        const result: MindRememberResult = {
          memoryId: row.memoryId,
          created: false,
          reinforced: true,
          replayed: false,
        };
        yield* repository.appendJournal({
          projectId: input.projectId,
          memoryId: row.memoryId,
          op: "remember",
          actor: input.actor,
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt: nowIso,
        });
        if (operationId !== null) {
          yield* repository.putReceipt({
            projectId: input.projectId,
            operationId,
            op: "remember",
            resultJson: JSON.stringify({
              memoryId: result.memoryId,
              created: false,
              reinforced: true,
            }),
            createdAt: nowIso,
          });
        }
        return result;
      }

      const count = yield* repository.countByProject({ projectId: input.projectId });
      if (count >= MIND_MEMORY_PROJECT_CAP) {
        return yield* Effect.fail(
          new MindProjectCapReachedError({
            projectId: input.projectId,
            count,
            cap: MIND_MEMORY_PROJECT_CAP,
            message: `Project memory is at the ${MIND_MEMORY_PROJECT_CAP}-memory cap; forget or consolidate memories before adding new ones.`,
          }),
        );
      }
      const inserted = yield* repository.insert({
        memoryId: MindMemoryId.makeUnsafe(randomUUID()),
        projectId: input.projectId,
        text: normalized,
        type: input.type,
        textHash,
        peakWeight: INITIAL_WEIGHT,
        accessCount: 0,
        pinned: false,
        createdAt: nowIso,
        lastAccessedAt: nowIso,
        provenance:
          input.actor.kind === "agent" && input.threadId !== null
            ? { kind: "agent", threadId: input.threadId, provider: input.actor.provider }
            : { kind: "user" },
      });
      const result: MindRememberResult = {
        memoryId: inserted.memoryId,
        created: true,
        reinforced: false,
        replayed: false,
      };
      yield* repository.appendJournal({
        projectId: input.projectId,
        memoryId: inserted.memoryId,
        op: "remember",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      if (operationId !== null) {
        yield* repository.putReceipt({
          projectId: input.projectId,
          operationId,
          op: "remember",
          resultJson: JSON.stringify({
            memoryId: inserted.memoryId,
            created: true,
            reinforced: false,
          }),
          createdAt: nowIso,
        });
      }
      return result;
    });

  const recall = (input: MindRecallRequest): Effect.Effect<MindRecallResult, MindServiceError> =>
    Effect.gen(function* () {
      yield* maybeSweep(input.projectId);
      const nowIso = yield* nowIsoNow;
      const query = input.query ?? "";
      const limit = Math.min(
        Math.max(1, input.limit ?? RECALL_DEFAULT_LIMIT),
        MIND_RECALL_MAX_ITEMS,
      );
      if (query.trim().length === 0) {
        const rows = yield* repository.listByProject({ projectId: input.projectId });
        const digestItems = topDigestRows(rows, nowIso).map(({ row, weight }) =>
          toRecallItem(row, weight, nowIso),
        );
        return {
          digest: renderDigest(digestItems),
          items: digestItems,
          note: MIND_RECALL_HYGIENE_NOTE,
        };
      }
      const candidates = yield* repository.searchCandidates({
        projectId: input.projectId,
        matchExpr: buildMindFtsMatchExpr(query.slice(0, MIND_RECALL_QUERY_MAX_CHARS)),
        limit: MIND_RECALL_CANDIDATE_MAX_ITEMS,
      });
      // rankCandidates sorts ascending by score. bm25 is negative/lower-is-better and
      // the weight factor is a positive multiplier, so the best match carries the most
      // negative score and heads the ascending list — consume from the front.
      const ranked = rankCandidates(candidates, nowIso).slice(0, limit);
      const queryItems = ranked.map((candidate) =>
        toRecallItem(candidate.memory, candidate.effectiveWeight, nowIso),
      );
      return {
        digest: renderDigest(queryItems),
        items: queryItems,
        note: MIND_RECALL_HYGIENE_NOTE,
      };
    });

  const confirm = (input: MindConfirmRequest): Effect.Effect<MindMemory, MindServiceError> =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; recall or list memories to get a valid id.",
          }),
        );
      }
      const row = existing.value;
      const operationId =
        input.turnId === null ? null : `confirm:${input.turnId}:${input.memoryId}`;
      if (operationId !== null) {
        const receipt = yield* repository.getReceipt({
          projectId: row.projectId,
          operationId,
        });
        const replayed =
          Option.isSome(receipt) ||
          Option.isSome(
            yield* repository.findJournalOp({
              memoryId: input.memoryId,
              op: "confirm",
              turnId: input.turnId,
            }),
          );
        if (replayed) {
          // Durable no-op: re-read the row the first confirm updated.
          const current = yield* repository.getById({ memoryId: input.memoryId });
          if (Option.isSome(current)) {
            const nowIso = yield* nowIsoNow;
            return toMindMemory(current.value, nowIso);
          }
        }
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      const nowIso = new Date(nowMillis).toISOString();
      const updated = yield* repository.applyConfirm({
        memoryId: input.memoryId,
        peakWeight: confirmedWeight(row.peakWeight),
        lastAccessedAt: nowIso,
      });
      if (Option.isNone(updated)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "The memory was deleted while confirming; recall to get a valid id.",
          }),
        );
      }
      yield* repository.appendJournal({
        projectId: row.projectId,
        memoryId: input.memoryId,
        op: "confirm",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      if (operationId !== null) {
        yield* repository.putReceipt({
          projectId: row.projectId,
          operationId,
          op: "confirm",
          resultJson: JSON.stringify({
            memoryId: input.memoryId,
            peakWeight: updated.value.peakWeight,
          }),
          createdAt: nowIso,
        });
      }
      // Sweep after the mutation: the just-confirmed row is fresh and exempt,
      // so an explicit confirm can never be pre-empted by the prune sweep.
      yield* maybeSweep(row.projectId);
      return toMindMemory(updated.value, nowIso);
    });

  const forget = (input: MindForgetRequest): Effect.Effect<MindForgetResult, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing)) {
        // Idempotent: forgetting a missing id succeeds.
        return { memoryId: input.memoryId, deleted: false, alreadyGone: true };
      }
      const row = existing.value;
      const deleted = yield* repository.deleteById({ memoryId: input.memoryId });
      if (!deleted) {
        return { memoryId: input.memoryId, deleted: false, alreadyGone: true };
      }
      // Journal rows carry the op and ids only — never memory text.
      yield* repository.appendJournal({
        projectId: row.projectId,
        memoryId: input.memoryId,
        op: "forget",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      yield* maybeSweep(row.projectId);
      return { memoryId: input.memoryId, deleted: true, alreadyGone: false };
    });

  const status = (input: MindStatusRequest): Effect.Effect<MindStatusResult, MindServiceError> =>
    Effect.gen(function* () {
      yield* maybeSweep(input.projectId);
      const nowIso = yield* nowIsoNow;
      const rows = yield* repository.listByProject({ projectId: input.projectId });
      const digestItems = topDigestRows(rows, nowIso).map(({ row, weight }) =>
        toRecallItem(row, weight, nowIso),
      );
      const oldestIdleDays = rows.reduce((max, row) => Math.max(max, idleDaysOf(row, nowIso)), 0);
      return {
        count: rows.length,
        cap: MIND_MEMORY_PROJECT_CAP,
        pinnedCount: rows.filter((row) => row.pinned).length,
        digestChars: renderDigest(digestItems).length,
        oldestIdleDays: roundTo(oldestIdleDays, 2),
      };
    });

  const list = (input: MindListRequest): Effect.Effect<MindListResult, MindServiceError> =>
    Effect.gen(function* () {
      yield* maybeSweep(input.projectId);
      const nowIso = yield* nowIsoNow;
      const rows = yield* repository.listByProject({ projectId: input.projectId });
      const memories = rows
        .map((row) => toMindMemory(row, nowIso))
        .toSorted((a, b) => b.weight - a.weight || a.memoryId.localeCompare(b.memoryId));
      return { memories, count: memories.length, cap: MIND_MEMORY_PROJECT_CAP };
    });

  const setPinned = (input: MindSetPinnedRequest): Effect.Effect<MindMemory, MindServiceError> =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; list memories to get a valid id.",
          }),
        );
      }
      const row = existing.value;
      yield* maybeSweep(row.projectId);
      const nowIso = yield* nowIsoNow;
      const updated = yield* repository.setPinned({
        memoryId: input.memoryId,
        pinned: input.pinned,
      });
      if (Option.isNone(updated)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "The memory was deleted while pinning; list memories to get a valid id.",
          }),
        );
      }
      yield* repository.appendJournal({
        projectId: row.projectId,
        memoryId: input.memoryId,
        op: input.pinned ? "pin" : "unpin",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      return toMindMemory(updated.value, nowIso);
    });

  const shape: MindServiceShape = {
    remember,
    recall,
    confirm,
    forget,
    status,
    list,
    setPinned,
  };
  return shape;
});

export const MindServiceLive = Layer.effect(MindService, makeMindService);
