/**
 * ProjectionCheckpointRepository - Projection repository interface for checkpoints.
 *
 * Owns persistence operations for projected checkpoint summaries in thread
 * timelines.
 *
 * @module ProjectionCheckpointRepository
 */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Option, ServiceMap, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionCheckpoint = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;

export const ListByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListByThreadIdInput = typeof ListByThreadIdInput.Type;

export const GetByThreadAndTurnCountInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
export type GetByThreadAndTurnCountInput = typeof GetByThreadAndTurnCountInput.Type;

/**
 * ProjectionCheckpointRepositoryShape - Service API for projected checkpoints.
 */
export interface ProjectionCheckpointRepositoryShape {
  /**
   * List projected checkpoints for a thread.
   *
   * Returned in ascending checkpoint turn-count order.
   */
  readonly listByThreadId: (
    input: ListByThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCheckpoint>, ProjectionRepositoryError>;

  /**
   * Read a projected checkpoint by thread and turn-count key.
   */
  readonly getByThreadAndTurnCount: (
    input: GetByThreadAndTurnCountInput,
  ) => Effect.Effect<Option.Option<ProjectionCheckpoint>, ProjectionRepositoryError>;

}

/**
 * ProjectionCheckpointRepository - Service tag for checkpoint projection persistence.
 */
export class ProjectionCheckpointRepository extends ServiceMap.Service<
  ProjectionCheckpointRepository,
  ProjectionCheckpointRepositoryShape
>()("synara/persistence/Services/ProjectionCheckpoints/ProjectionCheckpointRepository") {}
