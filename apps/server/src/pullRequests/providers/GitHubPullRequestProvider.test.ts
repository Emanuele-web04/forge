import {
  LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES,
  ProjectId,
  type OrchestrationProject,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { GitHubCliError } from "../../git/Errors";
import type {
  GitHubCliShape,
  GitHubPullRequestDetailData,
  GitHubPullRequestListBatch,
  GitHubPullRequestListItem,
} from "../../git/Services/GitHubCli";
import { createGitHubCliWithFakeGh } from "../../git/testing/fakeGitHubCli";
import {
  PullRequestProviderError,
  makePullRequestProviderRegistry,
} from "../Services/PullRequestProvider";
import { makeGitHubPullRequestProvider } from "./GitHubPullRequestProvider";

const now = "2026-07-15T00:00:00.000Z";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-provider"),
  kind: "project",
  title: "Provider project",
  workspaceRoot: "/tmp/provider-project",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

function repository(displayName = "acme/widgets"): RemoteRepositoryRef {
  const [owner = "", slug = ""] = displayName.split("/");
  return {
    provider: "github",
    host: "github.com",
    owner,
    slug,
    webUrl: `https://github.com/${displayName}`,
    identityKey: `github:github.com:${displayName.toLowerCase()}`,
    displayName,
  };
}

const bitbucketRepository: RemoteRepositoryRef = {
  provider: "bitbucket",
  host: "bitbucket.org",
  owner: "paraty",
  slug: "payment-seeker",
  webUrl: "https://bitbucket.org/paraty/payment-seeker",
  identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
  displayName: "paraty/payment-seeker",
};

function item(
  number: number,
  overrides: Partial<GitHubPullRequestListItem> = {},
): GitHubPullRequestListItem {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: { login: "viewer", name: null, avatarUrl: null, url: null },
    headBranch: `feature-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 3,
    deletions: 1,
    createdAt: now,
    updatedAt: now,
    reviewDecision: null,
    reviewRequestLogins: [],
    labels: [],
    mergeability: "unknown",
    stack: null,
    ...overrides,
  };
}

function batch(
  entries: ReadonlyArray<GitHubPullRequestListItem>,
  rawCount = entries.length,
): GitHubPullRequestListBatch {
  return { entries, rawCount };
}

const detailData: GitHubPullRequestDetailData = {
  number: 42,
  title: "Provider detail",
  body: "Body",
  url: "https://github.com/acme/widgets/pull/42",
  author: { login: "teammate", name: "Team Mate", avatarUrl: null, url: null },
  state: "open",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeability: "mergeable",
  mergeStateStatus: "CLEAN",
  reviewDecision: "REVIEW_REQUIRED",
  additions: 4,
  deletions: 2,
  changedFiles: 2,
  headBranch: "feature/provider",
  baseBranch: "main",
  createdAt: now,
  updatedAt: now,
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [
    {
      id: "issue-1",
      kind: "issue-comment",
      author: null,
      body: "Issue comment",
      createdAt: now,
      updatedAt: null,
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  commits: [],
};

const makeProvider = (github: GitHubCliShape) =>
  makeGitHubPullRequestProvider({ homeDir: "/tmp/provider-home", github });

describe("GitHubPullRequestProvider registry", () => {
  it("selects one exact provider/host match and rejects zero or duplicate matches", async () => {
    const selected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(createGitHubCliWithFakeGh().service);
          expect(provider.supports(repository("Acme/Widgets"))).toBe(true);
          expect(provider.supports(bitbucketRepository)).toBe(false);
          return yield* makePullRequestProviderRegistry([provider]).select(repository());
        }),
      ),
    );
    expect(selected.provider).toBe("github");
    expect(selected.host).toBe("github.com");

    const missing = await Effect.runPromise(
      Effect.flip(makePullRequestProviderRegistry([]).select(repository())),
    );
    expect(missing).toMatchObject({
      _tag: "PullRequestProviderSelectionError",
      provider: "github",
      host: "github.com",
      matches: 0,
    });

    const duplicate = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(createGitHubCliWithFakeGh().service);
          return yield* Effect.flip(
            makePullRequestProviderRegistry([provider, provider]).select(repository()),
          );
        }),
      ),
    );
    expect(duplicate).toMatchObject({
      _tag: "PullRequestProviderSelectionError",
      provider: "github",
      host: "github.com",
      matches: 2,
    });
  });
});

describe("GitHubPullRequestProvider list and recovery", () => {
  it("normalizes viewer failures as provider-global errors", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider({
            ...base,
            getViewerLogin: () =>
              Effect.fail(
                new GitHubCliError({
                  operation: "getViewerLogin",
                  detail: "GitHub API unavailable.",
                  reason: "other",
                }),
              ),
          });
          return yield* Effect.flip(
            provider.viewer!({ cwd: project.workspaceRoot, forceRefresh: false }),
          );
        }),
      ),
    );

    expect(error).toMatchObject({ scope: "global", repository: null });
  });

  it("maps all, reviewing, and authored lists with viewer involvement and one reviewing companion", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const author = item(1);
    const requested = item(2, {
      author: { login: "teammate", name: null, avatarUrl: null, url: null },
    });
    const calls: string[] = [];
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: ({ involvement }) =>
        Effect.sync(() => {
          calls.push(involvement);
          if (involvement === "authored") return batch([author]);
          if (involvement === "reviewing") return batch([requested]);
          return batch([author, requested]);
        }),
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(github);
          const viewer = yield* provider.viewer!({
            cwd: project.workspaceRoot,
            forceRefresh: false,
          });
          return yield* Effect.all(
            (["all", "reviewing", "authored"] as const).map((involvement) =>
              provider.list({
                cwd: project.workspaceRoot,
                repository: repository(),
                state: "open",
                involvement,
                viewer,
                forceRefresh: false,
              }),
            ),
            { concurrency: 3 },
          );
        }),
      ),
    );

    expect(results[0].entries.map((entry) => [entry.number, entry.viewerInvolvement])).toEqual([
      [1, "author"],
      [2, "review-requested"],
    ]);
    expect(results[1].entries[0]).toMatchObject({
      provider: "github",
      repository: "acme/widgets",
      capabilities: LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES,
      viewerInvolvement: "review-requested",
    });
    expect(results[2].entries[0]?.viewerInvolvement).toBe("author");
    expect(calls.filter((involvement) => involvement === "reviewing")).toHaveLength(1);
  });

  it("uses raw pagination cardinality for truncation and caps normalized entries at fifty", async () => {
    const entries = Array.from({ length: 51 }, (_, index) => item(index + 1));
    const base = createGitHubCliWithFakeGh().service;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () => Effect.succeed(batch(entries, 51)),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(github);
          return yield* provider.list({
            cwd: project.workspaceRoot,
            repository: repository(),
            state: "closed",
            involvement: "all",
            viewer: "viewer",
            forceRefresh: false,
          });
        }),
      ),
    );

    expect(result.entries).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("single-flights list reads, preserves a healthy joiner after owner cancellation, and force-refreshes", async () => {
    let executions = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const base = createGitHubCliWithFakeGh().service;
          const github: GitHubCliShape = {
            ...base,
            listRepositoryPullRequests: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return batch([item(executions)]);
              }),
          };
          const provider = yield* makeProvider(github);
          const input = {
            cwd: project.workspaceRoot,
            repository: repository(),
            state: "closed" as const,
            involvement: "authored" as const,
            viewer: "viewer",
            forceRefresh: false,
          };
          const owner = yield* provider.list(input).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const joiner = yield* provider.list(input).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(owner);
          yield* Deferred.succeed(release, undefined);
          const joined = yield* Fiber.join(joiner);
          const refreshed = yield* provider.list({ ...input, forceRefresh: true });
          return { joined, refreshed };
        }),
      ),
    );

    expect(executions).toBe(2);
    expect(result.joined.entries[0]?.number).toBe(1);
    expect(result.refreshed.entries[0]?.number).toBe(2);
  });

  it("expires list values at the existing thirty-second TTL", async () => {
    let clock = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    let executions = 0;
    try {
      const numbers = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const base = createGitHubCliWithFakeGh().service;
            const provider = yield* makeProvider({
              ...base,
              listRepositoryPullRequests: () => Effect.sync(() => batch([item(++executions)])),
            });
            const input = {
              cwd: project.workspaceRoot,
              repository: repository(),
              state: "merged" as const,
              involvement: "authored" as const,
              viewer: "viewer",
              forceRefresh: false,
            };
            const first = yield* provider.list(input);
            clock += 30_000;
            const boundary = yield* provider.list(input);
            return [first.entries[0]?.number, boundary.entries[0]?.number];
          }),
        ),
      );
      expect(numbers).toEqual([1, 2]);
      expect(executions).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("normalizes exact recovery, review matches, counts, force refresh, and definitive absence", async () => {
    const base = createGitHubCliWithFakeGh().service;
    let itemReads = 0;
    let reviewReads = 0;
    const github: GitHubCliShape = {
      ...base,
      getPullRequestListItem: ({ number }) =>
        Effect.sync(() => {
          itemReads += 1;
          return item(number, {
            author: { login: "teammate", name: null, avatarUrl: null, url: null },
          });
        }),
      listReviewRequestedPullRequestNumbers: () =>
        Effect.sync(() => {
          reviewReads += 1;
          return [42, ...Array.from({ length: 999 }, (_, index) => index + 100)];
        }),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(github);
          const exactInput = {
            cwd: project.workspaceRoot,
            repository: repository(),
            number: 42,
            viewer: "viewer",
            matchedReviewingQuery: true,
            forceRefresh: false,
          };
          const first = yield* provider.exactSummary(exactInput);
          const cached = yield* provider.exactSummary(exactInput);
          const refreshed = yield* provider.exactSummary({ ...exactInput, forceRefresh: true });
          const matches = yield* provider.reviewRequests!({
            cwd: project.workspaceRoot,
            repository: repository(),
            viewer: "viewer",
            forceRefresh: false,
          });
          const count = yield* provider.reviewRequestCount!({
            cwd: project.workspaceRoot,
            repository: repository(),
            viewer: "viewer",
            forceRefresh: false,
          });
          return { first, cached, refreshed, matches, count };
        }),
      ),
    );

    expect(itemReads).toBe(2);
    expect(reviewReads).toBe(1);
    expect(result.first).toMatchObject({
      _tag: "found",
      summary: { number: 42, viewerInvolvement: "review-requested" },
    });
    expect(result.cached).toEqual(result.first);
    expect(result.refreshed._tag).toBe("found");
    expect(result.matches.numbers.has(42)).toBe(true);
    expect(result.matches.incomplete).toBe(true);
    expect(result.count).toEqual({ count: 1_000, incomplete: true });

    const notFoundReads = { value: 0 };
    const missing = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider({
            ...base,
            getPullRequestListItem: () =>
              Effect.suspend(() => {
                notFoundReads.value += 1;
                return Effect.fail(
                  new GitHubCliError({
                    operation: "getPullRequestListItem",
                    detail: "GraphQL: Could not resolve to a PullRequest with the number of 99.",
                    reason: "other",
                  }),
                );
              }),
          });
          const input = {
            cwd: project.workspaceRoot,
            repository: repository(),
            number: 99,
            viewer: "viewer",
            matchedReviewingQuery: false,
            forceRefresh: false,
          };
          return [yield* provider.exactSummary(input), yield* provider.exactSummary(input)];
        }),
      ),
    );
    expect(missing).toEqual([{ _tag: "not-found" }, { _tag: "not-found" }]);
    expect(notFoundReads.value).toBe(1);
  });

  it("does not negative-cache transient exact recovery failures and exposes normalized scope", async () => {
    const base = createGitHubCliWithFakeGh().service;
    let reads = 0;
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider({
            ...base,
            getPullRequestListItem: () =>
              Effect.suspend(() => {
                reads += 1;
                return Effect.fail(
                  new GitHubCliError({
                    operation: "getPullRequestListItem",
                    detail: "GitHub API rate limit exceeded.",
                    reason: "other",
                  }),
                );
              }),
          });
          const input = {
            cwd: project.workspaceRoot,
            repository: repository(),
            number: 42,
            viewer: "viewer",
            matchedReviewingQuery: false,
            forceRefresh: false,
          };
          yield* provider.exactSummary(input).pipe(Effect.catch(() => Effect.void));
          return yield* Effect.flip(provider.exactSummary(input));
        }),
      ),
    );

    expect(reads).toBe(2);
    expect(error).toBeInstanceOf(PullRequestProviderError);
    expect(error).toMatchObject({
      provider: "github",
      host: "github.com",
      repository: "acme/widgets",
      scope: "repository",
    });
  });
});

describe("GitHubPullRequestProvider detail and mutations", () => {
  it("starts detail, merge-capability, review-comment, and stack reads together", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const detailStarted = yield* Deferred.make<void>();
          const capabilitiesStarted = yield* Deferred.make<void>();
          const commentsStarted = yield* Deferred.make<void>();
          const stackStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const waitForRelease = <A>(started: Deferred.Deferred<void>, value: A) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return value;
            });
          const base = createGitHubCliWithFakeGh().service;
          const provider = yield* makeProvider({
            ...base,
            getPullRequestDetail: () => waitForRelease(detailStarted, detailData),
            getRepositoryMergeCapabilities: () =>
              waitForRelease(capabilitiesStarted, {
                merge: true,
                squash: true,
                rebase: true,
                deleteBranchOnMerge: false,
              }),
            getPullRequestReviewComments: () =>
              waitForRelease(commentsStarted, { comments: [], truncated: false }),
            getPullRequestStack: () => waitForRelease(stackStarted, null),
          });

          const fiber = yield* provider
            .detail({ project, repository: repository(), number: 42 })
            .pipe(Effect.forkChild);
          yield* Effect.all(
            [
              Deferred.await(detailStarted),
              Deferred.await(capabilitiesStarted),
              Deferred.await(commentsStarted),
              Deferred.await(stackStarted),
            ],
            { concurrency: 4 },
          );
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(fiber)).number).toBe(42);
        }),
      ),
    );
  });

  it("maps detail, review comments, stack metadata, merge capabilities, and diff", async () => {
    const { service: github } = createGitHubCliWithFakeGh({
      pullRequestDetail: detailData,
      pullRequestReviewComments: [
        {
          id: "review-1",
          author: "reviewer",
          body: "Inline comment",
          path: "src/index.ts",
          url: "https://github.com/acme/widgets/pull/42#discussion_r1",
          createdAt: now,
        },
      ],
      pullRequestReviewCommentsTruncated: true,
      pullRequestStack: {
        number: 42,
        size: 2,
        position: 2,
        baseBranch: "main",
        entries: [],
      },
      pullRequestDiff: { patch: "diff --git a/a.ts b/a.ts", truncated: true },
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(github);
          const input = { project, repository: repository(), number: 42 };
          const detail = yield* provider.detail(input);
          const diff = yield* provider.diff(input);
          return { detail, diff };
        }),
      ),
    );

    expect(result.detail).toMatchObject({
      projectId: project.id,
      provider: "github",
      capabilities: LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES,
      repository: "acme/widgets",
      number: 42,
      commentsTruncated: true,
      commentsIncomplete: false,
      stackMetadataIncomplete: false,
    });
    expect(result.detail.comments.map((comment) => comment.id)).toEqual(["issue-1", "review-1"]);
    expect(result.detail.comments[1]?.author?.avatarUrl).toBe(
      "https://avatars.githubusercontent.com/reviewer?size=64",
    );
    expect(result.diff).toEqual({ patch: "diff --git a/a.ts b/a.ts", truncated: true });
  });

  it("keeps detail usable when review comments and stack metadata fail", async () => {
    const unavailable = new GitHubCliError({
      operation: "detail-companion",
      detail: "Companion unavailable",
      reason: "other",
    });
    const { service: base } = createGitHubCliWithFakeGh({ pullRequestDetail: detailData });
    const providerResult = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider({
            ...base,
            getPullRequestReviewComments: () => Effect.fail(unavailable),
            getPullRequestStack: () => Effect.fail(unavailable),
          });
          return yield* provider.detail({ project, repository: repository(), number: 42 });
        }),
      ),
    );

    expect(providerResult.comments).toEqual(detailData.comments);
    expect(providerResult.commentsIncomplete).toBe(true);
    expect(providerResult.stack).toBeNull();
    expect(providerResult.stackMetadataIncomplete).toBe(true);
  });

  it.each(["ready", "draft", "close", "reopen"] as const)(
    "runs the %s state mutation through GitHub",
    async (action) => {
      const { service: github, ghCalls } = createGitHubCliWithFakeGh();
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const provider = yield* makeProvider(github);
            return yield* provider.action!({
              project,
              repository: repository(),
              number: 42,
              action,
            });
          }),
        ),
      );
      expect(result).toMatchObject({ projectId: project.id, provider: "github", number: 42 });
      expect(ghCalls).toContain(`pr action ${action} 42 --repo acme/widgets`);
    },
  );

  it("enforces cached merge capabilities and verifies stack metadata before merging", async () => {
    const { service: base } = createGitHubCliWithFakeGh({ mergeOutcome: "enqueued" });
    let capabilityReads = 0;
    let actionReads = 0;
    const github: GitHubCliShape = {
      ...base,
      getRepositoryMergeCapabilities: () =>
        Effect.sync(() => {
          capabilityReads += 1;
          return { merge: false, squash: true, rebase: false, deleteBranchOnMerge: true };
        }),
      runPullRequestAction: (input) => {
        actionReads += 1;
        return base.runPullRequestAction(input);
      },
    };

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(github);
          const allowed = yield* provider.action!({
            project,
            repository: repository(),
            number: 42,
            action: "merge",
            mergeMethod: "squash",
          });
          const denied = yield* Effect.exit(
            provider.action!({
              project,
              repository: repository(),
              number: 43,
              action: "merge",
              mergeMethod: "merge",
            }),
          );
          return { allowed, denied };
        }),
      ),
    );

    expect(results.allowed.mergeOutcome).toBe("enqueued");
    expect(results.denied._tag).toBe("Failure");
    expect(capabilityReads).toBe(1);
    expect(actionReads).toBe(1);
  });

  it("does not merge when stack metadata cannot be verified", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const runPullRequestAction = vi.fn(base.runPullRequestAction);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider({
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
          return yield* provider.action!({
            project,
            repository: repository(),
            number: 42,
            action: "merge",
            mergeMethod: "squash",
          });
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(runPullRequestAction).not.toHaveBeenCalled();
  });

  it("posts comments and invalidates repository list and exact-summary caches after mutations", async () => {
    const base = createGitHubCliWithFakeGh().service;
    let listReads = 0;
    let itemReads = 0;
    const github: GitHubCliShape = {
      ...base,
      listRepositoryPullRequests: () =>
        Effect.sync(() => {
          listReads += 1;
          return batch([item(42)]);
        }),
      getPullRequestListItem: () =>
        Effect.sync(() => {
          itemReads += 1;
          return item(42);
        }),
    };

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeProvider(github);
          const listInput = {
            cwd: project.workspaceRoot,
            repository: repository(),
            state: "closed" as const,
            involvement: "authored" as const,
            viewer: "viewer",
            forceRefresh: false,
          };
          const exactInput = {
            cwd: project.workspaceRoot,
            repository: repository(),
            number: 42,
            viewer: "viewer",
            matchedReviewingQuery: false,
            forceRefresh: false,
          };
          yield* provider.list(listInput);
          yield* provider.exactSummary(exactInput);
          yield* provider.comment!({
            project,
            repository: repository(),
            number: 42,
            body: "Looks good",
          });
          yield* provider.list(listInput);
          yield* provider.exactSummary(exactInput);
          yield* provider.action!({
            project,
            repository: repository(),
            number: 42,
            action: "close",
          });
          yield* provider.list(listInput);
          return { listReads, itemReads };
        }),
      ),
    );

    expect(result).toEqual({ listReads: 3, itemReads: 2 });
  });

  it("runs at most six GitHub reads concurrently across distinct cache keys", async () => {
    let active = 0;
    let maxActive = 0;
    const observedSix = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sixStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const base = createGitHubCliWithFakeGh().service;
          const provider = yield* makeProvider({
            ...base,
            listRepositoryPullRequests: () =>
              Effect.acquireUseRelease(
                Effect.gen(function* () {
                  active += 1;
                  maxActive = Math.max(maxActive, active);
                  if (active === 6) yield* Deferred.succeed(sixStarted, undefined);
                }),
                () => Deferred.await(release).pipe(Effect.as(batch([]))),
                () => Effect.sync(() => void (active -= 1)),
              ),
          });
          const allReads = yield* Effect.all(
            Array.from({ length: 7 }, (_, index) =>
              provider.list({
                cwd: project.workspaceRoot,
                repository: repository(`acme/repo-${index}`),
                state: "closed",
                involvement: "authored",
                viewer: "viewer",
                forceRefresh: false,
              }),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Deferred.await(sixStarted);
          yield* Effect.yieldNow;
          const beforeRelease = maxActive;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(allReads);
          return beforeRelease;
        }),
      ),
    );

    expect(observedSix).toBe(6);
    expect(maxActive).toBe(6);
  });

  it("interrupts a remote list read after its final waiter is cancelled", async () => {
    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const cancelled = yield* Deferred.make<void>();
          const base = createGitHubCliWithFakeGh().service;
          const provider = yield* makeProvider({
            ...base,
            listRepositoryPullRequests: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
                ),
              ),
          });
          const waiter = yield* provider
            .list({
              cwd: project.workspaceRoot,
              repository: repository(),
              state: "closed",
              involvement: "authored",
              viewer: "viewer",
              forceRefresh: false,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(waiter);
          yield* Deferred.await(cancelled);
          return true;
        }),
      ),
    );

    expect(interrupted).toBe(true);
  });
});
