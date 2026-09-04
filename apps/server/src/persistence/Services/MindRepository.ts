import {
  IsoDateTime,
  MIND_MEMORY_PROJECT_CAP,
  MIND_RECALL_CANDIDATE_MAX_ITEMS,
  MindJournalEntry,
  MindJournalOp,
  MindMemory,
  MindMemoryId,
  MindMemoryType,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type MindRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/**
 * A stored mind memory: the persisted row (peak weight, decay anchor,
 * provenance) before any server-computed effective weight is derived from it.
 */
export const MindMemoryRow = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  text: MindMemory.fields.text,
  type: MindMemoryType,
  textHash: Schema.String,
  peakWeight: MindMemory.fields.weight,
  accessCount: NonNegativeInt,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
  provenance: MindMemory.fields.provenance,
});
export type MindMemoryRow = typeof MindMemoryRow.Type;

/** An FTS candidate: the stored memory plus its raw (negative, lower-is-better) bm25 rank. */
export interface MindMemoryCandidate {
  readonly memory: MindMemoryRow;
  readonly bm25: number;
}

/** A durable operation receipt for retry idempotency (mind_operation_receipts row). */
export const MindReceiptRow = Schema.Struct({
  projectId: ProjectId,
  operationId: TrimmedNonEmptyString,
  op: Schema.String,
  resultJson: Schema.String,
  createdAt: IsoDateTime,
});
export type MindReceiptRow = typeof MindReceiptRow.Type;

export const InsertMindMemoryInput = MindMemoryRow;
export type InsertMindMemoryInput = typeof InsertMindMemoryInput.Type;

export const FindMindMemoryByTextHashInput = Schema.Struct({
  projectId: ProjectId,
  textHash: Schema.String,
});
export type FindMindMemoryByTextHashInput = typeof FindMindMemoryByTextHashInput.Type;

export const GetMindMemoryInput = Schema.Struct({
  memoryId: MindMemoryId,
});
export type GetMindMemoryInput = typeof GetMindMemoryInput.Type;

export const ListMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  // The list surface is bounded by the per-project cap: no unbounded reads.
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_MEMORY_PROJECT_CAP })),
  ).pipe(Schema.withDecodingDefault(() => MIND_MEMORY_PROJECT_CAP)),
});
export type ListMindMemoriesInput = typeof ListMindMemoriesInput.Type;

export const SearchMindCandidatesInput = Schema.Struct({
  projectId: ProjectId,
  /** Prebuilt FTS5 MATCH expression; build it with {@link buildMindFtsMatchExpr}. */
  matchExpr: Schema.String,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_RECALL_CANDIDATE_MAX_ITEMS })),
  ).pipe(Schema.withDecodingDefault(() => MIND_RECALL_CANDIDATE_MAX_ITEMS)),
});
export type SearchMindCandidatesInput = typeof SearchMindCandidatesInput.Type;

export const ApplyMindConfirmInput = Schema.Struct({
  memoryId: MindMemoryId,
  peakWeight: MindMemory.fields.weight,
  lastAccessedAt: IsoDateTime,
});
export type ApplyMindConfirmInput = typeof ApplyMindConfirmInput.Type;

export const SetMindMemoryPinnedInput = Schema.Struct({
  memoryId: MindMemoryId,
  pinned: Schema.Boolean,
});
export type SetMindMemoryPinnedInput = typeof SetMindMemoryPinnedInput.Type;

export const DeleteMindMemoryInput = Schema.Struct({
  memoryId: MindMemoryId,
});
export type DeleteMindMemoryInput = typeof DeleteMindMemoryInput.Type;

export const AppendMindJournalInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  op: MindJournalOp,
  actor: MindJournalEntry.fields.actor,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type AppendMindJournalInput = typeof AppendMindJournalInput.Type;

export const FindMindJournalOpInput = Schema.Struct({
  memoryId: MindMemoryId,
  op: MindJournalOp,
  turnId: Schema.NullOr(TrimmedNonEmptyString),
});
export type FindMindJournalOpInput = typeof FindMindJournalOpInput.Type;

