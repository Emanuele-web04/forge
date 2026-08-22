import {
  ChatAttachment,
  MessageDispatchOrigin,
  NonNegativeInt,
  ProviderMentionReference,
  ProviderSkillReference,
  TurnDispatchMode,
  type OrchestrationMessage,
} from "@synara/contracts";
import { Schema, Struct } from "effect";

import {
  ProjectionThreadMessage,
  type ProjectionThreadMessage as ProjectionThreadMessageRecord,
} from "./Services/ProjectionThreadMessages.ts";

export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    skills: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProviderSkillReference))),
    mentions: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProviderMentionReference))),
    dispatchMode: Schema.NullOr(TurnDispatchMode),
    dispatchOrigin: Schema.NullOr(MessageDispatchOrigin),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

export type ProjectionThreadMessageDbRow = Schema.Schema.Type<
  typeof ProjectionThreadMessageDbRowSchema
>;

export function projectionThreadMessageFromRow(
  row: ProjectionThreadMessageDbRow,
): ProjectionThreadMessageRecord {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    ...(row.textSegments !== undefined ? { textSegments: row.textSegments } : {}),
    isStreaming: row.isStreaming === 1,
    source: row.source,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.mentions !== null ? { mentions: row.mentions } : {}),
    ...(row.dispatchMode ? { dispatchMode: row.dispatchMode } : {}),
    ...(row.dispatchOrigin ? { dispatchOrigin: row.dispatchOrigin } : {}),
  };
}

export function orchestrationMessageFromProjectionRow(
  row: ProjectionThreadMessageDbRow,
): OrchestrationMessage {
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    ...(row.textSegments !== undefined ? { textSegments: row.textSegments } : {}),
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.mentions !== null ? { mentions: row.mentions } : {}),
    ...(row.dispatchMode ? { dispatchMode: row.dispatchMode } : {}),
    ...(row.dispatchOrigin ? { dispatchOrigin: row.dispatchOrigin } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
