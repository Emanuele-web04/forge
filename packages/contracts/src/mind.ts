import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const MindMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("MindMemoryId"));
export type MindMemoryId = typeof MindMemoryId.Type;

export const MIND_MEMORY_TEXT_MAX_CHARS = 500;
export const MIND_MEMORY_PROJECT_CAP = 500;
export const MIND_RECALL_MAX_ITEMS = 8;
export const MIND_RECALL_MAX_DIGEST_CHARS = 800;

export const MindMemory = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  text: Schema.String.check(Schema.isMaxLength(MIND_MEMORY_TEXT_MAX_CHARS)),
  weight: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  accessCount: NonNegativeInt,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MindMemory = typeof MindMemory.Type;

export const MindJournalOp = Schema.Literals([
  "remember",
  "reinforce",
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
  turnId: Schema.NullOr(TurnId),
  op: MindJournalOp,
  weightDelta: Schema.optional(Schema.Number),
  createdAt: IsoDateTime,
});
export type MindJournalEntry = typeof MindJournalEntry.Type;

export const MindRememberInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  turnId: Schema.optional(TurnId),
  text: Schema.String.check(Schema.isMaxLength(MIND_MEMORY_TEXT_MAX_CHARS * 2)),
});
export type MindRememberInput = typeof MindRememberInput.Type;

export const MindRememberResult = Schema.Struct({
  memory: MindMemory,
  status: Schema.Literals(["created", "reinforced"]),
});
export type MindRememberResult = typeof MindRememberResult.Type;

export const MindRecallInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.String),
});
export type MindRecallInput = typeof MindRecallInput.Type;

export const MindMemoryMatch = Schema.Struct({
  memory: MindMemory,
  rank: Schema.Number,
  decayedWeight: Schema.Number,
});
export type MindMemoryMatch = typeof MindMemoryMatch.Type;

export const MindRecallResult = Schema.Struct({
  items: Schema.Array(MindMemoryMatch).check(Schema.isMaxLength(MIND_RECALL_MAX_ITEMS)),
  digest: Schema.String.check(Schema.isMaxLength(MIND_RECALL_MAX_DIGEST_CHARS)),
});
export type MindRecallResult = typeof MindRecallResult.Type;

export const MindConfirmInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  turnId: Schema.optional(TurnId),
});
export type MindConfirmInput = typeof MindConfirmInput.Type;

export const MindConfirmResult = Schema.Struct({
  memory: MindMemory,
  alreadyConfirmedInTurn: Schema.Boolean,
});
export type MindConfirmResult = typeof MindConfirmResult.Type;

export const MindForgetInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  turnId: Schema.optional(TurnId),
});
export type MindForgetInput = typeof MindForgetInput.Type;

export const MindForgetResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type MindForgetResult = typeof MindForgetResult.Type;

export const MindPinInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  pinned: Schema.Boolean,
});
export type MindPinInput = typeof MindPinInput.Type;

export const MindPinResult = Schema.Struct({
  memory: MindMemory,
});
export type MindPinResult = typeof MindPinResult.Type;

export const MindPruneInput = Schema.Struct({
  projectId: ProjectId,
});
export type MindPruneInput = typeof MindPruneInput.Type;

export const MindPruneResult = Schema.Struct({
  deletedIds: Schema.Array(MindMemoryId),
});
export type MindPruneResult = typeof MindPruneResult.Type;

export const MindListInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.String),
});
export type MindListInput = typeof MindListInput.Type;

export const MindListResult = Schema.Struct({
  memories: Schema.Array(MindMemory),
});
export type MindListResult = typeof MindListResult.Type;

export class MindError extends Schema.TaggedErrorClass<MindError>()("MindError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export const MindMemoryCapError = Schema.Literal("mind.memory-cap-reached");
export const MindTextTooLongError = Schema.Literal("mind.text-too-long");
export const MindSecretPatternError = Schema.Literal("mind.secret-pattern");
export const MindMemoryNotFoundError = Schema.Literal("mind.memory-not-found");
