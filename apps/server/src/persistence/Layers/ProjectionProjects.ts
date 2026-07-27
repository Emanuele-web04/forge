import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

import { ModelSelection, ProjectRemote, ProjectScript } from "@synara/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ClearProjectionProjectSpaceAssignmentsInput,
  DeleteProjectionProjectInput,
  GetProjectionProjectInput,
  ProjectionProject,
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../Services/ProjectionProjects.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const ProjectionProjectDbRow = ProjectionProject.mapFields(
  Struct.assign({
    remote: Schema.NullOr(Schema.fromJsonString(ProjectRemote)),
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    isPinned: SqliteBoolean,
  }),
);
type ProjectionProjectDbRow = typeof ProjectionProjectDbRow.Type;

const makeProjectionProjectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectRow = SqlSchema.void({
    Request: ProjectionProject,
    execute: (row) =>
      sql`
        INSERT INTO projection_projects (
          project_id,
          kind,
          title,
          workspace_root,
          remote_json,
          default_model_selection_json,
          scripts_json,
          is_pinned,
          space_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.projectId},
          ${row.kind},
          ${row.title},
          ${row.workspaceRoot},
          ${row.remote != null ? JSON.stringify(row.remote) : null},
          ${row.defaultModelSelection !== null ? JSON.stringify(row.defaultModelSelection) : null},
          ${JSON.stringify(row.scripts)},
          ${row.isPinned ? 1 : 0},
          ${row.spaceId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          remote_json = excluded.remote_json,
          default_model_selection_json = excluded.default_model_selection_json,
          scripts_json = excluded.scripts_json,
          is_pinned = excluded.is_pinned,
          space_id = excluded.space_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionProjectRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectInput,
    Result: ProjectionProjectDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          remote_json AS "remote",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          is_pinned AS "isPinned",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listProjectionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          remote_json AS "remote",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          is_pinned AS "isPinned",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const deleteProjectionProjectRow = SqlSchema.void({
    Request: DeleteProjectionProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const clearProjectionProjectSpaceAssignments = SqlSchema.void({
    Request: ClearProjectionProjectSpaceAssignmentsInput,
    execute: ({ spaceId, updatedAt }) =>
      sql`
        UPDATE projection_projects
        SET
          space_id = NULL,
          updated_at = CASE WHEN updated_at > ${updatedAt} THEN updated_at ELSE ${updatedAt} END
        WHERE space_id = ${spaceId}
      `,
  });

  const upsert: ProjectionProjectRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.upsert:query")),
    );

  const getById: ProjectionProjectRepositoryShape["getById"] = (input) =>
    getProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.getById:query")),
    );

  const listAll: ProjectionProjectRepositoryShape["listAll"] = () =>
    listProjectionProjectRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.listAll:query")),
    );

  const deleteById: ProjectionProjectRepositoryShape["deleteById"] = (input) =>
    deleteProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.deleteById:query")),
    );

  const clearSpaceAssignments: ProjectionProjectRepositoryShape["clearSpaceAssignments"] = (
    input,
  ) =>
    clearProjectionProjectSpaceAssignments(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectRepository.clearSpaceAssignments:query"),
      ),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
    clearSpaceAssignments,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
