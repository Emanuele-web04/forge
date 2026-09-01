import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const MIND_MEMORY_TEXT_MAX_CHARS = 500;
export const MIND_RECALL_QUERY_MAX_CHARS = 200;
export const MIND_RECALL_REQUEST_MAX_ITEMS = 20;
export const MIND_RECALL_CANDIDATE_MAX_ITEMS = 50;
export const MIND_RECALL_MAX_ITEMS = 8;
export const MIND_RECALL_MAX_DIGEST_CHARS = 800;

export const MindMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("MindMemoryId"));
export type MindMemoryId = typeof MindMemoryId.Type;
export const MindMemoryType = Schema.Literals(["semantic", "episodic", "procedural", "decision"]);
export type MindMemoryType = typeof MindMemoryType.Type;

const UnitWeight = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

export const MindMemory = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  text: Schema.String.check(Schema.isNonEmpty()).check(
    Schema.isMaxLength(MIND_MEMORY_TEXT_MAX_CHARS),
  ),
  type: MindMemoryType,
  weight: UnitWeight,
  accessCount: NonNegativeInt,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
  provenance: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId, provider: ProviderKind }),
    Schema.Struct({ kind: Schema.Literal("user") }),
  ]),
});
export type MindMemory = typeof MindMemory.Type;

export const MindRememberInput = Schema.Struct({
  text: Schema.String.check(Schema.isNonEmpty()).check(
    Schema.isMaxLength(MIND_MEMORY_TEXT_MAX_CHARS),
  ),
  type: MindMemoryType,
});
export type MindRememberInput = typeof MindRememberInput.Type;

export const MindRecallInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(MIND_RECALL_QUERY_MAX_CHARS))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_RECALL_REQUEST_MAX_ITEMS })),
  ),
});
export type MindRecallInput = typeof MindRecallInput.Type;

export const MindJournalOp = Schema.Literals([
  "remember",
  "confirm",
  "forget",
  "pin",
  "unpin",
  "prune",
]);
export type MindJournalOp = typeof MindJournalOp.Type;

export const MindJournalEntry = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  op: MindJournalOp,
  actor: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("agent"), provider: ProviderKind }),
    Schema.Struct({ kind: Schema.Literal("user") }),
  ]),
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type MindJournalEntry = typeof MindJournalEntry.Type;
