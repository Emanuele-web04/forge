import type { OrchestrationEvent } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionStateRepositoryShape } from "../persistence/Services/ProjectionState.ts";

export type ProjectMetadataOrchestrationEvent = Extract<
  OrchestrationEvent,
  { type: "project.created" | "project.meta-updated" | "project.deleted" }
>;

export const PROJECT_METADATA_SNAPSHOT_PROJECTORS = [
  "projection.hot",
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.checkpoints",
] as const;

export const applyProjectMetadataProjection = (input: {
  readonly event: ProjectMetadataOrchestrationEvent;
  readonly projectionProjectRepository: ProjectionProjectRepositoryShape;
}): Effect.Effect<void, ProjectionRepositoryError> =>
  Effect.gen(function* () {
    switch (input.event.type) {
      case "project.created":
        yield* input.projectionProjectRepository.upsert({
          projectId: input.event.payload.projectId,
          kind: input.event.payload.kind ?? "project",
          title: input.event.payload.title,
          workspaceRoot: input.event.payload.workspaceRoot,
          remote: input.event.payload.remote ?? null,
          defaultModelSelection: input.event.payload.defaultModelSelection,
          scripts: input.event.payload.scripts,
          isPinned: input.event.payload.isPinned ?? false,
          spaceId: input.event.payload.spaceId ?? null,
          createdAt: input.event.payload.createdAt,
          updatedAt: input.event.payload.updatedAt,
          deletedAt: null,
        });
        break;

      case "project.meta-updated": {
        const existingRow = yield* input.projectionProjectRepository.getById({
          projectId: input.event.payload.projectId,
        });
        if (Option.isSome(existingRow)) {
          yield* input.projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(input.event.payload.kind !== undefined ? { kind: input.event.payload.kind } : {}),
            ...(input.event.payload.title !== undefined
              ? { title: input.event.payload.title }
              : {}),
            ...(input.event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: input.event.payload.workspaceRoot }
              : {}),
            ...(input.event.payload.remote !== undefined
              ? { remote: input.event.payload.remote }
              : {}),
            ...(input.event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: input.event.payload.defaultModelSelection }
              : {}),
            ...(input.event.payload.scripts !== undefined
              ? { scripts: input.event.payload.scripts }
              : {}),
            ...(input.event.payload.isPinned !== undefined
              ? { isPinned: input.event.payload.isPinned }
              : {}),
            ...(input.event.payload.spaceId !== undefined
              ? { spaceId: input.event.payload.spaceId }
              : {}),
            updatedAt: input.event.payload.updatedAt,
          });
        }
        break;
      }

      case "project.deleted": {
        const existingRow = yield* input.projectionProjectRepository.getById({
          projectId: input.event.payload.projectId,
        });
        if (Option.isSome(existingRow)) {
          yield* input.projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: input.event.payload.deletedAt,
            updatedAt: input.event.payload.deletedAt,
          });
        }
        break;
      }
    }
  });

export const advanceProjectMetadataSnapshotState = (input: {
  readonly event: Pick<OrchestrationEvent, "sequence" | "occurredAt">;
  readonly projectionStateRepository: ProjectionStateRepositoryShape;
}): Effect.Effect<void, ProjectionRepositoryError> =>
  Effect.forEach(
    PROJECT_METADATA_SNAPSHOT_PROJECTORS,
    (projector) =>
      input.projectionStateRepository.upsert({
        projector,
        lastAppliedSequence: input.event.sequence,
        updatedAt: input.event.occurredAt,
      }),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
