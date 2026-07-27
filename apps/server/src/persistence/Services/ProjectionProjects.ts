/**
 * ProjectionProjectRepository - Projection repository interface for projects.
 *
 * Owns persistence operations for project rows in the orchestration projection
 * read model.
 *
 * @module ProjectionProjectRepository
 */
import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ProjectKind,
  ProjectRemote,
  ProjectScript,
  SpaceId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  kind: ProjectKind.pipe(Schema.withDecodingDefault(() => "project")),
  title: Schema.String,
  workspaceRoot: Schema.String,
  remote: Schema.NullOr(ProjectRemote).pipe(Schema.withDecodingDefault(() => null)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  isPinned: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  spaceId: Schema.NullOr(SpaceId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProject = typeof ProjectionProject.Type;

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type;

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type;

export const ClearProjectionProjectSpaceAssignmentsInput = Schema.Struct({
  spaceId: SpaceId,
  updatedAt: IsoDateTime,
});
export type ClearProjectionProjectSpaceAssignmentsInput =
  typeof ClearProjectionProjectSpaceAssignmentsInput.Type;

/**
 * ProjectionProjectRepositoryShape - Service API for projected project records.
 */
export interface ProjectionProjectRepositoryShape {
  /**
   * Insert or replace a projected project row.
   *
   * Upserts by `projectId` and persists scripts through JSON encoding.
   */
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected project row by id.
   */
  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>;

  /**
   * List all projected project rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProject>,
    ProjectionRepositoryError
  >;

  /**
   * Soft-delete a projected project row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Clear every active or soft-deleted project assignment for a deleted space. */
  readonly clearSpaceAssignments: (
    input: ClearProjectionProjectSpaceAssignmentsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionProjectRepository - Service tag for project projection persistence.
 */
export class ProjectionProjectRepository extends ServiceMap.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()("synara/persistence/Services/ProjectionProjects/ProjectionProjectRepository") {}
