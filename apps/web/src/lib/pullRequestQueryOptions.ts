import type {
  ProjectId,
  PullRequestDetailInput,
  PullRequestInvolvement,
  PullRequestReviewDraftListInput,
  PullRequestState,
} from "@synara/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  list: (input: { state: PullRequestState; projectId: ProjectId | null }) =>
    ["pull-requests", "list", input.state, input.projectId] as const,
  exactList: (input: {
    involvement: PullRequestInvolvement;
    state: PullRequestState;
    projectId: ProjectId | null;
  }) =>
    ["pull-requests", "list-involvement", input.involvement, input.state, input.projectId] as const,
  reviewRequestCounts: ["pull-requests", "review-request-count"] as const,
  reviewRequestCount: (projectId: ProjectId | null) =>
    [...pullRequestQueryKeys.reviewRequestCounts, projectId] as const,
  detail: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "detail",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  diff: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "diff",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  reviewDrafts: (input: PullRequestReviewDraftListInput | null) =>
    ["pull-requests", "review-drafts", input?.repository ?? null, input?.number ?? null] as const,
};

export const PULL_REQUEST_STATES: readonly PullRequestState[] = ["open", "closed", "merged"];

/** Distinguish a cold-load failure from a background failure with usable cached data. */
export function pullRequestQueryErrorState<TData, TError>(
  query: { data: TData | undefined; error: TError | null; isError: boolean },
  enabled = true,
): { initialError: TError | null; backgroundError: TError | null } {
  if (!enabled || !query.isError) return { initialError: null, backgroundError: null };
  return query.data === undefined
    ? { initialError: query.error, backgroundError: null }
    : { initialError: null, backgroundError: query.error };
}

export function normalizePullRequestListKeyInput(input: {
  state: PullRequestState;
  projectId?: ProjectId | null | undefined;
}) {
  return {
    state: input.state,
    projectId: input.projectId ?? null,
  };
}

export function shouldLoadExactPullRequestInvolvement(input: {
  involvement: PullRequestInvolvement;
  state: PullRequestState;
  supersetTruncated: boolean;
}): boolean {
  return (
    input.supersetTruncated &&
    input.involvement !== "all" &&
    (input.involvement !== "reviewing" || input.state === "open")
  );
}

export function pullRequestsListQueryOptions(input: {
  state: PullRequestState;
  projectId: ProjectId | null;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.list(input),
    queryFn: () =>
      ensureNativeApi().pullRequests.list({
        involvement: "all",
        state: input.state,
        projectId: input.projectId,
      }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}

/** Precise fallback for a filtered tab whose all-involvement superset was truncated. */
export function pullRequestsExactInvolvementQueryOptions(input: {
  involvement: PullRequestInvolvement;
  state: PullRequestState;
  projectId: ProjectId | null;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.exactList(input),
    queryFn: () => ensureNativeApi().pullRequests.list(input),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}

export function pullRequestReviewRequestCountQueryOptions(input: { projectId: ProjectId | null }) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.reviewRequestCount(input.projectId),
    queryFn: () => ensureNativeApi().pullRequests.reviewRequestCount(input),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}

/** Warm one destination state only after the user points at or focuses its tab. */
export function prefetchPullRequestListState(
  queryClient: QueryClient,
  input: { state: PullRequestState; projectId: ProjectId | null },
) {
  return queryClient.prefetchQuery(pullRequestsListQueryOptions(input));
}

export function pullRequestDetailQueryOptions(
  input: PullRequestDetailInput | null,
  behavior: { pollingEnabled?: boolean } = {},
) {
  const pollingEnabled = behavior.pollingEnabled ?? true;
  return queryOptions({
    queryKey: pullRequestQueryKeys.detail(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request detail is unavailable.");
      return ensureNativeApi().pullRequests.detail(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    refetchInterval: pollingEnabled ? 60_000 : false,
    refetchOnWindowFocus: pollingEnabled,
    refetchOnReconnect: pollingEnabled,
  });
}

export function pullRequestDiffQueryOptions(input: PullRequestDetailInput | null) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.diff(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request diff is unavailable.");
      return ensureNativeApi().pullRequests.diff(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function pullRequestReviewDraftsQueryOptions(
  input: PullRequestReviewDraftListInput | null,
  enabled = true,
) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.reviewDrafts(input),
    queryFn: () => {
      if (!input) throw new Error("Pull request review drafts are unavailable.");
      return ensureNativeApi().pullRequests.listReviewDrafts(input);
    },
    enabled: enabled && input !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}
