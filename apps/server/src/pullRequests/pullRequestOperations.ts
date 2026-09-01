import type { OrchestrationProject, PullRequestProvider } from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";

import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { PullRequestCapabilityError } from "./Errors";
import type {
  PullRequestProviderRegistryShape,
  PullRequestProviderShape,
} from "./Services/PullRequestProvider";
import type { PullRequestServiceShape } from "./Services/PullRequestService";

type PullRequestOperations = Pick<
  PullRequestServiceShape,
  "detail" | "diff" | "action" | "comment" | "setPinned"
>;

export function makePullRequestOperations(dependencies: {
  providers: PullRequestProviderRegistryShape;
  pins: ProjectPullRequestPinsShape;
  findProject: (
    projectId: Parameters<PullRequestServiceShape["detail"]>[0]["projectId"],
  ) => Effect.Effect<OrchestrationProject, unknown>;
  validateRepository: (
    provider: PullRequestProvider,
    repository: string,
  ) => Effect.Effect<string, Error>;
  resolveProjectRepository: (
    project: OrchestrationProject,
    provider: PullRequestProvider,
    repository: string,
  ) => Effect.Effect<RemoteRepositoryRef, unknown>;
}): PullRequestOperations {
  const resolveOperation = (
    project: OrchestrationProject,
    provider: PullRequestProvider,
    repository: string,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* dependencies.resolveProjectRepository(project, provider, repository);
      const adapter = yield* dependencies.providers.select(resolved);
      return { adapter, repository: resolved };
    });

  const requireOperation = <K extends "action" | "comment">(
    adapter: PullRequestProviderShape,
    operation: K,
    capability: "merge" | "stateMutation" | "comment",
  ): Effect.Effect<NonNullable<PullRequestProviderShape[K]>, PullRequestCapabilityError> => {
    const implementation = adapter[operation];
    return adapter.provider !== "bitbucket" && implementation
      ? Effect.succeed(implementation as NonNullable<PullRequestProviderShape[K]>)
      : Effect.fail(new PullRequestCapabilityError({ provider: adapter.provider, capability }));
  };

  const detail: PullRequestServiceShape["detail"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const { adapter, repository } = yield* resolveOperation(
        project,
        input.provider ?? "github",
        input.repository,
      );
      return yield* adapter.detail({ project, repository, number: input.number });
    });

  const diff: PullRequestServiceShape["diff"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const { adapter, repository } = yield* resolveOperation(
        project,
        input.provider ?? "github",
        input.repository,
      );
      return yield* adapter.diff({ project, repository, number: input.number });
    });

  const action: PullRequestServiceShape["action"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const { adapter, repository } = yield* resolveOperation(
        project,
        input.provider ?? "github",
        input.repository,
      );
      const runAction = yield* requireOperation(
        adapter,
        "action",
        input.action === "merge" ? "merge" : "stateMutation",
      );
      return yield* runAction({
        project,
        repository,
        number: input.number,
        action: input.action,
        ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
      });
    });

  const comment: PullRequestServiceShape["comment"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const { adapter, repository } = yield* resolveOperation(
        project,
        input.provider ?? "github",
        input.repository,
      );
      const runComment = yield* requireOperation(adapter, "comment", "comment");
      return yield* runComment({
        project,
        repository,
        number: input.number,
        body: input.body,
      });
    });

  const setPinned: PullRequestServiceShape["setPinned"] = (input) =>
    Effect.gen(function* () {
      const provider = input.provider ?? "github";
      const project = yield* dependencies.findProject(input.projectId);
      // Clearing an orphaned pin intentionally requires only a valid canonical repository key.
      const repository = yield* input.isPinned
        ? dependencies
            .resolveProjectRepository(project, provider, input.repository)
            .pipe(Effect.map((resolved) => resolved.displayName))
        : dependencies.validateRepository(provider, input.repository);
      yield* dependencies.pins.setPinned({
        projectId: project.id,
        provider,
        repositoryKey: repository.toLowerCase(),
        number: input.number,
        isPinned: input.isPinned,
      });
      return {
        projectId: project.id,
        provider,
        repository,
        number: input.number,
        isPinned: input.isPinned,
      };
    });

  return { detail, diff, action, comment, setPinned };
}
