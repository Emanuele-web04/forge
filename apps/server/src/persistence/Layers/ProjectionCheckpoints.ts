import { OrchestrationCheckpointFile } from "@synara/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  GetByThreadAndTurnCountInput,
  ListByThreadIdInput,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  type ProjectionCheckpointRepositoryShape,
} from "../Services/ProjectionCheckpoints.ts";

const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

const makeProjectionCheckpointRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectionCheckpointRows = SqlSchema.findAll({
    Request: ListByThreadIdInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        -- Checkpoint repository rows expose the completed checkpoint contract;
        -- provider-diff placeholders remain readable through ProjectionTurns.
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
          AND completed_at IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getProjectionCheckpointRow = SqlSchema.findOneOption({
    Request: GetByThreadAndTurnCountInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        -- Incomplete provider-diff placeholders do not satisfy ProjectionCheckpoint.
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
          AND completed_at IS NOT NULL
      `,
  });

  const listByThreadId: ProjectionCheckpointRepositoryShape["listByThreadId"] = (input) =>
    listProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.listByThreadId:query",
          "ProjectionCheckpointRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpoint>>),
    );

  const getByThreadAndTurnCount: ProjectionCheckpointRepositoryShape["getByThreadAndTurnCount"] = (
    input,
  ) =>
    getProjectionCheckpointRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:query",
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionCheckpoint>)),
        }),
      ),
    );

  return {
    listByThreadId,
    getByThreadAndTurnCount,
  } satisfies ProjectionCheckpointRepositoryShape;
});

export const ProjectionCheckpointRepositoryLive = Layer.effect(
  ProjectionCheckpointRepository,
  makeProjectionCheckpointRepository,
);
