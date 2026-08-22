import type { ProjectId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { gitQueryKeys } from "./gitReactQuery";
import { pullRequestActionMutationOptions, pullRequestQueryKeys } from "./pullRequestReactQuery";

describe("pullRequestActionMutationOptions", () => {
  it("cancels an ordinary list refetch before applying optimistic fields", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false }],
    });
    let listRequestAborted = false;
    const refetch = queryClient
      .fetchQuery({
        queryKey: listKey,
        queryFn: ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              listRequestAborted = true;
              reject(new Error("aborted"));
            });
          }),
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: listKey })).toBe(1));
    const input = { ...identity, action: "draft" } as const;
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate) throw new Error("Action onMutate hook is missing.");

    await Reflect.apply(options.onMutate, undefined, [input, undefined]);

    expect(listRequestAborted).toBe(true);
    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, state: "open", isDraft: true, isPinned: false }],
    });
    await refetch;
  });

  it("invalidates only repository scopes, matching detail, and the affected git PR cache", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const otherProjectId = "project-b" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const unrelatedListKey = pullRequestQueryKeys.list({
      state: "open",
      projectId: otherProjectId,
    });
    const detailKey = pullRequestQueryKeys.detail(input);
    const otherDetailKey = pullRequestQueryKeys.detail({
      projectId,
      repository: "acme/widgets",
      number: 7,
    });
    const diffKey = pullRequestQueryKeys.diff(input);
    const reviewCountKey = pullRequestQueryKeys.reviewRequestCount(null);
    const gitStatusKey = gitQueryKeys.status("/repo");
    const gitPullRequestKey = gitQueryKeys.pullRequest("/repo");
    const unrelatedGitPullRequestKey = gitQueryKeys.pullRequest("/other-repo");
    queryClient.setQueryData(listKey, {
      entries: [
        {
          projectId,
          repository: "acme/widgets",
          number: 42,
          state: "open",
          isDraft: true,
          isPinned: false,
        },
      ],
    });
    queryClient.setQueryData(unrelatedListKey, {
      entries: [
        {
          projectId: otherProjectId,
          repository: "other/repository",
          number: 9,
          state: "open",
          isDraft: false,
          isPinned: false,
        },
      ],
    });
    for (const key of [
      detailKey,
      otherDetailKey,
      diffKey,
      reviewCountKey,
      gitStatusKey,
      gitPullRequestKey,
      unrelatedGitPullRequestKey,
    ]) {
      queryClient.setQueryData(key, {});
    }
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedListKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherDetailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(reviewCountKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(gitStatusKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(gitPullRequestKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedGitPullRequestKey)?.isInvalidated).toBe(false);
  });

  it("invalidates every cached detail in the repository after an atomic merge", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "merge",
      mergeMethod: "squash",
    } as const;
    const selectedDetail = pullRequestQueryKeys.detail(input);
    const lowerStackDetail = pullRequestQueryKeys.detail({
      projectId,
      repository: "acme/widgets",
      number: 41,
    });
    const unrelatedDetail = pullRequestQueryKeys.detail({
      projectId,
      repository: "acme/other",
      number: 41,
    });
    for (const key of [selectedDetail, lowerStackDetail, unrelatedDetail]) {
      queryClient.setQueryData(key, {});
    }

    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");
    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo", mergeOutcome: "merged" },
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryState(selectedDetail)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(lowerStackDetail)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelatedDetail)?.isInvalidated).toBe(false);
  });

  it("updates the global row when an action starts from another associated project", async () => {
    const queryClient = new QueryClient();
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const input = {
      projectId: projectA,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const globalListKey = pullRequestQueryKeys.list({ state: "open", projectId: null });
    queryClient.setQueryData(globalListKey, {
      entries: [
        {
          projectId: projectB,
          repository: "acme/widgets",
          number: 42,
          state: "open",
          isDraft: true,
          isPinned: false,
        },
      ],
    });
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    expect(queryClient.getQueryData(globalListKey)).toMatchObject({
      entries: [{ projectId: projectB, isDraft: false }],
    });
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);
    expect(queryClient.getQueryState(globalListKey)?.isInvalidated).toBe(true);
  });

  it("does not keep an action pending on the passive review-count refresh", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "ready",
    } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    queryClient.setQueryData(listKey, {
      entries: [{ ...input, state: "open", isDraft: true, isPinned: false }],
    });
    const originalInvalidateQueries = queryClient.invalidateQueries.bind(queryClient);
    let reviewCountRefreshStarted = false;
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters, options) => {
      if (filters?.queryKey === pullRequestQueryKeys.reviewRequestCounts) {
        reviewCountRefreshStarted = true;
        return new Promise<void>(() => undefined);
      }
      return originalInvalidateQueries(filters, options);
    });
    const mutation = pullRequestActionMutationOptions(queryClient);
    if (!mutation.onMutate || !mutation.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(mutation.onMutate, undefined, [input, undefined]);
    await Reflect.apply(mutation.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);

    expect(reviewCountRefreshStarted).toBe(true);
  });

  it("invalidates the warm merged lists after a merge", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const input = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      action: "merge",
    } as const;
    const openKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const mergedKey = pullRequestQueryKeys.list({ state: "merged", projectId });
    const allProjectsMergedKey = pullRequestQueryKeys.list({ state: "merged", projectId: null });
    const mergedExactKey = pullRequestQueryKeys.exactList({
      involvement: "authored",
      state: "merged",
      projectId,
    });
    queryClient.setQueryData(openKey, {
      entries: [{ ...input, state: "open", isDraft: false, isPinned: false }],
    });
    queryClient.setQueryData(mergedKey, { entries: [] });
    queryClient.setQueryData(allProjectsMergedKey, { entries: [] });
    queryClient.setQueryData(mergedExactKey, { entries: [] });
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [
      { workspaceRoot: "/repo" },
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryState(openKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mergedKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(allProjectsMergedKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mergedExactKey)?.isInvalidated).toBe(true);
  });

  it("rolls list-owned fields back even when no detail cache exists", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false, title: "before" }],
    });
    const input = { ...identity, action: "draft" } as const;
    const options = pullRequestActionMutationOptions(queryClient);
    if (!options.onMutate || !options.onError) throw new Error("Action hooks are missing.");

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    queryClient.setQueryData(listKey, (current: { entries: Array<Record<string, unknown>> }) => ({
      ...current,
      entries: current.entries.map((entry) => ({ ...entry, title: "fresh" })),
    }));
    await Reflect.apply(options.onError, undefined, [
      new Error("action failed"),
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, state: "open", isDraft: false, isPinned: false, title: "fresh" }],
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
