import {
  READ_ONLY_PULL_REQUEST_CAPABILITIES,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestDetail,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect, Layer, Scope, ServiceMap } from "effect";

import {
  McpConnectionService,
  McpConnectionServiceError,
  type McpConnectionServiceShape,
} from "../../outboundMcp/Services/McpConnectionService.ts";
import { makeKeyedSingleFlightCache } from "../KeyedSingleFlightCache.ts";
import {
  PullRequestProviderError,
  type ProviderExactSummaryResult,
  type ProviderListResult,
  type ProviderPullRequestSummary,
  type PullRequestProviderErrorReason,
  type PullRequestProviderShape,
} from "../Services/PullRequestProvider.ts";
import { PARATY_BITBUCKET_CONSUMER_ID } from "./paratyBitbucketBinding.ts";
import type {
  ParatyBitbucketActor,
  ParatyBitbucketComment,
  ParatyBitbucketDiff,
  ParatyBitbucketPage,
  ParatyBitbucketPullRequest,
} from "./paratyBitbucketSchemas.ts";

const HOST = "bitbucket.org";
const WORKSPACE = "paraty";
const PAGE_LENGTH = 50;
const DIFF_CHARACTER_LIMIT = 1_000_000;
const CACHE_TTL_MS = 30_000;

type CachedList = {
  readonly entries: ReadonlyArray<ProviderPullRequestSummary>;
  readonly truncated: boolean;
};

export interface ParatyBitbucketPullRequestProviderDependencies {
  readonly mcp: McpConnectionServiceShape;
}

export class ParatyBitbucketPullRequestProvider extends ServiceMap.Service<
  ParatyBitbucketPullRequestProvider,
  PullRequestProviderShape
>()("synara/pullRequests/providers/ParatyBitbucketPullRequestProvider") {}

function repositoryName(repository: RemoteRepositoryRef): string {
  return repository.displayName;
}

function actor(value: ParatyBitbucketActor | null): PullRequestActor | null {
  if (value === null) return null;
  return {
    login: value.nickname ?? value.uuid,
    name: value.display_name,
    avatarUrl: value.links.avatar?.href ?? null,
    url: value.links.html?.href ?? null,
  };
}

function state(value: ParatyBitbucketPullRequest["state"]): "open" | "closed" | "merged" {
  if (value === "OPEN") return "open";
  if (value === "MERGED") return "merged";
  return "closed";
}

function remoteState(value: "open" | "closed" | "merged"): "OPEN" | "DECLINED" | "MERGED" {
  if (value === "open") return "OPEN";
  if (value === "merged") return "MERGED";
  return "DECLINED";
}

function summary(
  repository: RemoteRepositoryRef,
  pullRequest: ParatyBitbucketPullRequest,
): ProviderPullRequestSummary {
  return {
    provider: "bitbucket",
    capabilities: READ_ONLY_PULL_REQUEST_CAPABILITIES,
    repository: repositoryName(repository),
    number: pullRequest.id,
    title: pullRequest.title,
    url: pullRequest.links.html.href,
    author: actor(pullRequest.author),
    headBranch: pullRequest.source.branch.name,
    baseBranch: pullRequest.destination.branch.name,
    state: state(pullRequest.state),
    isDraft: pullRequest.draft ?? false,
    additions: null,
    deletions: null,
    createdAt: pullRequest.created_on,
    updatedAt: pullRequest.updated_on,
    reviewDecision: null,
    viewerInvolvement: "unknown",
    labels: [],
    mergeability: null,
    stack: null,
  };
}

function comment(value: ParatyBitbucketComment): PullRequestComment {
  return {
    id: String(value.id),
    kind: "issue-comment",
    author: actor(value.user),
    body: value.content.raw,
    createdAt: value.created_on,
    updatedAt: value.updated_on,
    url: value.links.html.href,
    path: null,
    reviewState: null,
  };
}

function reasonFor(category: string): PullRequestProviderErrorReason {
  if (category === "invalid-response" || category === "invalid-input") return "invalid-response";
  if (category === "incompatible-tools" || category === "incompatible") return "incompatible";
  if (category === "authorizing") return "authorizing";
  if (category === "not-connected") return "not-connected";
  if (category === "reconnect-required") return "reconnect-required";
  if (category === "temporarily-unavailable") return "temporarily-unavailable";
  return "temporarily-unavailable";
}

