import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
  type ProjectionRepositoryError,
} from "../Errors.ts";
import {
  ProjectionThreadMessageDbRowSchema,
  projectionThreadMessageFromRow,
  type ProjectionThreadMessageDbRow,
} from "../projectionThreadMessageRow.ts";
import {
  GetProjectionThreadMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
  ProjectionThreadMessageSegmentDbRow,
  type ProjectionThreadMessageTextSegment,
} from "../Services/ProjectionThreadMessages.ts";

const LatestUserMessageAtRowSchema = Schema.Struct({
  latestUserMessageAt: Schema.String,
});

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextSkillsJson = row.skills !== undefined ? JSON.stringify(row.skills) : null;
      const nextMentionsJson = row.mentions !== undefined ? JSON.stringify(row.mentions) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          skills_json,
          mentions_json,
          dispatch_mode,
          dispatch_origin,
          is_streaming,
          source,
          sequence,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          ${nextAttachmentsJson},
          ${nextSkillsJson},
          ${nextMentionsJson},
          ${row.dispatchMode ?? null},
          ${row.dispatchOrigin ?? null},
          ${row.isStreaming ? 1 : 0},
          ${row.source},
          ${row.sequence ?? null},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id, message_id)
        DO UPDATE SET
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          skills_json = COALESCE(
            excluded.skills_json,
            projection_thread_messages.skills_json
          ),
          mentions_json = COALESCE(
            excluded.mentions_json,
            projection_thread_messages.mentions_json
          ),
          dispatch_mode = COALESCE(
            excluded.dispatch_mode,
            projection_thread_messages.dispatch_mode
          ),
          dispatch_origin = COALESCE(
            excluded.dispatch_origin,
            projection_thread_messages.dispatch_origin
          ),
          is_streaming = excluded.is_streaming,
          source = excluded.source,
          sequence = COALESCE(projection_thread_messages.sequence, excluded.sequence),
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          dispatch_origin AS "dispatchOrigin",
          is_streaming AS "isStreaming",
          source,
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          message_id ASC
      `,
  });

  const getLatestProjectionThreadUserMessageAtRow = SqlSchema.findOneOption({
    Request: ListProjectionThreadMessagesInput,
    Result: LatestUserMessageAtRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          created_at AS "latestUserMessageAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC,
          created_at DESC,
          message_id DESC
        LIMIT 1
      `,
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          dispatch_origin AS "dispatchOrigin",
          is_streaming AS "isStreaming",
          source,
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        LIMIT 1
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteMessageTextSegmentRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM message_text_segments
        WHERE thread_id = ${threadId}
      `,
  });

  const listMessageTextSegmentRowsQuery = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageSegmentDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          sequence,
          started_at AS "startedAt",
          ended_at AS "endedAt",
          text
        FROM message_text_segments
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC, message_id ASC
      `,
  });

  const getMessageTextSegmentRowsQuery = SqlSchema.findAll({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageSegmentDbRow,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          sequence,
          started_at AS "startedAt",
          ended_at AS "endedAt",
          text
        FROM message_text_segments
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        ORDER BY sequence ASC
      `,
  });

  const listMessageTextSegmentRows = (
    input: ListProjectionThreadMessagesInput,
  ): Effect.Effect<
    ReadonlyArray<ProjectionThreadMessageSegmentDbRow>,
    ProjectionRepositoryError,
    never
  > =>
    listMessageTextSegmentRowsQuery(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadMessageRepository.listMessageTextSegments:query",
          "ProjectionThreadMessageRepository.listMessageTextSegments:decodeRows",
        ),
      ),
    );

  const attachTextSegmentsToRows = (
    rows: ReadonlyArray<ProjectionThreadMessageDbRow>,
    segments: ReadonlyArray<ProjectionThreadMessageSegmentDbRow>,
  ): ReadonlyArray<ProjectionThreadMessageDbRow> => {
    if (segments.length === 0) {
      return rows;
    }
    const segmentsByMessage = new Map<string, ProjectionThreadMessageTextSegment[]>();
    for (const segment of segments) {
      const key = JSON.stringify([segment.threadId, segment.messageId]);
      const existing = segmentsByMessage.get(key);
      const entry = {
        sequence: segment.sequence,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        text: segment.text,
      };
      if (existing) {
        existing.push(entry);
      } else {
        segmentsByMessage.set(key, [entry]);
      }
    }
    return rows.map((row) => {
      const rowSegments = segmentsByMessage.get(JSON.stringify([row.threadId, row.messageId]));
      return rowSegments ? { ...row, textSegments: rowSegments } : row;
    });
  };

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const getByThreadAndMessageId: ProjectionThreadMessageRepositoryShape["getByThreadAndMessageId"] =
    (input) =>
      getProjectionThreadMessageRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadMessageRepository.getByThreadAndMessageId:query"),
        ),
        Effect.flatMap((row) =>
          getMessageTextSegmentRowsQuery(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionThreadMessageRepository.getMessageTextSegments:query",
                "ProjectionThreadMessageRepository.getMessageTextSegments:decodeRows",
              ),
            ),
            Effect.map((segments) =>
              Option.map(row, (messageRow) =>
                projectionThreadMessageFromRow(
                  attachTextSegmentsToRows([messageRow], segments)[0]!,
                ),
              ),
            ),
          ),
        ),
      );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.flatMap((rows) =>
        listMessageTextSegmentRows(input).pipe(
          Effect.map((segments) =>
            attachTextSegmentsToRows(rows, segments).map(projectionThreadMessageFromRow),
          ),
        ),
      ),
    );

  const getLatestUserMessageAt: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAt"] = (
    input,
  ) =>
    getLatestProjectionThreadUserMessageAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageAt:query"),
      ),
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.latestUserMessageAt })),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.flatMap(() => deleteMessageTextSegmentRows(input)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadAndMessageId,
    listByThreadId,
    getLatestUserMessageAt,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
