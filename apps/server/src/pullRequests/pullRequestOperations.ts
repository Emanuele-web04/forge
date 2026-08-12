import type { OrchestrationProject, PullRequestDetail } from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import { Effect } from "effect";

import type { GitHubCliShape } from "../git/Services/GitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { isPullRequestMergeMethodAllowed } from "../pullRequests.logic";
import type { PullRequestServiceShape } from "./Services/PullRequestService";

type PullRequestOperations = Pick<
  PullRequestServiceShape,
  "detail" | "diff" | "action" | "comment" | "setPinned"
>;

export function makePullRequestOperations(dependencies: {
  github: GitHubCliShape;
  pins: ProjectPullRequestPinsShape;
  findProject: (
    projectId: Parameters<PullRequestServiceShape["detail"]>[0]["projectId"],
  ) => Effect.Effect<OrchestrationProject, unknown>;
  validateRepository: (repository: string) => Effect.Effect<string, Error>;
  validateProjectRepository: (
    project: OrchestrationProject,
    repository: string,
  ) => Effect.Effect<string, unknown>;
  loadMergeCapabilities: (
    cwd: string,
    repository: string,
  ) => Effect.Effect<PullRequestDetail["mergeCapabilities"], unknown>;
  withGitHubRead: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  finalizeMutationCaches: (
    repository: string,
    number: number,
    options: { readonly invalidateReviewMatches: boolean },
  ) => Effect.Effect<void, never>;
}): PullRequestOperations {
  const loadDetail = (project: OrchestrationProject, repositoryInput: string, number: number) =>
    Effect.gen(function* () {
      const repository = yield* dependencies.validateProjectRepository(project, repositoryInput);
      const [owner = "", repo = ""] = repository.split("/");
      const [detail, mergeCapabilities, reviewCommentsResult, stackResult] = yield* Effect.all(
        [
          dependencies.withGitHubRead(
            dependencies.github.getPullRequestDetail({
              cwd: project.workspaceRoot,
              repository,
              number,
            }),
          ),
          dependencies.loadMergeCapabilities(project.workspaceRoot, repository),
          dependencies
            .withGitHubRead(
              dependencies.github.getPullRequestReviewComments({
                cwd: project.workspaceRoot,
                host: "github.com",
                owner,
                repo,
                number,
              }),
            )
            .pipe(
              Effect.map((result) => ({ ...result, incomplete: false })),
              Effect.catch(() =>
                Effect.succeed({ comments: [], truncated: false, incomplete: true }),
              ),
            ),
          dependencies
            .withGitHubRead(
              dependencies.github.getPullRequestStack({
                cwd: project.workspaceRoot,
                repository,
                number,
              }),
            )
            .pipe(
              Effect.map((stack) => ({ stack, incomplete: false as const })),
              Effect.catch(() => Effect.succeed({ stack: null, incomplete: true as const })),
            ),
        ],
        { concurrency: 4 },
      );
      const comments = [
        ...detail.comments,
        ...reviewCommentsResult.comments.map((comment) => ({
          id: comment.id,
          kind: "review-comment" as const,
          author: comment.author
            ? {
                login: comment.author,
                name: null,
                avatarUrl: githubAvatarUrlForLogin(comment.author),
                url: null,
              }
            : null,
          body: comment.body,
          createdAt: comment.createdAt ?? detail.updatedAt,
          updatedAt: null,
          url: comment.url,
          path: comment.path,
          reviewState: null,
        })),
      ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        repository,
        ...detail,
        comments,
        commentsTruncated: reviewCommentsResult.truncated,
        commentsIncomplete: reviewCommentsResult.incomplete,
        mergeCapabilities,
        stack: stackResult.stack,
        stackMetadataIncomplete: stackResult.incomplete,
      } satisfies PullRequestDetail;
    });

  const detail: PullRequestServiceShape["detail"] = (input) =>
    dependencies
      .findProject(input.projectId)
      .pipe(Effect.flatMap((project) => loadDetail(project, input.repository, input.number)));

  const diff: PullRequestServiceShape["diff"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      return yield* dependencies.withGitHubRead(
        dependencies.github.getPullRequestDiff({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
        }),
      );
    });

  const action: PullRequestServiceShape["action"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      if (input.action === "merge") {
        const mergeMethod = input.mergeMethod ?? "merge";
        const capabilities = yield* dependencies.loadMergeCapabilities(
          project.workspaceRoot,
          repository,
        );
        if (!isPullRequestMergeMethodAllowed(capabilities, mergeMethod)) {
          return yield* Effect.fail(
            new Error(`The repository does not allow the ${mergeMethod} merge method.`),
          );
        }
        yield* dependencies.withGitHubRead(
          dependencies.github.getPullRequestStack({
            cwd: project.workspaceRoot,
            repository,
            number: input.number,
          }),
        );
      }
      const result = yield* dependencies.github
        .runPullRequestAction({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
        })
        .pipe(
          Effect.ensuring(
            dependencies.finalizeMutationCaches(repository, input.number, {
              invalidateReviewMatches: true,
            }),
          ),
        );
      return {
        projectId: project.id,
        repository,
        number: input.number,
        workspaceRoot: project.workspaceRoot,
        mergeOutcome: result.mergeOutcome,
      };
    });

  const comment: PullRequestServiceShape["comment"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      yield* dependencies.github
        .commentOnPullRequest({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
          body: input.body,
        })
        .pipe(
          Effect.ensuring(
            dependencies.finalizeMutationCaches(repository, input.number, {
              invalidateReviewMatches: false,
            }),
          ),
        );
      return {
        projectId: project.id,
        repository,
        number: input.number,
        workspaceRoot: project.workspaceRoot,
        mergeOutcome: null,
      };
    });

  const setPinned: PullRequestServiceShape["setPinned"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      // Clearing an orphaned pin intentionally requires only a valid canonical repository key.
      const repository = yield* input.isPinned
        ? dependencies.validateProjectRepository(project, input.repository)
        : dependencies.validateRepository(input.repository);
      yield* dependencies.pins.setPinned({
        projectId: project.id,
        repositoryKey: repository.toLowerCase(),
        number: input.number,
        isPinned: input.isPinned,
      });
      return {
        projectId: project.id,
        repository,
        number: input.number,
        isPinned: input.isPinned,
      };
    });

  return { detail, diff, action, comment, setPinned };
}