function errorCategory(error: unknown): string {
  return error instanceof McpConnectionServiceError
    ? error.category
    : typeof error === "object" &&
        error !== null &&
        "category" in error &&
        typeof error.category === "string"
      ? error.category
      : "temporarily-unavailable";
}

function providerError(
  error: unknown,
  operation: string,
  repository: RemoteRepositoryRef,
): PullRequestProviderError {
  const category = errorCategory(error);
  const reason = reasonFor(category);
  const global = reason !== "invalid-response";
  return new PullRequestProviderError({
    provider: "bitbucket",
    host: HOST,
    operation,
    repository: repositoryName(repository),
    scope: global ? "global" : "repository",
    reason,
    message:
      reason === "invalid-response"
        ? `Bitbucket returned an invalid response for ${repositoryName(repository)}.`
        : "The Paraty MCP Bitbucket connection is unavailable.",
  });
}

function invoke<A>(
  mcp: McpConnectionServiceShape,
  operation: string,
  args: Readonly<Record<string, unknown>>,
  repository: RemoteRepositoryRef,
): Effect.Effect<A, PullRequestProviderError> {
  return mcp.invoke(PARATY_BITBUCKET_CONSUMER_ID, operation, args).pipe(
    Effect.map((value) => value as A),
    Effect.catch((error) =>
      errorCategory(error) === "cancelled"
        ? Effect.interrupt
        : Effect.fail(providerError(error, operation, repository)),
    ),
  );
}

function commonArgs(repository: RemoteRepositoryRef, number: number) {
  return {
    workspace: WORKSPACE,
    repository: repository.slug,
    pull_request_id: number,
  } as const;
}

