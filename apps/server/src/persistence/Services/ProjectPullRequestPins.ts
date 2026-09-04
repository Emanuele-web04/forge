/**
 * Durable project-scoped pull request pins.
 *
 * Repository keys are canonical values supplied by callers. This service owns only
 * persistence and never derives or normalizes repository identity.
 */
import {
  PositiveInt,
  ProjectId,
  PullRequestProvider,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/**
 * A project pin list is intentionally a small "what next" queue rather than a second backlog.
 * Keeping the cap in the persistence service makes it durable across every caller and bounds
 * missing-pin recovery work before any GitHub subprocess is considered.
 */
export const PROJECT_PULL_REQUEST_PIN_LIMIT = 20;

export class ProjectPullRequestPinLimitError extends Schema.TaggedErrorClass<ProjectPullRequestPinLimitError>()(
  "ProjectPullRequestPinLimitError",
  {
    projectId: ProjectId,
    limit: PositiveInt,
  },
) {
  override get message(): string {
    return `A project can pin at most ${this.limit} pull requests.`;
  }
}

export type ProjectPullRequestPinsError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ProjectPullRequestPinLimitError;

export const ProjectPullRequestPin = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProvider,
  repositoryKey: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ProjectPullRequestPin = typeof ProjectPullRequestPin.Type;

export const ListProjectPullRequestPinsByProjectIdsInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId),
});
export type ListProjectPullRequestPinsByProjectIdsInput =
  typeof ListProjectPullRequestPinsByProjectIdsInput.Type;

export const SetProjectPullRequestPinnedInput = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProvider,
  repositoryKey: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type SetProjectPullRequestPinnedInput = typeof SetProjectPullRequestPinnedInput.Type;

export interface ProjectPullRequestPinsShape {
  /** List pins for exactly the requested projects in deterministic identity order. */
  readonly listByProjectIds: (
    input: ListProjectPullRequestPinsByProjectIdsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectPullRequestPin>, ProjectPullRequestPinsError>;

  /** Idempotently establish the requested pin state. */
  readonly setPinned: (
    input: SetProjectPullRequestPinnedInput,
  ) => Effect.Effect<void, ProjectPullRequestPinsError>;
}

export class ProjectPullRequestPins extends ServiceMap.Service<
  ProjectPullRequestPins,
  ProjectPullRequestPinsShape
>()("synara/persistence/Services/ProjectPullRequestPins/ProjectPullRequestPins") {}
