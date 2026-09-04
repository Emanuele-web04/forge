import type { ProjectId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  invalidateOtherPullRequestListQueries,
  pullRequestDetailQueryOptions,
  pullRequestQueryErrorState,
  pullRequestQueryKeys,
  prefetchPullRequestListState,
  pullRequestReviewRequestCountQueryOptions,
  pullRequestsExactInvolvementQueryOptions,
  pullRequestsListQueryOptions,
  shouldLoadExactPullRequestInvolvement,
} from "./pullRequestReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pull request list query options", () => {
  it("never reuses another filter's rows as placeholders", () => {
    // Cross-key placeholders rendered actionable rows under the wrong state/involvement
    // heading; both list options must go to the network (or warm cache) instead.
    expect(
      pullRequestsListQueryOptions({ state: "closed", projectId: null }).placeholderData,
    ).toBeUndefined();
    expect(
      pullRequestsExactInvolvementQueryOptions({
        involvement: "reviewing",
        state: "open",
        projectId: null,
      }).placeholderData,
    ).toBeUndefined();
  });

  it("keeps an exact involvement fallback fresh while it remains mounted", () => {
    const options = pullRequestsExactInvolvementQueryOptions({
      involvement: "authored",
      state: "open",
      projectId: null,
    });

    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.refetchOnReconnect).toBe("always");
  });

  it("disables detail polling and focus refresh while its dock is collapsed", () => {
    const options = pullRequestDetailQueryOptions(
      {
        projectId: "project-a" as ProjectId,
        provider: "github",
        repository: "acme/widgets",
        number: 42,
      },
      { pollingEnabled: false },
    );

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
  });

  it("keeps stale data visible when a background refresh fails", () => {
    const error = new Error("refresh failed");
    expect(pullRequestQueryErrorState({ data: { entries: [] }, error, isError: true })).toEqual({
      initialError: null,
      backgroundError: error,
    });
    expect(pullRequestQueryErrorState({ data: undefined, error, isError: true })).toEqual({
      initialError: error,
      backgroundError: null,
    });
  });

  it("prefetches only the state named by user intent", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);
    const projectA = "project-a" as ProjectId;

    await prefetchPullRequestListState(queryClient, {
      state: "closed",
      projectId: projectA,
    });

    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    expect(prefetchQuery.mock.calls[0]?.[0].queryKey).toEqual(
      pullRequestQueryKeys.list({ state: "closed", projectId: projectA }),
    );
  });

  it("keeps aggregate list keys provider-neutral but scopes detail and diff by provider", () => {
    const projectId = "project-a" as ProjectId;
    const github = {
      projectId,
      provider: "github",
      repository: "acme/widgets",
      number: 42,
    } as const;
    const bitbucket = { ...github, provider: "bitbucket" } as const;

    expect(pullRequestQueryKeys.list({ state: "open", projectId: null })).toEqual([
      "pull-requests",
      "list",
      "open",
      null,
    ]);
    expect(pullRequestQueryKeys.detail(github)).not.toEqual(pullRequestQueryKeys.detail(bitbucket));
    expect(pullRequestQueryKeys.diff(github)).not.toEqual(pullRequestQueryKeys.diff(bitbucket));
  });

  it("uses a compact, independently cached review-request count query", () => {
    const options = pullRequestReviewRequestCountQueryOptions({ projectId: null });
    expect(options.queryKey).toEqual(pullRequestQueryKeys.reviewRequestCount(null));
    expect(options.staleTime).toBe(5 * 60_000);
    expect(options.refetchInterval).toBe(5 * 60_000);
  });

  it("skips the known-empty reviewing fallback for closed and merged states", () => {
    expect(
      shouldLoadExactPullRequestInvolvement({
        involvement: "reviewing",
        state: "closed",
        supersetTruncated: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadExactPullRequestInvolvement({
        involvement: "reviewing",
        state: "open",
        supersetTruncated: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadExactPullRequestInvolvement({
        involvement: "authored",
        state: "merged",
        supersetTruncated: true,
      }),
    ).toBe(true);
  });
});

describe("invalidateOtherPullRequestListQueries", () => {
  it("invalidates only same-state, same-project list siblings", async () => {
    const queryClient = new QueryClient();
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const refreshedKey = pullRequestQueryKeys.list({ state: "open", projectId: projectA });
    const exactSiblingKey = pullRequestsExactInvolvementQueryOptions({
      involvement: "reviewing",
      state: "open",
      projectId: projectA,
    }).queryKey;
    const otherStateKey = pullRequestQueryKeys.list({ state: "merged", projectId: projectA });
    const otherProjectKey = pullRequestQueryKeys.list({ state: "open", projectId: projectB });
    const detailInput = {
      projectId: projectA,
      provider: "github",
      repository: "acme/widgets",
      number: 42,
    } as const;
    const detailKey = pullRequestQueryKeys.detail(detailInput);
    const diffKey = pullRequestQueryKeys.diff(detailInput);
    for (const key of [
      refreshedKey,
      exactSiblingKey,
      otherStateKey,
      otherProjectKey,
      detailKey,
      diffKey,
    ]) {
      queryClient.setQueryData(key, { entries: [] });
    }

    await invalidateOtherPullRequestListQueries(queryClient, refreshedKey);

    expect(queryClient.getQueryState(refreshedKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(exactSiblingKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherStateKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(false);
  });
});
