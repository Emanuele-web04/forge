import type {
  PullRequestProvider,
  PullRequestActor,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestState,
  PullRequestViewerInvolvement,
} from "@synara/contracts";
import {
  pullRequestProjectIdentityKey as sharedPullRequestProjectIdentityKey,
  pullRequestRemoteIdentityKey as sharedPullRequestRemoteIdentityKey,
} from "@synara/shared/githubRepository";

import type { ProviderPullRequestSummary } from "./pullRequests/Services/PullRequestProvider.ts";
import { pullRequestPinRepositoryKey } from "./pullRequests/projectRepositoryInventory.ts";
export { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";

export function pullRequestListCacheKey(
  provider: PullRequestProvider,
  repository: string,
  state: PullRequestState,
  involvement: PullRequestInvolvement,
  viewer: string,
): string {
  return `${provider}:${repository.trim().toLowerCase()}:${state}:${involvement}:${viewer.trim().toLowerCase()}`;
}

/** A force refresh invalidates every sibling involvement cache for the same repository/state.
 * The caller still decides which involvement queries are actually needed for the response. */
export function pullRequestListForceRefreshCacheKeys(input: {
  provider: PullRequestProvider;
  repository: string;
  state: PullRequestState;
  viewer: string;
}): string[] {
  return (["all", "authored", "reviewing"] as const).map((involvement) =>
    pullRequestListCacheKey(
      input.provider,
      input.repository,
      input.state,
      involvement,
      input.viewer,
    ),
  );
}

/** Repository-wide PR identity used to coalesce the same remote lookup across local projects. */
export function repositoryPullRequestIdentityKey(input: {
  provider: PullRequestProvider;
  repository: string;
  number: number;
}): string {
  return sharedPullRequestRemoteIdentityKey(input);
}

/** Stable project-local identity for a pull request. Repository casing is not significant on
 * GitHub, while the project id deliberately remains part of the key so two projects pointing at
 * the same repository can prioritize the same PR independently. */
export function projectPullRequestIdentityKey(input: {
  projectId: string;
  provider: PullRequestProvider;
  repository: string;
  number: number;
}): string {
  return sharedPullRequestProjectIdentityKey(input);
}

/** Select only pins whose own project/repository batch was cut off by the list cap. This keeps
 * recovery from probing complete lists, and prevents a stale project pin from borrowing a matching
 * repository that happens to be configured by a different project in the same aggregate request. */
export function selectRecoverablePullRequestPins<
  P extends string,
  T extends {
    projectId: P;
    provider: PullRequestProvider;
    repositoryKey: string;
    number: number;
  },
>(input: {
  pins: ReadonlyArray<T>;
  presentKeys: ReadonlySet<string>;
  repositoryKeysByProject: ReadonlyMap<P, ReadonlySet<string>>;
  batches: ReadonlyArray<{
    provider?: PullRequestProvider;
    repository: string;
    truncated: boolean;
    projectIds: ReadonlyArray<P>;
  }>;
}): T[] {
  const batches = new Map(
    input.batches.map(
      (batch) =>
        [
          `${batch.provider ?? "github"}\u0000${batch.repository.trim().toLowerCase()}`,
          batch,
        ] as const,
    ),
  );
  return input.pins.filter((pin) => {
    const repository = pin.repositoryKey.trim().toLowerCase();
    const provider = pin.provider;
    const batch = batches.get(`${provider}\u0000${repository}`);
    return (
      batch?.truncated === true &&
      batch.projectIds.includes(pin.projectId) &&
      input.repositoryKeysByProject
        .get(pin.projectId)
        ?.has(pullRequestPinRepositoryKey(provider, repository)) === true &&
      !input.presentKeys.has(
        projectPullRequestIdentityKey({
          projectId: pin.projectId,
          provider,
          repository,
          number: pin.number,
        }),
      )
    );
  });
}

/** One mapping from a provider summary to the wire entry, shared by the capped batch path and the
 * individual pinned-PR recovery path so the two can never drift. */
export function buildPullRequestListEntry(input: {
  project: { id: PullRequestListEntry["projectId"]; title: string };
  pullRequest: ProviderPullRequestSummary;
  isPinned: boolean;
}): PullRequestListEntry {
  const { pullRequest } = input;
  return {
    ...pullRequest,
    projectId: input.project.id,
    projectTitle: input.project.title,
    viewerReviewRequested: pullRequest.viewerInvolvement === "review-requested",
    isPinned: input.isPinned,
    projectContexts: [
      {
        projectId: input.project.id,
        projectTitle: input.project.title,
        isPinned: input.isPinned,
      },
    ],
  };
}

/** Pinned work is the first thing the user sees; each section otherwise retains the existing
 * newest-updated-first ordering. */
export function orderPullRequestListEntries(
  entries: readonly PullRequestListEntry[],
): PullRequestListEntry[] {
  return [...entries].toSorted(
    (left, right) =>
      Number(right.isPinned) - Number(left.isPinned) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function isViewerReviewRequested(
  author: PullRequestActor | null,
  reviewRequestLogins: ReadonlyArray<string>,
  viewer: string,
  matchedReviewingQuery = false,
): boolean {
  const normalizedViewer = viewer.trim().toLowerCase();
  return (
    author?.login.trim().toLowerCase() !== normalizedViewer &&
    (matchedReviewingQuery ||
      reviewRequestLogins.some((login) => login.trim().toLowerCase() === normalizedViewer))
  );
}

export function resolvePullRequestViewerInvolvement(
  author: PullRequestActor | null,
  reviewRequestLogins: ReadonlyArray<string>,
  viewer: string,
  matchedReviewingQuery = false,
): PullRequestViewerInvolvement {
  const normalizedViewer = viewer.trim().toLowerCase();
  if (author?.login.trim().toLowerCase() === normalizedViewer) {
    return "author";
  }
  return isViewerReviewRequested(author, reviewRequestLogins, viewer, matchedReviewingQuery)
    ? "review-requested"
    : "none";
}

/** Whether one exact PR belongs in an involvement-filtered result. `matchedReviewingQuery` carries
 * GitHub's authoritative search result when it is available, including team review requests that
 * cannot be inferred from the individual PR's user-only review-request logins. */
export function pullRequestMatchesInvolvement(
  pullRequest: {
    readonly author?: PullRequestActor | null;
    readonly reviewRequestLogins?: ReadonlyArray<string>;
    readonly viewerInvolvement?: PullRequestViewerInvolvement;
  },
  involvement: PullRequestInvolvement,
  viewer: string,
  matchedReviewingQuery = false,
): boolean {
  if (involvement === "all") return true;
  if (pullRequest.viewerInvolvement === "unknown") return false;
  if (pullRequest.viewerInvolvement === "author") return involvement === "authored";
  if (pullRequest.viewerInvolvement === "review-requested") return involvement === "reviewing";
  if (pullRequest.viewerInvolvement === "none") return false;
  if (involvement === "reviewing") {
    return isViewerReviewRequested(
      pullRequest.author ?? null,
      pullRequest.reviewRequestLogins ?? [],
      viewer,
      matchedReviewingQuery,
    );
  }
  return pullRequest.author?.login.trim().toLowerCase() === viewer.trim().toLowerCase();
}

/** Closed and merged PRs cannot have an active review request, so the companion query only adds
 * information to the open all-involvement list. */
export function shouldLoadReviewingCompanion(
  state: PullRequestState,
  involvement: PullRequestInvolvement,
): boolean {
  return state === "open" && involvement === "all";
}

export function isPullRequestMergeMethodAllowed(
  capabilities: PullRequestMergeCapabilities,
  method: PullRequestMergeMethod,
): boolean {
  return capabilities[method];
}
