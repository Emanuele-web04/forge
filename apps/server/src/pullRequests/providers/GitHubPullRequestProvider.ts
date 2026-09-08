import { LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES, type PullRequestDetail } from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect, Layer, Scope, Semaphore, ServiceMap } from "effect";

import { ServerConfig } from "../../config";
import { GitHubCliError } from "../../git/Errors";
import type { GitHubCliShape, GitHubPullRequestListItem } from "../../git/Services/GitHubCli";
import { GitHubCli } from "../../git/Services/GitHubCli";
import {
  isPullRequestMergeMethodAllowed,
  pullRequestListCacheKey,
  pullRequestListForceRefreshCacheKeys,
  repositoryPullRequestIdentityKey,
  resolvePullRequestViewerInvolvement,
  shouldLoadReviewingCompanion,
} from "../../pullRequests.logic";
import { makeKeyedSingleFlightCache } from "../KeyedSingleFlightCache";
import {
  PULL_REQUEST_REVIEW_MATCH_LIMIT,
  PullRequestProviderError,
  type ProviderExactSummaryResult,
  type ProviderListResult,
  type ProviderPullRequestSummary,
  type ProviderReviewRequestsResult,
  type PullRequestProviderShape,
} from "../Services/PullRequestProvider";

const PULL_REQUEST_LIST_LIMIT = 50;
const PULL_REQUEST_LIST_CACHE_MAX_ENTRIES = 512;
const PULL_REQUEST_PIN_ITEM_CACHE_MAX_ENTRIES = 128;
const PULL_REQUEST_REVIEW_MATCH_CACHE_MAX_ENTRIES = 32;
const PULL_REQUEST_MERGE_CAPABILITIES_CACHE_MAX_ENTRIES = 64;

type GitHubPullRequestListBatch = {
  readonly entries: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
};

type CachedExactSummary =
  | { readonly _tag: "found"; readonly item: GitHubPullRequestListItem }
  | { readonly _tag: "not-found" };

export interface GitHubPullRequestProviderDependencies {
  readonly homeDir: string;
  readonly github: GitHubCliShape;
}

export class GitHubPullRequestProvider extends ServiceMap.Service<
  GitHubPullRequestProvider,
  PullRequestProviderShape
>()("synara/pullRequests/providers/GitHubPullRequestProvider") {}

function repositoryName(repository: RemoteRepositoryRef): string {
  return repository.displayName;
}

function viewerLogin(viewer: string | null): string {
  return viewer ?? "";
}

function listCacheKeyBelongsToRepository(cacheKey: string, repository: string): boolean {
  return cacheKey.startsWith(`github:${repository.trim().toLowerCase()}:`);
}

function providerError(error: GitHubCliError, repository: RemoteRepositoryRef | null) {
  const global =
    repository === null || error.reason === "not-installed" || error.reason === "not-authenticated";
  return new PullRequestProviderError({
    provider: "github",
    host: "github.com",
    operation: error.operation,
    repository: repository?.displayName ?? null,
    scope: global ? "global" : "repository",
    reason: error.reason ?? "other",
    message: error.message,
    cause: error,
  });
}

function normalizeGitHubError<A, R>(
  effect: Effect.Effect<A, GitHubCliError, R>,
  repository: RemoteRepositoryRef | null,
): Effect.Effect<A, PullRequestProviderError, R> {
  return effect.pipe(Effect.mapError((error) => providerError(error, repository)));
}

/** Exact gh error shape for a PR number that is known not to exist. Generic 404/auth failures are
 * deliberately not classified as absence, so permission and network failures remain visible. */
export function isDefinitivePullRequestNotFound(error: GitHubCliError): boolean {
  if (error.reason === "not-installed" || error.reason === "not-authenticated") return false;
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("could not resolve to a pullrequest") ||
    /pull request(?: with (?:the )?number)?[^\n]*(?:not found|does not exist)/i.test(
      error.detail,
    ) ||
    /no pull request[^\n]*found/i.test(error.detail)
  );
}

