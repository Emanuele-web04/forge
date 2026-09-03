import {
  AutomationCancelRunInput,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationDisabledReason,
  AutomationId,
  AutomationListInput,
  AutomationListResult,
  AutomationMarkRunReadInput,
  AutomationMemory,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationRunResult,
  AutomationRunId,
  AutomationTrigger,
  CommandId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AutomationRepositoryError } from "../Errors.ts";

export const CreateAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
  input: AutomationCreateInput,
  now: Schema.String,
  nextRunAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CreateAutomationDefinitionInput = typeof CreateAutomationDefinitionInput.Type;

export interface SaveAutomationDefinitionInput {
  readonly definition: AutomationDefinition;
  readonly expectedUpdatedAt: string;
}

export const GetAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
});
export type GetAutomationDefinitionInput = typeof GetAutomationDefinitionInput.Type;

export const ListDueAutomationDefinitionsInput = Schema.Struct({
  now: Schema.String,
  limit: Schema.Number,
});
export type ListDueAutomationDefinitionsInput = typeof ListDueAutomationDefinitionsInput.Type;

export const SetAutomationDefinitionNextRunAtInput = Schema.Struct({
  id: AutomationId,
  nextRunAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type SetAutomationDefinitionNextRunAtInput =
  typeof SetAutomationDefinitionNextRunAtInput.Type;

export const AttachAutomationDefinitionThreadInput = Schema.Struct({
  id: AutomationId,
  threadId: ThreadId,
  updatedAt: Schema.String,
});
export type AttachAutomationDefinitionThreadInput =
  typeof AttachAutomationDefinitionThreadInput.Type;

export const RestartAutomationDefinitionLoopInput = Schema.Struct({
  id: AutomationId,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type RestartAutomationDefinitionLoopInput = typeof RestartAutomationDefinitionLoopInput.Type;

export const ArchiveAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
  archivedAt: Schema.String,
});
export type ArchiveAutomationDefinitionInput = typeof ArchiveAutomationDefinitionInput.Type;

export const ResolvePendingAutomationProposalInput = Schema.Struct({
  id: AutomationId,
  resolution: Schema.Literals(["accepted", "dismissed"]),
  nextRunAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});
export type ResolvePendingAutomationProposalInput =
  typeof ResolvePendingAutomationProposalInput.Type;

export const CreateAutomationRunInput = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.optional(Schema.NullOr(MessageId)).pipe(Schema.withDecodingDefault(() => null)),
  threadCreateCommandId: Schema.optional(Schema.NullOr(CommandId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  turnStartCommandId: Schema.optional(Schema.NullOr(CommandId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  trigger: AutomationTrigger,
  scheduledFor: Schema.String,
  deferredUntil: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  permissionSnapshot: AutomationPermissionSnapshot,
  now: Schema.String,
});
export type CreateAutomationRunInput = typeof CreateAutomationRunInput.Type;

export const GetAutomationMemoryInput = Schema.Struct({
  automationId: AutomationId,
});
export type GetAutomationMemoryInput = typeof GetAutomationMemoryInput.Type;

export const UpsertAutomationMemoryInput = Schema.Struct({
  automationId: AutomationId,
  content: AutomationMemory.fields.content,
  updatedAt: Schema.String,
});
export type UpsertAutomationMemoryInput = typeof UpsertAutomationMemoryInput.Type;

export const SetAutomationRunDeferredInput = Schema.Struct({
  id: AutomationRunId,
  deferredUntil: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type SetAutomationRunDeferredInput = typeof SetAutomationRunDeferredInput.Type;

export const GetDeferredAutomationRunInput = Schema.Struct({
  automationId: AutomationId,
});
export type GetDeferredAutomationRunInput = typeof GetDeferredAutomationRunInput.Type;

export const ListDueDeferredAutomationRunsInput = Schema.Struct({
  now: Schema.String,
  limit: Schema.Number,
});
export type ListDueDeferredAutomationRunsInput = typeof ListDueDeferredAutomationRunsInput.Type;

export const ListAutomationRunsForDefinitionInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.Number,
});
export type ListAutomationRunsForDefinitionInput = typeof ListAutomationRunsForDefinitionInput.Type;

export const GetLatestFinishedAutomationRunInput = Schema.Struct({
  automationId: AutomationId,
});
export type GetLatestFinishedAutomationRunInput = typeof GetLatestFinishedAutomationRunInput.Type;

export const GetAutomationRunInput = Schema.Struct({
  id: AutomationRunId,
});
export type GetAutomationRunInput = typeof GetAutomationRunInput.Type;

export const MarkAutomationRunStartedInput = Schema.Struct({
  id: AutomationRunId,
  threadId: ThreadId,
  messageId: MessageId,
  threadCreateCommandId: Schema.NullOr(CommandId),
  turnStartCommandId: CommandId,
  startedAt: Schema.String,
});
export type MarkAutomationRunStartedInput = typeof MarkAutomationRunStartedInput.Type;

export const ReserveDeferredAutomationRunInput = Schema.Struct({
  id: AutomationRunId,
  threadId: ThreadId,
  reservedAt: Schema.String,
});
export type ReserveDeferredAutomationRunInput = typeof ReserveDeferredAutomationRunInput.Type;

export const MarkAutomationRunFailedInput = Schema.Struct({
  id: AutomationRunId,
  error: Schema.String,
  finishedAt: Schema.String,
});
export type MarkAutomationRunFailedInput = typeof MarkAutomationRunFailedInput.Type;

export interface MarkAutomationRunFailedResult {
  readonly run: AutomationRun;
  readonly transitioned: boolean;
  readonly failureAccounting: Option.Option<RecordAutomationDefinitionRunFailureResult>;
}

export const MarkAutomationRunSkippedInput = Schema.Struct({
  id: AutomationRunId,
  reason: Schema.String,
  finishedAt: Schema.String,
});
export type MarkAutomationRunSkippedInput = typeof MarkAutomationRunSkippedInput.Type;

export const MarkAutomationRunSucceededInput = Schema.Struct({
  id: AutomationRunId,
  turnId: Schema.NullOr(TurnId),
  result: Schema.NullOr(AutomationRunResult),
  finishedAt: Schema.String,
  accountedAt: Schema.String,
});
export type MarkAutomationRunSucceededInput = typeof MarkAutomationRunSucceededInput.Type;

export interface MarkAutomationRunSucceededResult {
  readonly run: AutomationRun;
  readonly transitioned: boolean;
  readonly failureCountReset: boolean;
}

export const MarkAutomationRunResultInput = Schema.Struct({
  id: AutomationRunId,
  result: Schema.NullOr(AutomationRunResult),
  updatedAt: Schema.String,
});
export type MarkAutomationRunResultInput = typeof MarkAutomationRunResultInput.Type;

export const MarkAutomationRunInterruptedInput = Schema.Struct({
  id: AutomationRunId,
  turnId: Schema.NullOr(TurnId),
  finishedAt: Schema.String,
});
export type MarkAutomationRunInterruptedInput = typeof MarkAutomationRunInterruptedInput.Type;

export const MarkAutomationRunWaitingForApprovalInput = Schema.Struct({
  id: AutomationRunId,
  turnId: Schema.NullOr(TurnId),
  updatedAt: Schema.String,
});
export type MarkAutomationRunWaitingForApprovalInput =
  typeof MarkAutomationRunWaitingForApprovalInput.Type;

export const GetAutomationRunByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetAutomationRunByThreadInput = typeof GetAutomationRunByThreadInput.Type;

export const ListRecoverableAutomationRunsInput = Schema.Struct({
  limit: Schema.Number,
  afterCreatedAt: Schema.optional(Schema.String),
  afterRunId: Schema.optional(AutomationRunId),
});
export type ListRecoverableAutomationRunsInput = typeof ListRecoverableAutomationRunsInput.Type;

export const ListAutomationRunsNeedingCompletionEvaluationInput = Schema.Struct({
  limit: Schema.Number,
});
export type ListAutomationRunsNeedingCompletionEvaluationInput =
  typeof ListAutomationRunsNeedingCompletionEvaluationInput.Type;

export const CountActiveAutomationRunsInput = Schema.Struct({
  automationId: AutomationId,
});
export type CountActiveAutomationRunsInput = typeof CountActiveAutomationRunsInput.Type;

export const CountActiveAutomationRunsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type CountActiveAutomationRunsByThreadInput =
  typeof CountActiveAutomationRunsByThreadInput.Type;

export const CountPendingCompletionEvaluationsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type CountPendingCompletionEvaluationsByThreadInput =
  typeof CountPendingCompletionEvaluationsByThreadInput.Type;

export const ListActiveAutomationRunsForDefinitionInput = Schema.Struct({
  automationId: AutomationId,
});
export type ListActiveAutomationRunsForDefinitionInput =
  typeof ListActiveAutomationRunsForDefinitionInput.Type;

export const GetEarliestAutomationNextRunAtInput = Schema.Struct({
  now: Schema.optional(Schema.String),
});
export type GetEarliestAutomationNextRunAtInput = typeof GetEarliestAutomationNextRunAtInput.Type;

export const DisableAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
  now: Schema.String,
  reason: AutomationDisabledReason,
});
export type DisableAutomationDefinitionInput = typeof DisableAutomationDefinitionInput.Type;

export const DisableAutomationDefinitionIfUnchangedInput = Schema.Struct({
  id: AutomationId,
  expectedUpdatedAt: Schema.String,
  now: Schema.String,
  reason: AutomationDisabledReason,
});
export type DisableAutomationDefinitionIfUnchangedInput =
  typeof DisableAutomationDefinitionIfUnchangedInput.Type;

export const RecordAutomationDefinitionRunFailureInput = Schema.Struct({
  id: AutomationId,
  now: Schema.String,
});
export type RecordAutomationDefinitionRunFailureInput =
  typeof RecordAutomationDefinitionRunFailureInput.Type;

export const RecordAutomationDefinitionRunFailureResult = Schema.Struct({
  // Not the contract field: that one is optional with a decoding default for stale
  // client caches, while a RETURNING row always carries the incremented count.
  consecutiveFailureCount: NonNegativeInt,
  autoDisabled: Schema.Boolean,
});
export type RecordAutomationDefinitionRunFailureResult =
  typeof RecordAutomationDefinitionRunFailureResult.Type;

export const ResetAutomationDefinitionFailureCountInput = Schema.Struct({
  id: AutomationId,
  now: Schema.String,
});
export type ResetAutomationDefinitionFailureCountInput =
  typeof ResetAutomationDefinitionFailureCountInput.Type;

export const IncrementAutomationIterationInput = Schema.Struct({
  id: AutomationId,
  now: Schema.String,
});
export type IncrementAutomationIterationInput = typeof IncrementAutomationIterationInput.Type;

export const AcquireAutomationSchedulerLeaseInput = Schema.Struct({
  leaseKey: Schema.String,
  ownerId: Schema.String,
  now: Schema.String,
  leaseExpiresAt: Schema.String,
});
export type AcquireAutomationSchedulerLeaseInput = typeof AcquireAutomationSchedulerLeaseInput.Type;

export interface AutomationRepositoryShape {
  readonly createDefinition: (
    input: CreateAutomationDefinitionInput,
  ) => Effect.Effect<AutomationDefinition, AutomationRepositoryError>;
  readonly saveDefinition: (
    input: SaveAutomationDefinitionInput,
  ) => Effect.Effect<Option.Option<AutomationDefinition>, AutomationRepositoryError>;
  readonly resolvePendingProposal: (
    input: ResolvePendingAutomationProposalInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
  readonly getDefinitionById: (
    input: GetAutomationDefinitionInput,
  ) => Effect.Effect<Option.Option<AutomationDefinition>, AutomationRepositoryError>;
  readonly listDueDefinitions: (
    input: ListDueAutomationDefinitionsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationDefinition>, AutomationRepositoryError>;
  readonly setDefinitionNextRunAt: (
    input: SetAutomationDefinitionNextRunAtInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  /**
   * Claim the thread a dedicated automation owns from now on. Succeeds only while the
   * definition still has no continuation thread, so two concurrent first runs can never
   * leave the automation pointing at the loser's thread.
   */
  readonly attachDefinitionThread: (
    input: AttachAutomationDefinitionThreadInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
  readonly archiveDefinition: (
    input: ArchiveAutomationDefinitionInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly list: (
    input?: AutomationListInput,
  ) => Effect.Effect<AutomationListResult, AutomationRepositoryError>;
  readonly createRun: (
    input: CreateAutomationRunInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  /** Atomically inserts a fresh run, claims the definition, and advances its schedule. */
  readonly createRunAndIncrementDefinition: (
    input: CreateAutomationRunInput,
    scheduleAdvance?: {
      readonly nextRunAt: string | null;
      readonly disable: boolean;
      readonly expectedDefinitionUpdatedAt: string;
      readonly consumeIteration?: boolean;
    },
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly getRunById: (
    input: GetAutomationRunInput,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly getDeferredRunForDefinition: (
    input: GetDeferredAutomationRunInput,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly listDueDeferredRuns: (
    input: ListDueDeferredAutomationRunsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  readonly listRunsForDefinition: (
    input: ListAutomationRunsForDefinitionInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  readonly getLatestFinishedRunForDefinition: (
    input: GetLatestFinishedAutomationRunInput,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly setRunDeferred: (
    input: SetAutomationRunDeferredInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunStarted: (
    input: MarkAutomationRunStartedInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  /**
   * Atomically assigns a deferred heartbeat to its target thread when no other
   * active automation run currently owns that thread.
   */
  readonly reserveDeferredRun: (
    input: ReserveDeferredAutomationRunInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
  readonly markRunFailed: (
    input: MarkAutomationRunFailedInput,
  ) => Effect.Effect<MarkAutomationRunFailedResult, AutomationRepositoryError>;
  readonly markRunSkipped: (
    input: MarkAutomationRunSkippedInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunSucceeded: (
    input: MarkAutomationRunSucceededInput,
  ) => Effect.Effect<MarkAutomationRunSucceededResult, AutomationRepositoryError>;
  readonly markRunResult: (
    input: MarkAutomationRunResultInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  /**
   * Like {@link markRunResult}, but preserves the run's triage fields
   * (`archivedAt`/`unread`) from the current row instead of from the supplied
   * result. Background result updates must not clobber a concurrent user
   * archive/mark-read, so this write merges those fields atomically in SQL.
   */
  readonly markRunResultPreservingTriage: (
    input: MarkAutomationRunResultInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunInterrupted: (
    input: MarkAutomationRunInterruptedInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunWaitingForApproval: (
    input: MarkAutomationRunWaitingForApprovalInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly cancelRun: (
    input: AutomationCancelRunInput & { readonly now: string },
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  /** Returns the newest active run for a thread; terminal history rows are intentionally ignored. */
  readonly getRunByThreadId: (
    input: GetAutomationRunByThreadInput,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly listRecoverableRuns: (
    input: ListRecoverableAutomationRunsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  readonly listRunsNeedingCompletionEvaluation: (
    input: ListAutomationRunsNeedingCompletionEvaluationInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  readonly countActiveRunsForDefinition: (
    input: CountActiveAutomationRunsInput,
  ) => Effect.Effect<number, AutomationRepositoryError>;
  readonly countActiveRunsForThread: (
    input: CountActiveAutomationRunsByThreadInput,
  ) => Effect.Effect<number, AutomationRepositoryError>;
  readonly countPendingCompletionEvaluationsForThread: (
    input: CountPendingCompletionEvaluationsByThreadInput,
  ) => Effect.Effect<number, AutomationRepositoryError>;
  readonly listActiveRunsForDefinition: (
    input: ListActiveAutomationRunsForDefinitionInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  readonly getEarliestNextRunAt: (
    input?: GetEarliestAutomationNextRunAtInput,
  ) => Effect.Effect<string | null, AutomationRepositoryError>;
  readonly markRunRead: (
    input: AutomationMarkRunReadInput & { readonly now: string },
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly archiveRun: (
    input: AutomationArchiveRunInput & { readonly now: string },
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly getMemory: (
    input: GetAutomationMemoryInput,
  ) => Effect.Effect<Option.Option<AutomationMemory>, AutomationRepositoryError>;
  readonly upsertMemory: (
    input: UpsertAutomationMemoryInput,
  ) => Effect.Effect<AutomationMemory, AutomationRepositoryError>;
  readonly getOrCreateInstallSalt: () => Effect.Effect<string, AutomationRepositoryError>;
  readonly disableDefinition: (
    input: DisableAutomationDefinitionInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly disableDefinitionIfUnchanged: (
    input: DisableAutomationDefinitionIfUnchangedInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
  readonly recordDefinitionRunFailure: (
    input: RecordAutomationDefinitionRunFailureInput,
  ) => Effect.Effect<
    Option.Option<RecordAutomationDefinitionRunFailureResult>,
    AutomationRepositoryError
  >;
  readonly resetDefinitionFailureCount: (
    input: ResetAutomationDefinitionFailureCountInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
  readonly incrementDefinitionIterationCount: (
    input: IncrementAutomationIterationInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly restartDefinitionLoop: (
    input: RestartAutomationDefinitionLoopInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly tryAcquireSchedulerLease: (
    input: AcquireAutomationSchedulerLeaseInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
}

export class AutomationRepository extends ServiceMap.Service<
  AutomationRepository,
  AutomationRepositoryShape
>()("synara/persistence/Services/AutomationRepository") {}
