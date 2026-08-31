import type { ProjectId, ProjectSource, ProjectSourceId } from "@synara/contracts";
import { ProjectSourceId as ProjectSourceIdSchema } from "@synara/contracts";

export function legacyProjectSourceId(projectId: ProjectId): ProjectSourceId {
  return ProjectSourceIdSchema.makeUnsafe(`src-${projectId}`);
}

export function deriveProjectSourcesFromCreated(payload: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly sources?:
    | ReadonlyArray<{ readonly id: ProjectSourceId; readonly path: string }>
    | undefined;
  readonly primarySourceId?: ProjectSourceId | null | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}): { readonly sources: ReadonlyArray<ProjectSource>; readonly primarySourceId: ProjectSourceId } {
  const sources: ReadonlyArray<ProjectSource> =
    payload.sources && payload.sources.length > 0
      ? payload.sources.map((source, sortOrder) => ({
          ...source,
          sortOrder,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
        }))
      : [
          {
            id: legacyProjectSourceId(payload.projectId),
            path: payload.workspaceRoot,
            sortOrder: 0,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
        ];
  return { sources, primarySourceId: payload.primarySourceId ?? sources[0]!.id };
}
