import {
  type MindJournalEntry,
  MindJournalOp,
  MindMemory,
  MindMemoryId,
  ProjectId,
  TurnId,
} from "@synara/contracts";
import { IsoDateTime } from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const RememberMindMemoryInput = Schema.Struct({
  projectId: ProjectId,
  text: MindMemory.fields.text,
  turnId: Schema.optional(TurnId),
  now: IsoDateTime,
});
export type RememberMindMemoryInput = typeof RememberMindMemoryInput.Type;

export const FindMindMemoryByTextInput = Schema.Struct({
  projectId: ProjectId,
  text: Schema.String,
});
export type FindMindMemoryByTextInput = typeof FindMindMemoryByTextInput.Type;

export const GetMindMemoryInput = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
});
export type GetMindMemoryInput = typeof GetMindMemoryInput.Type;

export const RecallMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.String),
});
export type RecallMindMemoriesInput = typeof RecallMindMemoriesInput.Type;

export const ConfirmMindMemoryInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  turnId: Schema.optional(TurnId),
  now: IsoDateTime,
});
export type ConfirmMindMemoryInput = typeof ConfirmMindMemoryInput.Type;

export const ForgetMindMemoryInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  turnId: Schema.optional(TurnId),
});
export type ForgetMindMemoryInput = typeof ForgetMindMemoryInput.Type;

export const PinMindMemoryInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  pinned: Schema.Boolean,
  now: IsoDateTime,
});
export type PinMindMemoryInput = typeof PinMindMemoryInput.Type;

export const ListMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.String),
});
export type ListMindMemoriesInput = typeof ListMindMemoriesInput.Type;

export const CountMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
});
export type CountMindMemoriesInput = typeof CountMindMemoriesInput.Type;

export const PruneMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  now: IsoDateTime,
});
export type PruneMindMemoriesInput = typeof PruneMindMemoriesInput.Type;

export const RecordMindJournalInput = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  turnId: Schema.NullOr(TurnId),
  op: MindJournalOp,
  weightDelta: Schema.optional(Schema.Number),
  createdAt: IsoDateTime,
});
export type RecordMindJournalInput = typeof RecordMindJournalInput.Type;

export type MindRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface MindRepositoryShape {
  readonly remember: (
    input: RememberMindMemoryInput,
  ) => Effect.Effect<typeof MindMemory.Type, MindRepositoryError>;
  readonly findByText: (
    input: FindMindMemoryByTextInput,
  ) => Effect.Effect<Option.Option<typeof MindMemory.Type>, MindRepositoryError>;
  readonly getById: (
    input: GetMindMemoryInput,
  ) => Effect.Effect<Option.Option<typeof MindMemory.Type>, MindRepositoryError>;
  readonly recall: (
    input: RecallMindMemoriesInput,
  ) => Effect.Effect<ReadonlyArray<typeof MindMemory.Type>, MindRepositoryError>;
  readonly confirm: (
    input: ConfirmMindMemoryInput,
  ) => Effect.Effect<typeof MindMemory.Type, MindRepositoryError>;
  readonly forget: (input: ForgetMindMemoryInput) => Effect.Effect<void, MindRepositoryError>;
  readonly pin: (
    input: PinMindMemoryInput,
  ) => Effect.Effect<typeof MindMemory.Type, MindRepositoryError>;
  readonly list: (
    input: ListMindMemoriesInput,
  ) => Effect.Effect<ReadonlyArray<typeof MindMemory.Type>, MindRepositoryError>;
  readonly countByProject: (
    input: CountMindMemoriesInput,
  ) => Effect.Effect<number, MindRepositoryError>;
  readonly prune: (
    input: PruneMindMemoriesInput,
  ) => Effect.Effect<ReadonlyArray<typeof MindMemoryId.Type>, MindRepositoryError>;
  readonly recordJournal: (
    input: RecordMindJournalInput,
  ) => Effect.Effect<void, MindRepositoryError>;
}

export class MindRepository extends ServiceMap.Service<MindRepository, MindRepositoryShape>()(
  "synara/persistence/Services/MindRepository",
) {}

export type { MindJournalEntry, MindJournalOp, MindMemory };
export { MindMemoryId };