export const makeParatyBitbucketPullRequestProvider = (
  dependencies: ParatyBitbucketPullRequestProviderDependencies,
): Effect.Effect<PullRequestProviderShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const listCache = yield* makeKeyedSingleFlightCache<CachedList, PullRequestProviderError>({
      maxEntries: 128,
      ttlMs: CACHE_TTL_MS,
    });
    const detailCache = yield* makeKeyedSingleFlightCache<
      PullRequestDetail,
      PullRequestProviderError
    >({
      maxEntries: 128,
      ttlMs: CACHE_TTL_MS,
    });
    const diffCache = yield* makeKeyedSingleFlightCache<
      ParatyBitbucketDiff,
      PullRequestProviderError
    >({
      maxEntries: 64,
      ttlMs: CACHE_TTL_MS,
    });
    const invalidateAll = Effect.all(
      [listCache.invalidateAll, detailCache.invalidateAll, diffCache.invalidateAll],
      { discard: true },
    );
    let cacheEpoch = 0;
    const unsubscribe = yield* dependencies.mcp.subscribe((event) => {
      if (
        event.connectionId === "paraty" &&
        (event.type === "connected" || event.type === "disconnected")
      ) {
        cacheEpoch += 1;
        Effect.runFork(invalidateAll);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const loadList = (
      repository: RemoteRepositoryRef,
      requestedState: "open" | "closed" | "merged",
    ) =>
      invoke<ParatyBitbucketPage<ParatyBitbucketPullRequest>>(
        dependencies.mcp,
        "list",
        {
          workspace: WORKSPACE,
          repository: repository.slug,
          state: remoteState(requestedState),
          page: 1,
          pagelen: PAGE_LENGTH,
          sort: "-updated_on",
        },
        repository,
      ).pipe(
        Effect.map((result) => ({
          entries: result.values.slice(0, PAGE_LENGTH).map((entry) => summary(repository, entry)),
          truncated:
            result.next !== undefined ||
            result.size > PAGE_LENGTH ||
            result.values.length > PAGE_LENGTH ||
            result.malformedCount > 0,
        })),
      );

    const list: PullRequestProviderShape["list"] = (input) =>
      Effect.gen(function* () {
        if (input.involvement !== "all") {
          return yield* Effect.fail(
            new PullRequestProviderError({
              provider: "bitbucket",
              host: HOST,
              operation: "list",
              repository: repositoryName(input.repository),
              scope: "repository",
              reason: "other",
              message: "Bitbucket only supports the all pull request involvement filter.",
            }),
          );
        }
        const key = `${cacheEpoch}:${input.repository.identityKey}:${input.state}`;
        if (input.forceRefresh) yield* listCache.invalidate(key);
        const result = yield* listCache.get(key, loadList(input.repository, input.state));
        return {
          entries: result.entries,
          truncated: result.truncated,
          reviewingNumbers: new Set<number>(),
          reviewingTruncated: false,
        } satisfies ProviderListResult;
      });

    const exactSummary: PullRequestProviderShape["exactSummary"] = (input) =>
      invoke<ParatyBitbucketPullRequest>(
        dependencies.mcp,
        "detail",
        commonArgs(input.repository, input.number),
        input.repository,
      ).pipe(
        Effect.map(
          (result): ProviderExactSummaryResult => ({
            _tag: "found",
            summary: summary(input.repository, result),
          }),
        ),
      );

    const detail: PullRequestProviderShape["detail"] = (input) => {
      const key = JSON.stringify([
        cacheEpoch,
        input.repository.identityKey,
        input.number,
        input.project.id,
        input.project.title,
        input.project.workspaceRoot,
      ]);
      return detailCache.get(
        key,
        Effect.all(
          [
            invoke<ParatyBitbucketPullRequest>(
              dependencies.mcp,
              "detail",
              commonArgs(input.repository, input.number),
              input.repository,
            ),
            invoke<ParatyBitbucketPage<ParatyBitbucketComment>>(
              dependencies.mcp,
              "comments",
              {
                ...commonArgs(input.repository, input.number),
                page: 1,
                pagelen: PAGE_LENGTH,
              },
              input.repository,
            ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(
            ([pullRequest, comments]) =>
              ({
                projectId: input.project.id,
                projectTitle: input.project.title,
                workspaceRoot: input.project.workspaceRoot,
                provider: "bitbucket" as const,
                capabilities: READ_ONLY_PULL_REQUEST_CAPABILITIES,
                repository: repositoryName(input.repository),
                number: pullRequest.id,
                title: pullRequest.title,
                body: pullRequest.description,
                url: pullRequest.links.html.href,
                author: actor(pullRequest.author),
                state: state(pullRequest.state),
                isDraft: pullRequest.draft ?? false,
                mergeable: null,
                mergeability: null,
                mergeStateStatus: null,
                reviewDecision: null,
                additions: null,
                deletions: null,
                changedFiles: null,
                headBranch: pullRequest.source.branch.name,
                baseBranch: pullRequest.destination.branch.name,
                createdAt: pullRequest.created_on,
                updatedAt: pullRequest.updated_on,
                mergedAt: pullRequest.state === "MERGED" ? pullRequest.updated_on : null,
                closedAt: pullRequest.closed_on ?? null,
                maintainerCanModify: false,
                reviewers: pullRequest.reviewers
                  .map(actor)
                  .filter((entry): entry is PullRequestActor => entry !== null),
                labels: [],
                checks: null,
                comments: comments.values.slice(0, PAGE_LENGTH).map(comment),
                commentsTruncated:
                  comments.next !== undefined ||
                  comments.size > PAGE_LENGTH ||
                  comments.values.length > PAGE_LENGTH,
                commentsIncomplete: comments.malformedCount > 0,
                commits: [],
                mergeCapabilities: {
                  merge: false,
                  squash: false,
                  rebase: false,
                  deleteBranchOnMerge: false,
                },
                stack: null,
                stackMetadataIncomplete: false,
              }) satisfies PullRequestDetail,
          ),
        ),
      );
    };

    const diff: PullRequestProviderShape["diff"] = (input) => {
      const key = `${cacheEpoch}:${input.repository.identityKey}:${input.number}`;
      return diffCache
        .get(
          key,
          invoke<ParatyBitbucketDiff>(
            dependencies.mcp,
            "diff",
            commonArgs(input.repository, input.number),
            input.repository,
          ),
        )
        .pipe(
          Effect.map((result) => ({
            patch: result.patch.slice(0, DIFF_CHARACTER_LIMIT),
            truncated: result.truncated || result.patch.length > DIFF_CHARACTER_LIMIT,
          })),
        );
    };

    return {
      provider: "bitbucket",
      host: HOST,
      supports: (candidate) =>
        candidate.provider === "bitbucket" &&
        candidate.host.trim().toLowerCase() === HOST &&
        candidate.owner.trim().toLowerCase() === WORKSPACE,
      list,
      exactSummary,
      detail,
      diff,
    } satisfies PullRequestProviderShape;
  });

export const ParatyBitbucketPullRequestProviderLive = Layer.effect(
  ParatyBitbucketPullRequestProvider,
  Effect.gen(function* () {
    const mcp = yield* McpConnectionService;
    return yield* makeParatyBitbucketPullRequestProvider({ mcp });
  }),
);
