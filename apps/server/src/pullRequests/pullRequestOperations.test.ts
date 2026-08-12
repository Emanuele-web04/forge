import { ProjectId, type OrchestrationProject } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { GitHubCliError } from "../git/Errors";
import type { GitHubCliShape, GitHubPullRequestDetailData } from "../git/Services/GitHubCli";
import { createGitHubCliWithFakeGh } from "../git/testing/fakeGitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { makePullRequestOperations } from "./pullRequestOperations";

const now = "2026-07-15T00:00:00.000Z";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-detail"),
  kind: "project",
  title: "Detail",
  workspaceRoot: "/tmp/detail",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const detail: GitHubPullRequestDetailData = {
  number: 42,
  title: "Parallel detail",
  body: "",
  url: "https://github.com/acme/widgets/pull/42",
  author: null,
  state: "open",
  isDraft: false,
  mergeable: null,
  mergeability: "unknown",
  mergeStateStatus: null,
  reviewDecision: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: now,
  updatedAt: now,
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commits: [],
};

function makeTestOperations(github: GitHubCliShape) {
  const pins: ProjectPullRequestPinsShape = {
    listByProjectIds: () => Effect.succeed([]),
    setPinned: () => Effect.void,
  };
  return makePullRequestOperations({
    github,
    pins,
    findProject: () => Effect.succeed(project),
    validateRepository: (repository) => Effect.succeed(repository),
    validateProjectRepository: (_project, repository) => Effect.succeed(repository),
    loadMergeCapabilities: () =>
      Effect.succeed({
        merge: true,
        squash: true,
        rebase: true,
        deleteBranchOnMerge: false,
      }),
    withGitHubRead: (effect) => effect,
    finalizeMutationCaches: () => Effect.void,
  });
}

describe("makePullRequestOperations", () => {
  it("starts detail, merge-capability, and review-comment reads together", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const detailStarted = yield* Deferred.make<void>();
          const capabilitiesStarted = yield* Deferred.make<void>();
          const commentsStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const waitForRelease = <A>(started: Deferred.Deferred<void>, value: A) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return value;
            });
          const base = createGitHubCliWithFakeGh().service;
          const pins: ProjectPullRequestPinsShape = {
            listByProjectIds: () => Effect.succeed([]),
            setPinned: () => Effect.void,
          };
          const operations = makePullRequestOperations({
            github: {
              ...base,
              getPullRequestDetail: () => waitForRelease(detailStarted, detail),
              getPullRequestReviewComments: () =>
                waitForRelease(commentsStarted, { comments: [], truncated: false }),
            },
            pins,
            findProject: () => Effect.succeed(project),
            validateRepository: (repository) => Effect.succeed(repository),
            validateProjectRepository: (_project, repository) => Effect.succeed(repository),
            loadMergeCapabilities: () =>
              waitForRelease(capabilitiesStarted, {
                merge: true,
                squash: true,
                rebase: true,
                deleteBranchOnMerge: false,
              }),
            withGitHubRead: (effect) => effect,
            finalizeMutationCaches: () => Effect.void,
          });

          const fiber = yield* operations
            .detail({ projectId: project.id, repository: "acme/widgets", number: 42 })
            .pipe(Effect.forkChild);
          yield* Effect.all([Deferred.await(detailStarted), Deferred.await(capabilitiesStarted)], {
            concurrency: 2,
          });
          yield* Effect.yieldNow;

          expect(yield* Deferred.isDone(commentsStarted)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(fiber)).number).toBe(42);
        }),
      ),
    );
  });

  it("keeps pull request detail available when stack metadata cannot be loaded", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const operations = makeTestOperations({
      ...base,
      getPullRequestDetail: () => Effect.succeed(detail),
      getPullRequestStack: () =>
        Effect.fail(
          new GitHubCliError({
            operation: "getPullRequestStack",
            detail: "Stack GraphQL is unavailable.",
          }),
        ),
    });

    const result = await Effect.runPromise(
      operations.detail({ projectId: project.id, repository: "acme/widgets", number: 42 }),
    );

    expect(result.stack).toBeNull();
    expect(result.stackMetadataIncomplete).toBe(true);
    expect(result.number).toBe(42);
  });

  it("does not merge when stack metadata cannot be verified", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const runPullRequestAction = vi.fn(base.runPullRequestAction);
    const operations = makeTestOperations({
      ...base,
      getPullRequestStack: () =>
        Effect.fail(
          new GitHubCliError({
            operation: "getPullRequestStack",
            detail: "Stack GraphQL is unavailable.",
          }),
        ),
      runPullRequestAction,
    });

    const exit = await Effect.runPromiseExit(
      operations.action({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        action: "merge",
        mergeMethod: "squash",
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(runPullRequestAction).not.toHaveBeenCalled();
  });
});
