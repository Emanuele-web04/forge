import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitQueryKeys,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
  invalidateGitQueries,
  invalidateGitQueriesForCwds,
  isGitExpensiveReadCapacityError,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  refreshGitActionAvailability,
  refreshGitQueriesForCwd,
} from "./gitReactQuery";

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });

  it("does not keep a completed stacked action pending while Git queries refresh", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/non-blocking";
    const statusKey = gitQueryKeys.status(cwd);
    let statusCalls = 0;
    const statusGate = deferredVoid();
    queryClient.setQueryData(statusKey, { branch: "main" });
    const observer = new QueryObserver(queryClient, {
      queryKey: statusKey,
      queryFn: async () => {
        statusCalls += 1;
        await statusGate.promise;
        return { branch: "main" };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const options = gitRunStackedActionMutationOptions({ cwd, queryClient });

    const callbackResult = (options.onSettled as (() => unknown) | undefined)?.();
    expect(callbackResult).toBeUndefined();

    const refresh = refreshGitQueriesForCwd(queryClient, cwd);
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    statusGate.resolve();
    await refresh;
    unsubscribe();
  });
});

describe("git query invalidation", () => {
  it("invalidates all git query families for broad refreshes", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/all";
    const keys = [
      gitQueryKeys.githubRepository(cwd),
      gitQueryKeys.status(cwd),
      gitQueryKeys.branches(cwd),
      gitQueryKeys.workingTreeDiff(cwd, "workingTree"),
      ["git", "pull-request", cwd, "https://example.test/pr/1"] as const,
    ];

    for (const key of keys) {
      queryClient.setQueryData(key, {});
    }

    await invalidateGitQueries(queryClient);

    for (const key of keys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("invalidates only queries for the affected cwd", async () => {
    const queryClient = new QueryClient();
    const cwdA = "/repo/a";
    const cwdB = "/repo/b";
    const cwdAKeys = [
      gitQueryKeys.githubRepository(cwdA),
      gitQueryKeys.status(cwdA),
      gitQueryKeys.branches(cwdA),
      gitQueryKeys.workingTreeDiff(cwdA, "workingTree"),
      gitQueryKeys.workingTreeDiff(cwdA, "staged"),
      ["git", "pull-request", cwdA, "https://example.test/pr/1"] as const,
    ];
    const cwdBKeys = [
      gitQueryKeys.githubRepository(cwdB),
      gitQueryKeys.status(cwdB),
      gitQueryKeys.branches(cwdB),
      gitQueryKeys.workingTreeDiff(cwdB, "workingTree"),
      ["git", "pull-request", cwdB, "https://example.test/pr/2"] as const,
    ];

    for (const key of [...cwdAKeys, ...cwdBKeys]) {
      queryClient.setQueryData(key, {});
    }

    await invalidateGitQueriesForCwds(queryClient, [cwdA]);

    for (const key of cwdAKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    for (const key of cwdBKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });

  it("coalesces simultaneous availability refreshes for the same cwd", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/coalesced";
    const statusKey = gitQueryKeys.status(cwd);
    let statusCalls = 0;
    const statusGate = deferredVoid();
    queryClient.setQueryData(statusKey, { branch: "main" });
    const observer = new QueryObserver(queryClient, {
      queryKey: statusKey,
      queryFn: async () => {
        statusCalls += 1;
        await statusGate.promise;
        return { branch: "main" };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const first = refreshGitActionAvailability(queryClient, cwd);
    const second = refreshGitActionAvailability(queryClient, cwd);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    statusGate.resolve();
    await Promise.all([first, second]);
    unsubscribe();
  });

  it("keeps availability coalesced when a refresh is upgraded to include details", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/upgraded";
    const statusKey = gitQueryKeys.status(cwd);
    let statusCalls = 0;
    const statusGate = deferredVoid();
    queryClient.setQueryData(statusKey, {});
    const observer = new QueryObserver(queryClient, {
      queryKey: statusKey,
      queryFn: async () => {
        statusCalls += 1;
        await statusGate.promise;
        return {};
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const availability = refreshGitActionAvailability(queryClient, cwd);
    const details = refreshGitQueriesForCwd(queryClient, cwd);
    const repeatedAvailability = refreshGitActionAvailability(queryClient, cwd);

    expect(repeatedAvailability).toBe(availability);
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    statusGate.resolve();
    await Promise.all([availability, details, repeatedAvailability]);
    expect(statusCalls).toBe(1);
    unsubscribe();
  });

  it("starts a fresh refresh when the existing one has already begun its reads", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/post-mutation";
    const statusKey = gitQueryKeys.status(cwd);
    let branch = "main";
    let statusCalls = 0;
    const firstStatusGate = deferredVoid();
    queryClient.setQueryData(statusKey, { branch });
    const observer = new QueryObserver(queryClient, {
      queryKey: statusKey,
      queryFn: async () => {
        statusCalls += 1;
        const observed = branch;
        if (statusCalls === 1) {
          await firstStatusGate.promise;
        }
        return { branch: observed };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    const first = refreshGitActionAvailability(queryClient, cwd);
    await vi.waitFor(() => expect(statusCalls).toBe(1));

    // A mutation (e.g. checkout or pull) settles while the first refresh is mid-read:
    // its in-flight fetch observed the pre-mutation repository, so the follow-up refresh
    // must issue new reads instead of joining it.
    branch = "feature";
    const second = refreshGitActionAvailability(queryClient, cwd);
    expect(second).not.toBe(first);

    firstStatusGate.resolve();
    await Promise.all([first, second]);
    expect(statusCalls).toBe(2);
    expect(queryClient.getQueryData(statusKey)).toEqual({ branch: "feature" });
    unsubscribe();
  });

  it("cancels a cold query's initial fetch instead of adopting its pre-mutation result", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/cold-cache";
    const statusKey = gitQueryKeys.status(cwd);
    let branch = "main";
    let statusCalls = 0;
    const firstStatusGate = deferredVoid();
    // No initial cache data: the observer's mount fetch is the query's first ever fetch,
    // which refetchQueries' cancelRefetch alone would join instead of cancelling.
    const observer = new QueryObserver(queryClient, {
      queryKey: statusKey,
      queryFn: async () => {
        statusCalls += 1;
        const observed = branch;
        if (statusCalls === 1) {
          await firstStatusGate.promise;
        }
        return { branch: observed };
      },
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(statusCalls).toBe(1));

    // A mutation settles while the initial fetch is still reading pre-mutation state.
    branch = "feature";
    await refreshGitActionAvailability(queryClient, cwd);

    expect(statusCalls).toBe(2);
    expect(queryClient.getQueryData(statusKey)).toEqual({ branch: "feature" });
    firstStatusGate.resolve();
    await Promise.resolve();
    expect(queryClient.getQueryData(statusKey)).toEqual({ branch: "feature" });
    unsubscribe();
  });

  it("serializes active expensive Git detail reads after status", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/serialized";
    const calls: string[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const observe = (queryKey: readonly unknown[], label: string) => {
      queryClient.setQueryData(queryKey, {});
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: async () => {
          calls.push(label);
          activeCalls += 1;
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
          await Promise.resolve();
          activeCalls -= 1;
          return {};
        },
        staleTime: Number.POSITIVE_INFINITY,
      });
      return observer.subscribe(() => undefined);
    };
    const unsubscribes = [
      observe(gitQueryKeys.status(cwd), "status"),
      observe(gitQueryKeys.workingTreeDiffStats(cwd, "unstaged"), "stats"),
      observe(gitQueryKeys.workingTreeDiff(cwd, "unstaged"), "patch"),
    ];

    await refreshGitQueriesForCwd(queryClient, cwd);

    expect(calls).toEqual(["status", "stats", "patch"]);
    expect(maxActiveCalls).toBe(1);
    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  it("prioritizes an availability refresh between active detail reads", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/prioritized";
    const calls: string[] = [];
    const statsGate = deferredVoid();
    const observe = (queryKey: readonly unknown[], label: string, waitForRelease = false) => {
      queryClient.setQueryData(queryKey, {});
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: async () => {
          calls.push(label);
          if (waitForRelease) {
            await statsGate.promise;
          }
          return {};
        },
        staleTime: Number.POSITIVE_INFINITY,
      });
      return observer.subscribe(() => undefined);
    };
    const unsubscribes = [
      observe(gitQueryKeys.status(cwd), "status"),
      observe(gitQueryKeys.workingTreeDiffStats(cwd, "unstaged"), "stats", true),
      observe(gitQueryKeys.workingTreeDiff(cwd, "unstaged"), "patch"),
    ];

    const detailsRefresh = refreshGitQueriesForCwd(queryClient, cwd);
    await vi.waitFor(() => expect(calls).toEqual(["status", "stats"]));
    const availabilityRefresh = refreshGitActionAvailability(queryClient, cwd);

    statsGate.resolve();
    await availabilityRefresh;
    expect(calls).toEqual(["status", "stats", "status"]);

    await detailsRefresh;
    expect(calls).toEqual(["status", "stats", "status", "patch"]);
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});

describe("git expensive-read capacity retry", () => {
  const capacityError = {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 375,
  };

  it("recognizes the typed capacity error and honors the server retry delay", () => {
    expect(isGitExpensiveReadCapacityError(capacityError)).toBe(true);
    expect(isGitExpensiveReadCapacityError(new Error("network"))).toBe(false);

    const options = gitStatusQueryOptions("/repo");
    expect(typeof options.retry).toBe("function");
    expect(typeof options.retryDelay).toBe("function");
    if (typeof options.retry !== "function" || typeof options.retryDelay !== "function") return;

    expect(options.retry(0, capacityError as never)).toBe(false);
    expect(options.retry(0, new Error("network"))).toBe(true);
    expect(options.retry(3, new Error("network"))).toBe(false);
    expect(options.retryDelay(0, capacityError as never)).toBe(375);
  });
});

describe("git working tree diff query options", () => {
  it("accepts a live refetch interval for active diff badges", () => {
    const options = gitWorkingTreeDiffQueryOptions({
      cwd: "/repo/a",
      refetchInterval: GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
    });

    expect(GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS).toBe(4_000);
    expect(options.refetchInterval).toBe(GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS);
  });
});
