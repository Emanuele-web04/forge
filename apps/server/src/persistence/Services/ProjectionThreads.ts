/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  OrchestrationThreadPullRequest,
  ThreadNotes,
  ThreadPinnedMessages,
  ThreadMarkers,
  ThreadHandoff,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadEnvironmentMode,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  envMode: ThreadEnvironmentMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  workingDirectory: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreePath: Schema.NullOr(Schema.String),
  associatedWorktreeBranch: Schema.NullOr(Schema.String),
  associatedWorktreeRef: Schema.NullOr(Schema.String),
  createBranchFlowCompleted: Schema.Boolean,
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  creationSource: Schema.optional(
    Schema.NullOr(Schema.Literals(["synara_mcp", "external_mcp", "provider_native"])),
  ).pipe(Schema.withDecodingDefault(() => null)),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(Schema.withDecodingDefault(() => null)),
  gatewayOperationId: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(Schema.String)),
  subagentNickname: Schema.optional(Schema.NullOr(Schema.String)),
  subagentRole: Schema.optional(Schema.NullOr(Schema.String)),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  sidechatSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  lastKnownPr: Schema.NullOr(OrchestrationThreadPullRequest),
  latestTurnId: Schema.NullOr(TurnId),
  handoff: Schema.NullOr(ThreadHandoff),
  pinnedMessages: Schema.NullOr(ThreadPinnedMessages),
  threadMarkers: Schema.NullOr(ThreadMarkers),
  notes: Schema.NullOr(ThreadNotes),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected thread row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends ServiceMap.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("synara/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
