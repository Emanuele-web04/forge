import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ListProjectPullRequestPinsByProjectIdsInput,
  PROJECT_PULL_REQUEST_PIN_LIMIT,
  ProjectPullRequestPin,
  ProjectPullRequestPinLimitError,
  ProjectPullRequestPins,
  type ProjectPullRequestPinsError,
  type ProjectPullRequestPinsShape,
  SetProjectPullRequestPinnedInput,
} from "../Services/ProjectPullRequestPins.ts";

const makeProjectPullRequestPins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listPinRows = SqlSchema.findAll({
    Request: ListProjectPullRequestPinsByProjectIdsInput,
    Result: ProjectPullRequestPin,
    execute: ({ projectIds }) => sql`
      SELECT
        project_id AS "projectId",
        provider,
        repository_key AS "repositoryKey",
        pull_request_number AS "number"
      FROM project_pull_request_pins
      WHERE project_id IN ${sql.in(projectIds)}
      ORDER BY
        project_id ASC,
        provider ASC,
        repository_key ASC,
        pull_request_number ASC
    `,
  });

  const PinCountRow = Schema.Struct({
    count: Schema.Number,
    identityExists: Schema.Number,
  });

  const readProjectPinCount = SqlSchema.findOne({
    Request: SetProjectPullRequestPinnedInput,
    Result: PinCountRow,
    execute: ({ projectId, provider, repositoryKey, number }) => sql`
      SELECT
        COUNT(*) AS "count",
        COALESCE(MAX(
          CASE
            WHEN repository_key = ${repositoryKey}
              AND provider = ${provider}
              AND pull_request_number = ${number}
            THEN 1
            ELSE 0
          END
        ), 0) AS "identityExists"
      FROM project_pull_request_pins
      WHERE project_id = ${projectId}
    `,
  });

  const insertPinRow = SqlSchema.void({
    Request: SetProjectPullRequestPinnedInput,
    execute: ({ projectId, provider, repositoryKey, number }) => sql`
      INSERT INTO project_pull_request_pins (
        project_id,
        provider,
        repository_key,
        pull_request_number
      )
      VALUES (${projectId}, ${provider}, ${repositoryKey}, ${number})
      ON CONFLICT (project_id, provider, repository_key, pull_request_number) DO NOTHING
    `,
  });

  const deletePinRow = SqlSchema.void({
    Request: SetProjectPullRequestPinnedInput,
    execute: ({ projectId, provider, repositoryKey, number }) => sql`
      DELETE FROM project_pull_request_pins
      WHERE project_id = ${projectId}
        AND provider = ${provider}
        AND repository_key = ${repositoryKey}
        AND pull_request_number = ${number}
    `,
  });

  const listByProjectIds: ProjectPullRequestPinsShape["listByProjectIds"] = (input) => {
    if (input.projectIds.length === 0) {
      return Effect.succeed([]);
    }
    return listPinRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectPullRequestPins.listByProjectIds:query",
          "ProjectPullRequestPins.listByProjectIds:decodeRows",
        ),
      ),
    );
  };

  const setPinned: ProjectPullRequestPinsShape["setPinned"] = (input) => {
    // Annotated because the two branches infer distinct Effect types that pipe() cannot
    // reconcile; mapError below funnels every failure into ProjectPullRequestPinsError.
    const operation: Effect.Effect<void | undefined, unknown> = input.isPinned
      ? sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* readProjectPinCount(input);
            if (current.identityExists > 0) return;
            if (current.count >= PROJECT_PULL_REQUEST_PIN_LIMIT) {
              return yield* new ProjectPullRequestPinLimitError({
                projectId: input.projectId,
                limit: PROJECT_PULL_REQUEST_PIN_LIMIT,
              });
            }
            yield* insertPinRow(input);
          }),
        )
      : deletePinRow(input);

    return operation.pipe(
      Effect.mapError(
        (cause): ProjectPullRequestPinsError =>
          cause instanceof ProjectPullRequestPinLimitError
            ? cause
            : toPersistenceSqlOrDecodeError(
                "ProjectPullRequestPins.setPinned:query",
                "ProjectPullRequestPins.setPinned:encodeRequest",
              )(cause),
      ),
    );
  };

  return { listByProjectIds, setPinned } satisfies ProjectPullRequestPinsShape;
});

export const ProjectPullRequestPinsLive = Layer.effect(
  ProjectPullRequestPins,
  makeProjectPullRequestPins,
);
