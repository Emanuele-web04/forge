import { createHash } from "node:crypto";

import {
  ProjectId,
  type OrchestrationProject,
  type PullRequestReviewDraft,
} from "@synara/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { GitHubPullRequestDetailData } from "../git/Services/GitHubCli";
import { createGitHubCliWithFakeGh, type FakeGhScenario } from "../git/testing/fakeGitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import type { PullRequestReviewDraftStoreShape } from "../persistence/Services/PullRequestReviewDraftStore";
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

const pins: ProjectPullRequestPinsShape = {
  listByProjectIds: () => Effect.succeed([]),
  setPinned: () => Effect.void,
};

function makeDraft(
  input: Pick<
    PullRequestReviewDraft,
    "id" | "headSha" | "patchSignature" | "path" | "line" | "side"
  >,
): PullRequestReviewDraft {
  return {
    ...input,
    repository: "acme/widgets",
    number: 42,
    body: `Comment ${input.id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function makeDraftStore(initialDrafts: PullRequestReviewDraft[]): {
  drafts: PullRequestReviewDraft[];
  service: PullRequestReviewDraftStoreShape;
} {
  const state = { drafts: [...initialDrafts] };
  return {
    get drafts() {
      return state.drafts;
    },
    service: {
      list: ({ repository, number }) =>
        Effect.succeed(
          state.drafts.filter(
            (draft) =>
              draft.repository.toLowerCase() === repository.toLowerCase() &&
              draft.number === number,
          ),
        ),
      listByIds: ({ repository, number, ids }) => {
        const selectedIds = new Set(ids);
        return Effect.succeed(
          state.drafts.filter(
            (draft) =>
              selectedIds.has(draft.id) &&
              draft.repository.toLowerCase() === repository.toLowerCase() &&
              draft.number === number,
          ),
        );
      },
      create: (input) =>
        Effect.sync(() => {
          const created = {
            ...input,
            id: `draft-${state.drafts.length + 1}`,
            createdAt: now,
            updatedAt: now,
          } satisfies PullRequestReviewDraft;
          state.drafts.push(created);
          return created;
        }),
      update: (input) =>
        Effect.sync(() => {
          const index = state.drafts.findIndex(
            (draft) =>
              draft.id === input.id &&
              draft.repository.toLowerCase() === input.repository.toLowerCase() &&
              draft.number === input.number,
          );
          if (index < 0) return Option.none();
          const draft = { ...state.drafts[index]!, body: input.body, updatedAt: now };
          state.drafts[index] = draft;
          return Option.some(draft);
        }),
      delete: (input) =>
        Effect.sync(() => {
          const before = state.drafts.length;
          state.drafts = state.drafts.filter(
            (draft) =>
              !(
                draft.id === input.id &&
                draft.repository.toLowerCase() === input.repository.toLowerCase() &&
                draft.number === input.number
              ),
          );
          return state.drafts.length < before;
        }),
      deleteMany: (input) =>
        Effect.sync(() => {
          const ids = new Set(input.ids);
          state.drafts = state.drafts.filter(
            (draft) =>
              !(
                ids.has(draft.id) &&
                draft.repository.toLowerCase() === input.repository.toLowerCase() &&
                draft.number === input.number
              ),
          );
        }),
    },
  };
}

function makeOperations(input: {
  github: ReturnType<typeof createGitHubCliWithFakeGh>["service"];
  reviewDrafts?: PullRequestReviewDraftStoreShape;
}) {
  return makePullRequestOperations({
    github: input.github,
    pins,
    ...(input.reviewDrafts ? { reviewDrafts: input.reviewDrafts } : {}),
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
          const operations = makePullRequestOperations({
            github: {
              ...base,
              getPullRequestDetail: () => waitForRelease(detailStarted, detail),
              getPullRequestReviewComments: () =>
                waitForRelease(commentsStarted, {
                  comments: [],
                  threads: [],
                  truncated: false,
                }),
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

  it("returns remote review threads with pull request detail", async () => {
    const thread = {
      id: "thread-1",
      path: "src/a.ts",
      line: 12,
      side: "RIGHT" as const,
      isResolved: true,
      comments: [
        {
          id: "comment-1",
          author: null,
          body: "Remote context",
          createdAt: now,
          url: null,
        },
      ],
    };
    const base = createGitHubCliWithFakeGh({
      pullRequestDetail: detail,
      pullRequestReviewThreads: [thread],
    }).service;

    const result = await Effect.runPromise(
      makeOperations({ github: base }).detail({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
      }),
    );

    expect(result.reviewThreads).toEqual([thread]);
  });

  it("blocks the whole review when the head changed and keeps every draft", async () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const signature = createHash("sha256").update(patch).digest("hex");
    const store = makeDraftStore([
      makeDraft({
        id: "stale",
        headSha: "old-head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "RIGHT",
      }),
      makeDraft({
        id: "also-stale",
        headSha: "old-head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "LEFT",
      }),
    ]);
    const submittedReviews: NonNullable<FakeGhScenario["submittedReviews"]> = [];
    const github = createGitHubCliWithFakeGh({
      pullRequestHeadSha: "new-head",
      pullRequestDiff: { patch, truncated: false },
      submittedReviews,
    }).service;

    const result = await Effect.runPromise(
      makeOperations({ github, reviewDrafts: store.service }).submitReview({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        event: "COMMENT",
        body: "",
        draftIds: ["stale", "also-stale"],
      }),
    );

    expect(result).toEqual({
      status: "blocked",
      submittedDraftIds: [],
      staleDraftIds: ["stale", "also-stale"],
      invalidDraftIds: [],
    });
    expect(submittedReviews).toEqual([]);
    expect(store.drafts).toHaveLength(2);
  });

  it("blocks one invalid line without submitting or deleting valid drafts", async () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const signature = createHash("sha256").update(patch).digest("hex");
    const store = makeDraftStore([
      makeDraft({
        id: "valid",
        headSha: "head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "RIGHT",
      }),
      makeDraft({
        id: "invalid",
        headSha: "head",
        patchSignature: signature,
        path: "a.ts",
        line: 99,
        side: "RIGHT",
      }),
    ]);
    const submittedReviews: NonNullable<FakeGhScenario["submittedReviews"]> = [];
    const github = createGitHubCliWithFakeGh({
      pullRequestHeadSha: "head",
      pullRequestDiff: { patch, truncated: false },
      submittedReviews,
    }).service;

    const result = await Effect.runPromise(
      makeOperations({ github, reviewDrafts: store.service }).submitReview({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        event: "COMMENT",
        body: "",
        draftIds: ["valid", "invalid"],
      }),
    );

    expect(result.invalidDraftIds).toEqual(["invalid"]);
    expect(submittedReviews).toEqual([]);
    expect(store.drafts.map((draft) => draft.id)).toEqual(["valid", "invalid"]);
  });

  it("blocks every inline draft when GitHub truncates the live patch", async () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const signature = createHash("sha256").update(patch).digest("hex");
    const store = makeDraftStore([
      makeDraft({
        id: "first",
        headSha: "head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "RIGHT",
      }),
      makeDraft({
        id: "second",
        headSha: "head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "LEFT",
      }),
    ]);
    const submittedReviews: NonNullable<FakeGhScenario["submittedReviews"]> = [];
    const github = createGitHubCliWithFakeGh({
      pullRequestHeadSha: "head",
      pullRequestDiff: { patch, truncated: true },
      submittedReviews,
    }).service;

    const result = await Effect.runPromise(
      makeOperations({ github, reviewDrafts: store.service }).submitReview({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        event: "COMMENT",
        body: "",
        draftIds: ["first", "second"],
      }),
    );

    expect(result).toEqual({
      status: "blocked",
      submittedDraftIds: [],
      staleDraftIds: [],
      invalidDraftIds: ["first", "second"],
    });
    expect(submittedReviews).toEqual([]);
    expect(store.drafts).toHaveLength(2);
  });

  it("submits one review and deletes only included drafts after success", async () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const signature = createHash("sha256").update(patch).digest("hex");
    const store = makeDraftStore([
      makeDraft({
        id: "included",
        headSha: "head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "RIGHT",
      }),
      makeDraft({
        id: "saved",
        headSha: "head",
        patchSignature: signature,
        path: "a.ts",
        line: 1,
        side: "LEFT",
      }),
    ]);
    const submittedReviews: NonNullable<FakeGhScenario["submittedReviews"]> = [];
    const github = createGitHubCliWithFakeGh({
      pullRequestHeadSha: "head",
      pullRequestDiff: { patch, truncated: false },
      submittedReviews,
    }).service;

    const result = await Effect.runPromise(
      makeOperations({ github, reviewDrafts: store.service }).submitReview({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        event: "REQUEST_CHANGES",
        body: "Please fix this.",
        draftIds: ["included"],
      }),
    );

    expect(result.status).toBe("submitted");
    expect(submittedReviews).toEqual([
      {
        headSha: "head",
        event: "REQUEST_CHANGES",
        body: "Please fix this.",
        comments: [
          {
            path: "a.ts",
            line: 1,
            side: "RIGHT",
            body: "Comment included",
          },
        ],
      },
    ]);
    expect(store.drafts.map((draft) => draft.id)).toEqual(["saved"]);
  });

  it("allows body-only decisions and rejects an empty comment review", async () => {
    const submittedReviews: NonNullable<FakeGhScenario["submittedReviews"]> = [];
    const github = createGitHubCliWithFakeGh({
      pullRequestHeadSha: "head",
      pullRequestDiff: { patch: "", truncated: false },
      submittedReviews,
    }).service;
    const store = makeDraftStore([]);
    const operations = makeOperations({ github, reviewDrafts: store.service });

    await expect(
      Effect.runPromise(
        operations.submitReview({
          projectId: project.id,
          repository: "acme/widgets",
          number: 42,
          event: "COMMENT",
          body: "",
          draftIds: [],
        }),
      ),
    ).rejects.toThrow("needs a body");
    const approval = await Effect.runPromise(
      operations.submitReview({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        event: "APPROVE",
        body: "",
        draftIds: [],
      }),
    );
    const changeRequest = await Effect.runPromise(
      operations.submitReview({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        event: "REQUEST_CHANGES",
        body: "Please revise this.",
        draftIds: [],
      }),
    );

    expect(approval.status).toBe("submitted");
    expect(changeRequest.status).toBe("submitted");
    expect(submittedReviews).toHaveLength(2);
    expect(submittedReviews[0]?.comments).toEqual([]);
    expect(submittedReviews[1]?.comments).toEqual([]);
  });
});