export const CountMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
});
export type CountMindMemoriesInput = typeof CountMindMemoriesInput.Type;

export const GetMindReceiptInput = Schema.Struct({
  projectId: ProjectId,
  operationId: TrimmedNonEmptyString,
});
export type GetMindReceiptInput = typeof GetMindReceiptInput.Type;

export const PutMindReceiptInput = MindReceiptRow;
export type PutMindReceiptInput = typeof PutMindReceiptInput.Type;

/**
 * Builds a safe FTS5 MATCH expression from raw user text: every whitespace
 * token is double-quoted (internal quotes doubled so they stay literal) and
 * turned into a prefix query with a trailing `*`. Quoting neutralizes FTS5
 * operator syntax (`AND`, `OR`, `NOT`, `NEAR(...)`, column filters), so user
 * text can never inject match operators.
 */
export const buildMindFtsMatchExpr = (query: string): string =>
  query
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");

export interface MindRepositoryShape {
  /**
   * Inserts a new memory row. The `UNIQUE (project_id, text_hash)` constraint
   * is honored, not bypassed: a duplicate insert fails, so dedupe surfaces as
   * a reinforce of the existing row (never a second row).
   */
  readonly insert: (
    input: InsertMindMemoryInput,
  ) => Effect.Effect<MindMemoryRow, MindRepositoryError>;
  readonly findByTextHash: (
    input: FindMindMemoryByTextHashInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  readonly getById: (
    input: GetMindMemoryInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  /**
   * Lists a project's memories pinned-first, then most recently accessed.
   * Callers re-rank by effective weight; this order is the deterministic base.
   */
  readonly listByProject: (
    input: ListMindMemoriesInput,
  ) => Effect.Effect<ReadonlyArray<MindMemoryRow>, MindRepositoryError>;
  /**
   * FTS5 candidate fetch: joins `mind_memories` against `mind_memories_fts`
   * and returns rows with their raw bm25 rank (best first). The match
   * expression must come from {@link buildMindFtsMatchExpr}; it is always a
   * bound parameter, never concatenated SQL.
   */
  readonly searchCandidates: (
    input: SearchMindCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<MindMemoryCandidate>, MindRepositoryError>;
  /**
   * Reinforces a memory: sets the confirmed peak weight, resets the decay
   * anchor, and bumps the access count. Returns none if the memory is gone.
   */
  readonly applyConfirm: (
    input: ApplyMindConfirmInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  readonly setPinned: (
    input: SetMindMemoryPinnedInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  /** Deletes a memory row (FTS sync trigger keeps the index in step). True when a row was deleted. */
  readonly deleteById: (
    input: DeleteMindMemoryInput,
  ) => Effect.Effect<boolean, MindRepositoryError>;
  /** Appends an op-only journal row. Journal rows never carry memory text. */
  readonly appendJournal: (
    input: AppendMindJournalInput,
  ) => Effect.Effect<void, MindRepositoryError>;
  /** Idempotency lookup: the journal row for `(memoryId, op, turnId)`, if any. */
  readonly findJournalOp: (
    input: FindMindJournalOpInput,
  ) => Effect.Effect<Option.Option<MindJournalEntry>, MindRepositoryError>;
  readonly countByProject: (
    input: CountMindMemoriesInput,
  ) => Effect.Effect<number, MindRepositoryError>;
  readonly getReceipt: (
    input: GetMindReceiptInput,
  ) => Effect.Effect<Option.Option<MindReceiptRow>, MindRepositoryError>;
  /**
   * Records an operation receipt. Returns true when this call created the row;
   * false means the `(project_id, operation_id)` receipt already existed and
   * the caller should replay the recorded result instead of re-applying.
   */
  readonly putReceipt: (input: PutMindReceiptInput) => Effect.Effect<boolean, MindRepositoryError>;
}

export class MindRepository extends ServiceMap.Service<MindRepository, MindRepositoryShape>()(
  "synara/persistence/Services/MindRepository",
) {}