function toProviderSummary(input: {
  readonly repository: RemoteRepositoryRef;
  readonly item: GitHubPullRequestListItem;
  readonly viewer: string;
  readonly matchedReviewingQuery: boolean;
}): ProviderPullRequestSummary {
  const viewerInvolvement = resolvePullRequestViewerInvolvement(
    input.item.author,
    input.item.reviewRequestLogins,
    input.viewer,
    input.matchedReviewingQuery,
  );
  return {
    provider: "github",
    capabilities: LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES,
    repository: input.repository.displayName,
    number: input.item.number,
    title: input.item.title,
    url: input.item.url,
    author: input.item.author,
    headBranch: input.item.headBranch,
    baseBranch: input.item.baseBranch,
    state: input.item.state,
    isDraft: input.item.isDraft,
    additions: input.item.additions,
    deletions: input.item.deletions,
    createdAt: input.item.createdAt,
    updatedAt: input.item.updatedAt,
    reviewDecision: input.item.reviewDecision,
    viewerInvolvement,
    labels: input.item.labels,
    mergeability: input.item.mergeability,
    stack: input.item.stack,
  };
}

export const makeGitHubPullRequestProvider = (
  dependencies: GitHubPullRequestProviderDependencies,
): Effect.Effect<PullRequestProviderShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    // One adapter instance is shared server-wide. Mutations bypass this queue so foreground writes
    // are never delayed behind background list warming.
    const readSlots = yield* Semaphore.make(6);
    const withRead = <A, E, R>(effect: Effect.Effect<A, E, R>) => readSlots.withPermits(1)(effect);
    const viewerCache = yield* makeKeyedSingleFlightCache<string, PullRequestProviderError>({
      maxEntries: 1,
      ttlMs: 5 * 60_000,
    });
    const listCache = yield* makeKeyedSingleFlightCache<
      GitHubPullRequestListBatch,
      PullRequestProviderError
    >({ maxEntries: PULL_REQUEST_LIST_CACHE_MAX_ENTRIES, ttlMs: 30_000 });
    const itemCache = yield* makeKeyedSingleFlightCache<
      CachedExactSummary,
      PullRequestProviderError
    >({
      maxEntries: PULL_REQUEST_PIN_ITEM_CACHE_MAX_ENTRIES,
      ttlMs: (result) => (result._tag === "not-found" ? 30_000 : 15_000),
    });
    const reviewMatchCache = yield* makeKeyedSingleFlightCache<
      ProviderReviewRequestsResult,
      PullRequestProviderError
    >({ maxEntries: PULL_REQUEST_REVIEW_MATCH_CACHE_MAX_ENTRIES, ttlMs: 15_000 });
    const mergeCapabilitiesCache = yield* makeKeyedSingleFlightCache<
      PullRequestDetail["mergeCapabilities"],
      PullRequestProviderError
    >({ maxEntries: PULL_REQUEST_MERGE_CAPABILITIES_CACHE_MAX_ENTRIES, ttlMs: 5 * 60_000 });

    const viewer: NonNullable<PullRequestProviderShape["viewer"]> = (input) =>
      Effect.gen(function* () {
        if (input.forceRefresh) yield* viewerCache.invalidateAll;
        return yield* viewerCache.get(
          "viewer",
          withRead(
            normalizeGitHubError(
              dependencies.github.getViewerLogin({ cwd: dependencies.homeDir }),
              null,
            ),
          ),
        );
      });

    const loadList = (input: {
      readonly cwd: string;
      readonly repository: RemoteRepositoryRef;
      readonly state: "open" | "closed" | "merged";
      readonly involvement: "all" | "authored" | "reviewing";
      readonly viewer: string | null;
    }) => {
      const key = pullRequestListCacheKey(
        "github",
        repositoryName(input.repository),
        input.state,
        input.involvement,
        viewerLogin(input.viewer),
      );
      return listCache.get(
        key,
        withRead(
          normalizeGitHubError(
            dependencies.github.listRepositoryPullRequests({
              cwd: input.cwd,
              repository: repositoryName(input.repository),
              state: input.state,
              involvement: input.involvement,
              viewer: viewerLogin(input.viewer),
              limit: PULL_REQUEST_LIST_LIMIT + 1,
            }),
            input.repository,
          ),
        ).pipe(
          Effect.map((result) => ({
            entries: result.entries.slice(0, PULL_REQUEST_LIST_LIMIT),
            // Measure cardinality before tolerant GitHub decoding drops malformed entries.
            truncated: result.rawCount > PULL_REQUEST_LIST_LIMIT,
          })),
        ),
      );
    };

    const list: PullRequestProviderShape["list"] = (input) =>
      Effect.gen(function* () {
        if (input.forceRefresh) {
          yield* Effect.forEach(
            pullRequestListForceRefreshCacheKeys({
              provider: "github",
              repository: repositoryName(input.repository),
              state: input.state,
              viewer: viewerLogin(input.viewer),
            }),
            (key) => listCache.invalidate(key),
            { concurrency: "unbounded", discard: true },
          );
        }
        const [result, reviewingResult] = yield* Effect.all(
          [
            loadList(input),
            shouldLoadReviewingCompanion(input.state, input.involvement)
              ? loadList({ ...input, involvement: "reviewing" })
              : Effect.succeed(null),
          ],
          { concurrency: 2 },
        );
        const reviewingNumbers = new Set(
          (reviewingResult ?? (input.involvement === "reviewing" ? result : null))?.entries.map(
            (entry) => entry.number,
          ) ?? [],
        );
        return {
          entries: result.entries.map((entry) =>
            toProviderSummary({
              repository: input.repository,
              item: entry,
              viewer: viewerLogin(input.viewer),
              matchedReviewingQuery:
                input.involvement === "reviewing" || reviewingNumbers.has(entry.number),
            }),
          ),
          truncated: result.truncated,
          reviewingNumbers,
          reviewingTruncated:
            reviewingResult?.truncated === true ||
            (input.involvement === "reviewing" && result.truncated),
        } satisfies ProviderListResult;
      });

    const exactSummary: PullRequestProviderShape["exactSummary"] = (input) =>
      Effect.gen(function* () {
        const key = repositoryPullRequestIdentityKey({
          provider: "github",
          repository: repositoryName(input.repository),
          number: input.number,
        });
        if (input.forceRefresh) yield* itemCache.invalidate(key);
        const result = yield* itemCache.get(
          key,
          withRead(
            dependencies.github
              .getPullRequestListItem({
                cwd: input.cwd,
                repository: repositoryName(input.repository),
                number: input.number,
              })
              .pipe(
                Effect.map((item): CachedExactSummary => ({ _tag: "found", item })),
                Effect.catch((error) =>
                  isDefinitivePullRequestNotFound(error)
                    ? Effect.succeed<CachedExactSummary>({ _tag: "not-found" })
                    : Effect.fail(providerError(error, input.repository)),
                ),
              ),
          ),
        );
        if (result._tag === "not-found") return result;
        return {
          _tag: "found",
          summary: toProviderSummary({
            repository: input.repository,
            item: result.item,
            viewer: viewerLogin(input.viewer),
            matchedReviewingQuery: input.matchedReviewingQuery,
          }),
        } satisfies ProviderExactSummaryResult;
      });

    const reviewRequests: NonNullable<PullRequestProviderShape["reviewRequests"]> = (input) =>
      Effect.gen(function* () {
        const key = pullRequestListCacheKey(
          "github",
          repositoryName(input.repository),
          "open",
          "reviewing",
          viewerLogin(input.viewer),
        );
        if (input.forceRefresh) yield* reviewMatchCache.invalidate(key);
        return yield* reviewMatchCache.get(
          key,
          withRead(
            normalizeGitHubError(
              dependencies.github.listReviewRequestedPullRequestNumbers({
                cwd: input.cwd,
                repository: repositoryName(input.repository),
                viewer: viewerLogin(input.viewer),
                limit: PULL_REQUEST_REVIEW_MATCH_LIMIT,
              }),
              input.repository,
            ),
          ).pipe(
            Effect.map((numbers) => ({
              numbers: new Set(numbers),
              incomplete: numbers.length >= PULL_REQUEST_REVIEW_MATCH_LIMIT,
            })),
          ),
        );
      });

    const reviewRequestCount: NonNullable<PullRequestProviderShape["reviewRequestCount"]> = (
      input,
    ) =>
      reviewRequests(input).pipe(
        Effect.map((matches) => ({
          count: matches.numbers.size,
          incomplete: matches.incomplete,
        })),
      );

    const loadMergeCapabilities = (input: {
      readonly cwd: string;
      readonly repository: RemoteRepositoryRef;
    }) =>
      mergeCapabilitiesCache.get(
        repositoryName(input.repository).trim().toLowerCase(),
        withRead(
          normalizeGitHubError(
            dependencies.github.getRepositoryMergeCapabilities({
              cwd: input.cwd,
              repository: repositoryName(input.repository),
            }),
            input.repository,
          ),
        ),
      );

    const loadStack = (input: {
      readonly cwd: string;
      readonly repository: RemoteRepositoryRef;
      readonly number: number;
    }) =>
      withRead(
        normalizeGitHubError(
          dependencies.github.getPullRequestStack({
            cwd: input.cwd,
            repository: repositoryName(input.repository),
            number: input.number,
          }),
          input.repository,
        ),
      );

    const detail: PullRequestProviderShape["detail"] = (input) =>
      Effect.gen(function* () {
        const [detailResult, mergeCapabilities, reviewCommentsResult, stackResult] =
          yield* Effect.all(
            [
              withRead(
                normalizeGitHubError(
                  dependencies.github.getPullRequestDetail({
                    cwd: input.project.workspaceRoot,
                    repository: repositoryName(input.repository),
                    number: input.number,
                  }),
                  input.repository,
                ),
              ),
              loadMergeCapabilities({
                cwd: input.project.workspaceRoot,
                repository: input.repository,
              }),
              withRead(
                normalizeGitHubError(
                  dependencies.github.getPullRequestReviewComments({
                    cwd: input.project.workspaceRoot,
                    host: input.repository.host,
                    owner: input.repository.owner,
                    repo: input.repository.slug,
                    number: input.number,
                  }),
                  input.repository,
                ),
              ).pipe(
                Effect.map((result) => ({ ...result, incomplete: false })),
                Effect.catch(() =>
                  Effect.succeed({ comments: [], truncated: false, incomplete: true }),
                ),
              ),
              loadStack({
                cwd: input.project.workspaceRoot,
                repository: input.repository,
                number: input.number,
              }).pipe(
                Effect.map((stack) => ({ stack, incomplete: false as const })),
                Effect.catch(() => Effect.succeed({ stack: null, incomplete: true as const })),
              ),
            ],
            { concurrency: 4 },
          );
        const comments = [
          ...detailResult.comments,
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
            createdAt: comment.createdAt ?? detailResult.updatedAt,
            updatedAt: null,
            url: comment.url,
            path: comment.path,
            reviewState: null,
          })),
        ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
        return {
          projectId: input.project.id,
          projectTitle: input.project.title,
          workspaceRoot: input.project.workspaceRoot,
          provider: "github",
          capabilities: LEGACY_GITHUB_PULL_REQUEST_CAPABILITIES,
          repository: repositoryName(input.repository),
          ...detailResult,
          comments,
          commentsTruncated: reviewCommentsResult.truncated,
          commentsIncomplete: reviewCommentsResult.incomplete,
          mergeCapabilities,
          stack: stackResult.stack,
          stackMetadataIncomplete: stackResult.incomplete,
        } satisfies PullRequestDetail;
      });

    const diff: PullRequestProviderShape["diff"] = (input) =>
      withRead(
        normalizeGitHubError(
          dependencies.github.getPullRequestDiff({
            cwd: input.project.workspaceRoot,
            repository: repositoryName(input.repository),
            number: input.number,
          }),
          input.repository,
        ),
      );

    const finalizeMutationCaches = (
      repository: RemoteRepositoryRef,
      number: number,
      invalidateReviewMatches: boolean,
    ) =>
      Effect.uninterruptible(
        Effect.all(
          [
            listCache.invalidateWhere((key) =>
              listCacheKeyBelongsToRepository(key, repositoryName(repository)),
            ),
            ...(invalidateReviewMatches
              ? [
                  reviewMatchCache.invalidateWhere((key) =>
                    listCacheKeyBelongsToRepository(key, repositoryName(repository)),
                  ),
                ]
              : []),
            itemCache.invalidate(
              repositoryPullRequestIdentityKey({
                provider: "github",
                repository: repositoryName(repository),
                number,
              }),
            ),
          ],
          { concurrency: 3, discard: true },
        ),
      );

    const action: NonNullable<PullRequestProviderShape["action"]> = (input) =>
      Effect.gen(function* () {
        if (input.action === "merge") {
          const mergeMethod = input.mergeMethod ?? "merge";
          const capabilities = yield* loadMergeCapabilities({
            cwd: input.project.workspaceRoot,
            repository: input.repository,
          });
          if (!isPullRequestMergeMethodAllowed(capabilities, mergeMethod)) {
            return yield* Effect.fail(
              new Error(`The repository does not allow the ${mergeMethod} merge method.`),
            );
          }
          yield* loadStack({
            cwd: input.project.workspaceRoot,
            repository: input.repository,
            number: input.number,
          });
        }
        const result = yield* normalizeGitHubError(
          dependencies.github.runPullRequestAction({
            cwd: input.project.workspaceRoot,
            repository: repositoryName(input.repository),
            number: input.number,
            action: input.action,
            ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
          }),
          input.repository,
        ).pipe(Effect.ensuring(finalizeMutationCaches(input.repository, input.number, true)));
        return {
          projectId: input.project.id,
          provider: "github",
          repository: repositoryName(input.repository),
          number: input.number,
          workspaceRoot: input.project.workspaceRoot,
          mergeOutcome: result.mergeOutcome,
        };
      });

    const comment: NonNullable<PullRequestProviderShape["comment"]> = (input) =>
      normalizeGitHubError(
        dependencies.github.commentOnPullRequest({
          cwd: input.project.workspaceRoot,
          repository: repositoryName(input.repository),
          number: input.number,
          body: input.body,
        }),
        input.repository,
      ).pipe(
        Effect.ensuring(finalizeMutationCaches(input.repository, input.number, false)),
        Effect.as({
          projectId: input.project.id,
          provider: "github" as const,
          repository: repositoryName(input.repository),
          number: input.number,
          workspaceRoot: input.project.workspaceRoot,
          mergeOutcome: null,
        }),
      );

    return {
      provider: "github",
      host: "github.com",
      supports: (repository) =>
        repository.provider === "github" && repository.host.trim().toLowerCase() === "github.com",
      viewer,
      list,
      exactSummary,
      reviewRequests,
      reviewRequestCount,
      detail,
      diff,
      action,
      comment,
    } satisfies PullRequestProviderShape;
  });

export const GitHubPullRequestProviderLive = Layer.effect(
  GitHubPullRequestProvider,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const github = yield* GitHubCli;
    return yield* makeGitHubPullRequestProvider({ homeDir: config.homeDir, github });
  }),
);
