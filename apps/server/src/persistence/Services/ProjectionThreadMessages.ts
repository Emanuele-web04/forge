/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  MessageDispatchOrigin,
  OrchestrationMessageRole,
  OrchestrationMessageSource,
  TurnDispatchMode,
  MessageId,
  ProviderMentionReference,
  ProviderSkillReference,
  ThreadId,
  TurnId,
  IsoDateTime,
  NonNegativeInt,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessageTextSegment = Schema.Struct({
  sequence: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  text: Schema.String,
});
export type ProjectionThreadMessageTextSegment = typeof ProjectionThreadMessageTextSegment.Type;

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  textSegments: Schema.optional(Schema.Array(ProjectionThreadMessageTextSegment)),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  isStreaming: Schema.Boolean,
  source: OrchestrationMessageSource,
  /** Server-owned orchestration event sequence for causal ordering. */
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const ProjectionThreadMessageSegmentDbRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sequence: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  text: Schema.String,
});
export type ProjectionThreadMessageSegmentDbRow = typeof ProjectionThreadMessageSegmentDbRow.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by the thread-scoped `(threadId, messageId)` identity.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by its thread-scoped identity.
   */
  readonly getByThreadAndMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending server-owned causal order. Legacy rows without a
   * sequence retain their timestamp order ahead of sequenced rows.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /** Read the newest user-message timestamp used by sidebar summary state. */
  readonly getLatestUserMessageAt: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends ServiceMap.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("synara/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
