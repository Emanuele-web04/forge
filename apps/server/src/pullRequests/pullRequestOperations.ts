import { createHash } from "node:crypto";

import type { OrchestrationProject, PullRequestDetail } from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import { Effect, Option } from "effect";

import type { GitHubCliShape } from "../git/Services/GitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import type { PullRequestReviewDraftStoreShape } from "../persistence/Services/PullRequestReviewDraftStore";
import { isPullRequestMergeMethodAllowed } from "../pullRequests.logic";
import type { PullRequestServiceShape } from "./Services/PullRequestService";
import { validateInlineComments } from "./validateInlineComments";

type PullRequestOperations = Pick<
  PullRequestServiceShape,
  | "detail"
  | "diff"
  | "action"
  | "comment"
  | "setPinned"
  | "listReviewDrafts"
  | "createReviewDraft"
  | "updateReviewDraft"
  | "deleteReviewDraft"
  | "submitReview"
>;

export function makePullRequestOperations(dependencies: {
  github: GitHubCliShape;
  pins: ProjectPullRequestPinsShape;
  reviewDrafts?: PullRequestReviewDraftStoreShape;
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
      const [detail, mergeCapabilities, reviewCommentsResult] = yield* Effect.all(
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
                Effect.succeed({
                  comments: [],
                  threads: [],
                  truncated: false,
                  incomplete: true,
                }),
              ),
            ),
        ],
        { concurrency: 3 },
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
        reviewThreads: reviewCommentsResult.threads,
        mergeCapabilities,
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
      const [diffResult, headSha] = yield* Effect.all(
        [
          dependencies.withGitHubRead(
            dependencies.github.getPullRequestDiff({
              cwd: project.workspaceRoot,
              repository,
              number: input.number,
            }),
          ),
          dependencies.withGitHubRead(
            dependencies.github.getPullRequestHeadSha({
              cwd: project.workspaceRoot,
              repository,
              number: input.number,
            }),
          ),
        ],
        { concurrency: 2 },
      );
      return {
        ...diffResult,
        headSha,
        patchSignature: createHash("sha256").update(diffResult.patch).digest("hex"),
      };
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
      }
      yield* dependencies.github
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

  const loadReviewContext = (input: {
    readonly projectId: Parameters<PullRequestServiceShape["detail"]>[0]["projectId"];
    readonly repository: string;
    readonly number: number;
  }) =>
    Effect.gen(function* () {
      const reviewDrafts = dependencies.reviewDrafts;
      if (!reviewDrafts) {
        return yield* Effect.fail(new Error("Pull request review drafts are unavailable."));
      }
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      return { project, repository, reviewDrafts };
    });

  const listReviewDrafts: PullRequestServiceShape["listReviewDrafts"] = (input) =>
    Effect.gen(function* () {
      const { repository, reviewDrafts } = yield* loadReviewContext(input);
      const drafts = yield* reviewDrafts.list({ repository, number: input.number });
      return { drafts };
    });

  const createReviewDraft: PullRequestServiceShape["createReviewDraft"] = (input) =>
    Effect.gen(function* () {
      const { repository, reviewDrafts } = yield* loadReviewContext(input);
      const draft = yield* reviewDrafts.create({
        repository,
        number: input.number,
        headSha: input.headSha,
        patchSignature: input.patchSignature,
        path: input.path,
        line: input.line,
        side: input.side,
        body: input.body,
      });
      return { draft };
    });

  const updateReviewDraft: PullRequestServiceShape["updateReviewDraft"] = (input) =>
    Effect.gen(function* () {
      const { repository, reviewDrafts } = yield* loadReviewContext(input);
      const updated = yield* reviewDrafts.update({
        repository,
        number: input.number,
        id: input.id,
        body: input.body,
      });
      if (Option.isNone(updated)) {
        return yield* Effect.fail(new Error("Pull request review draft not found."));
      }
      return { draft: updated.value };
    });

  const deleteReviewDraft: PullRequestServiceShape["deleteReviewDraft"] = (input) =>
    Effect.gen(function* () {
      const { repository, reviewDrafts } = yield* loadReviewContext(input);
      const deleted = yield* reviewDrafts.delete({
        repository,
        number: input.number,
        id: input.id,
      });
      if (!deleted) {
        return yield* Effect.fail(new Error("Pull request review draft not found."));
      }
      return { deletedId: input.id };
    });

  const submitReview: PullRequestServiceShape["submitReview"] = (input) =>
    Effect.gen(function* () {
      const { project, repository, reviewDrafts } = yield* loadReviewContext(input);
      const body = input.body ?? "";
      const requestedDraftIds = [...new Set(input.draftIds)];
      const storedDrafts = yield* reviewDrafts.listByIds({
        repository,
        number: input.number,
        ids: requestedDraftIds,
      });
      const draftsById = new Map(storedDrafts.map((draft) => [draft.id, draft]));
      const missingDraftIds = requestedDraftIds.filter((id) => !draftsById.has(id));
      const selectedDrafts = requestedDraftIds.flatMap((id) => {
        const draft = draftsById.get(id);
        return draft ? [draft] : [];
      });

      if (missingDraftIds.length > 0) {
        return {
          status: "blocked" as const,
          submittedDraftIds: [],
          staleDraftIds: [],
          invalidDraftIds: missingDraftIds,
        };
      }
      if (input.event === "COMMENT" && body.trim().length === 0 && selectedDrafts.length === 0) {
        return yield* Effect.fail(
          new Error("A comment review needs a body or at least one line comment."),
        );
      }

      const diffResult =
        selectedDrafts.length > 0
          ? yield* dependencies.withGitHubRead(
              dependencies.github.getPullRequestDiff({
                cwd: project.workspaceRoot,
                repository,
                number: input.number,
              }),
            )
          : null;
      // Read the head after the patch. If a push happened while the patch loaded, the
      // stored head and patch signature cannot both match and the whole batch blocks.
      const headSha = yield* dependencies.withGitHubRead(
        dependencies.github.getPullRequestHeadSha({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
        }),
      );
      const patchSignature =
        diffResult === null ? null : createHash("sha256").update(diffResult.patch).digest("hex");
      const staleDraftIds = selectedDrafts
        .filter((draft) => draft.headSha !== headSha || draft.patchSignature !== patchSignature)
        .map((draft) => draft.id);
      const staleDraftIdSet = new Set(staleDraftIds);
      let invalidDraftIds: ReadonlyArray<string>;
      if (diffResult?.truncated === true) {
        invalidDraftIds = selectedDrafts.map((draft) => draft.id);
      } else if (diffResult === null) {
        invalidDraftIds = [];
      } else {
        invalidDraftIds = validateInlineComments(
          diffResult.patch,
          selectedDrafts.filter((draft) => !staleDraftIdSet.has(draft.id)),
        );
      }
      if (staleDraftIds.length > 0 || invalidDraftIds.length > 0) {
        return {
          status: "blocked" as const,
          submittedDraftIds: [],
          staleDraftIds,
          invalidDraftIds,
        };
      }

      yield* dependencies.github.submitPullRequestReview({
        cwd: project.workspaceRoot,
        repository,
        number: input.number,
        headSha,
        event: input.event,
        body,
        comments: selectedDrafts.map((draft) => ({
          path: draft.path,
          line: draft.line,
          side: draft.side,
          body: draft.body,
        })),
      });
      const submittedDraftIds = selectedDrafts.map((draft) => draft.id);
      yield* reviewDrafts.deleteMany({
        repository,
        number: input.number,
        ids: submittedDraftIds,
      });
      yield* dependencies.finalizeMutationCaches(repository, input.number, {
        invalidateReviewMatches: false,
      });
      return {
        status: "submitted" as const,
        submittedDraftIds,
        staleDraftIds: [],
        invalidDraftIds: [],
      };
    });

  return {
    detail,
    diff,
    action,
    comment,
    setPinned,
    listReviewDrafts,
    createReviewDraft,
    updateReviewDraft,
    deleteReviewDraft,
    submitReview,
  };
}
