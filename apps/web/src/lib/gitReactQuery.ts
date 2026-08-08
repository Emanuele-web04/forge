import type {
  GitHandoffThreadInput,
  GitReadWorkingTreeDiffInput,
  GitStackedAction,
  ModelSelection,
  NativeApi,
  ProviderStartOptions,
} from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

const GIT_STATUS_STALE_TIME_MS = 30_000;
// Freshness is driven primarily by event-based invalidation (turn lifecycle +
// file-change domain events in __root.tsx) plus refetchOnWindowFocus/reconnect.
// The periodic timers are only a safety net for out-of-band edits while the tab
// stays focused, so they run at a relaxed cadence instead of every minute.
const GIT_STATUS_REFETCH_INTERVAL_MS = 300_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 300_000;
const GIT_WORKING_TREE_DIFF_STALE_TIME_MS = 5_000;
export const GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS = 4_000;
const RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED = "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED";
const GIT_CAPACITY_RETRY_LIMIT = 12;
const DEFAULT_GIT_CAPACITY_RETRY_MS = 250;

export function isGitExpensiveReadCapacityError(
  error: unknown,
): error is { readonly code: string; readonly retryAfterMs?: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED
  );
}

function shouldRetryGitExpensiveRead(failureCount: number, error: unknown): boolean {
  return isGitExpensiveReadCapacityError(error)
    ? failureCount < GIT_CAPACITY_RETRY_LIMIT
    : failureCount < 3;
}

function gitExpensiveReadRetryDelay(attemptIndex: number, error: unknown): number {
  if (isGitExpensiveReadCapacityError(error)) {
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_GIT_CAPACITY_RETRY_MS;
  }
  return Math.min(1_000 * 2 ** attemptIndex, 30_000);
}

const GIT_EXPENSIVE_READ_RETRY_OPTIONS = {
  retry: shouldRetryGitExpensiveRead,
  retryDelay: gitExpensiveReadRetryDelay,
} as const;

export const gitQueryKeys = {
  all: ["git"] as const,
  statuses: ["git", "status"] as const,
  pullRequests: ["git", "pull-request"] as const,
  githubRepository: (cwd: string | null) => ["git", "github-repository", cwd] as const,
  status: (cwd: string | null) => ["git", "status", cwd] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
  pullRequest: (cwd: string | null) => ["git", "pull-request", cwd] as const,
  workingTreeDiff: (
    cwd: string | null,
    scope: GitReadWorkingTreeDiffInput["scope"] = "workingTree",
  ) => ["git", "working-tree-diff", cwd, scope] as const,
  // Deliberately nested under the patch key so every existing
  // `["git", "working-tree-diff", ...]` invalidation refreshes the counts too.
  workingTreeDiffStats: (
    cwd: string | null,
    scope: GitReadWorkingTreeDiffInput["scope"] = "workingTree",
  ) => ["git", "working-tree-diff", cwd, scope, "stats"] as const,
  diffSummary: (
    cacheScope: string | null,
    model: string | null,
    modelSelectionKey: string | null,
    codexHomePath: string | null,
    providerOptionsKey: string | null,
    patchKey: string | null,
  ) =>
    [
      "git",
      "diff-summary",
      cacheScope,
      model,
      modelSelectionKey,
      codexHomePath,
      providerOptionsKey,
      patchKey,
    ] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  runStackedAction: (cwd: string | null) => ["git", "mutation", "run-stacked-action", cwd] as const,
  pull: (cwd: string | null) => ["git", "mutation", "pull", cwd] as const,
  preparePullRequestThread: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd] as const,
  handoffThread: (cwd: string | null) => ["git", "mutation", "handoff-thread", cwd] as const,
  stageFiles: (cwd: string | null) => ["git", "mutation", "stage-files", cwd] as const,
  unstageFiles: (cwd: string | null) => ["git", "mutation", "unstage-files", cwd] as const,
};

type GitRefreshDepth = "availability" | "active-details";

interface ActiveGitRefresh {
  readonly depth: GitRefreshDepth;
  readonly promise: Promise<void>;
  availabilityPromise: Promise<void> | undefined;
}

const activeGitRefreshes = new WeakMap<QueryClient, Map<string, ActiveGitRefresh>>();
const gitRefreshQueueTails = new WeakMap<QueryClient, Promise<void>>();

function enqueueGitRefresh(queryClient: QueryClient, refresh: () => Promise<void>): Promise<void> {
  const previous = gitRefreshQueueTails.get(queryClient) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(refresh);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  gitRefreshQueueTails.set(queryClient, settled);
  void settled.then(() => {
    if (gitRefreshQueueTails.get(queryClient) === settled) {
      gitRefreshQueueTails.delete(queryClient);
    }
  });
  return result;
}

function trackGitRefresh(
  queryClient: QueryClient,
  cwd: string,
  depth: GitRefreshDepth,
  promise: Promise<void>,
  availabilityPromise?: Promise<void>,
): Promise<void> {
  let refreshes = activeGitRefreshes.get(queryClient);
  if (!refreshes) {
    refreshes = new Map();
    activeGitRefreshes.set(queryClient, refreshes);
  }
  const entry: ActiveGitRefresh = { depth, promise, availabilityPromise };
  refreshes.set(cwd, entry);
  if (availabilityPromise) {
    void availabilityPromise.then(
      () => {
        if (entry.availabilityPromise === availabilityPromise) {
          entry.availabilityPromise = undefined;
        }
      },
      () => {
        if (entry.availabilityPromise === availabilityPromise) {
          entry.availabilityPromise = undefined;
        }
      },
    );
  }
  void promise.then(
    () => {
      if (refreshes?.get(cwd) === entry) refreshes.delete(cwd);
    },
    () => {
      if (refreshes?.get(cwd) === entry) refreshes.delete(cwd);
    },
  );
  return promise;
}

async function refreshGitAvailability(queryClient: QueryClient, cwd: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: gitQueryKeys.githubRepository(cwd),
      exact: true,
      refetchType: "none",
    }),
    queryClient.invalidateQueries({
      queryKey: gitQueryKeys.status(cwd),
      exact: true,
      refetchType: "none",
    }),
    queryClient.invalidateQueries({
      queryKey: gitQueryKeys.branches(cwd),
      exact: true,
      refetchType: "none",
    }),
  ]);
  await Promise.all([
    queryClient.refetchQueries(
      { queryKey: gitQueryKeys.githubRepository(cwd), exact: true, type: "active" },
      { cancelRefetch: false },
    ),
    queryClient.refetchQueries(
      { queryKey: gitQueryKeys.status(cwd), exact: true, type: "active" },
      { cancelRefetch: false },
    ),
    queryClient.refetchQueries(
      { queryKey: gitQueryKeys.branches(cwd), exact: true, type: "active" },
      { cancelRefetch: false },
    ),
  ]);
}

function activeGitDetailQueries(queryClient: QueryClient, cwd: string) {
  const queryCache = queryClient.getQueryCache();
  const queries = [
    ...queryCache.findAll({
      queryKey: ["git", "working-tree-diff", cwd] as const,
      type: "active",
    }),
    ...queryCache.findAll({ queryKey: gitQueryKeys.pullRequest(cwd), type: "active" }),
  ];
  const uniqueQueries = [...new Map(queries.map((query) => [query.queryHash, query])).values()];
  return uniqueQueries.toSorted((left, right) => {
    const leftIsStats = left.queryKey.at(-1) === "stats";
    const rightIsStats = right.queryKey.at(-1) === "stats";
    if (leftIsStats !== rightIsStats) return leftIsStats ? -1 : 1;
    const leftIsPatch = left.queryKey[1] === "working-tree-diff" && !leftIsStats;
    const rightIsPatch = right.queryKey[1] === "working-tree-diff" && !rightIsStats;
    if (leftIsPatch !== rightIsPatch) return leftIsPatch ? 1 : -1;
    return left.queryHash.localeCompare(right.queryHash);
  });
}

async function refreshActiveGitDetails(queryClient: QueryClient, cwd: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ["git", "working-tree-diff", cwd] as const,
      refetchType: "none",
    }),
    queryClient.invalidateQueries({
      queryKey: gitQueryKeys.pullRequest(cwd),
      refetchType: "none",
    }),
  ]);
  for (const query of activeGitDetailQueries(queryClient, cwd)) {
    await enqueueGitRefresh(queryClient, () =>
      queryClient.refetchQueries(
        { queryKey: query.queryKey, exact: true, type: "active" },
        { cancelRefetch: false },
      ),
    );
  }
}

/**
 * Coalesces refreshes by repository and serializes their expensive reads across the client.
 * Availability is refreshed first; active diff/PR details follow one at a time so Git UI work
 * cannot consume both expensive-read leases or fan out across every visible worktree.
 */
export function refreshGitQueriesForCwd(
  queryClient: QueryClient,
  cwd: string,
  depth: GitRefreshDepth = "active-details",
): Promise<void> {
  const existing = activeGitRefreshes.get(queryClient)?.get(cwd);
  if (existing) {
    if (depth === "availability") {
      if (existing.availabilityPromise) return existing.availabilityPromise;
      if (existing.depth === "availability") return existing.promise;

      const availability = enqueueGitRefresh(queryClient, () =>
        refreshGitAvailability(queryClient, cwd),
      );
      const extended = existing.promise.finally(() => availability);
      trackGitRefresh(queryClient, cwd, "active-details", extended, availability);
      return availability;
    }
    if (existing.depth === "active-details") {
      return existing.promise;
    }
    const upgraded = existing.promise
      .catch(() => undefined)
      .then(() => refreshActiveGitDetails(queryClient, cwd));
    return trackGitRefresh(
      queryClient,
      cwd,
      "active-details",
      upgraded,
      existing.availabilityPromise,
    );
  }

  const availability = enqueueGitRefresh(queryClient, () =>
    refreshGitAvailability(queryClient, cwd),
  );
  const refresh =
    depth === "active-details"
      ? availability.then(() => refreshActiveGitDetails(queryClient, cwd))
      : availability;
  return trackGitRefresh(queryClient, cwd, depth, refresh, availability);
}

export function refreshGitActionAvailability(queryClient: QueryClient, cwd: string): Promise<void> {
  return refreshGitQueriesForCwd(queryClient, cwd, "availability");
}

function cachedGitCwds(queryClient: QueryClient): string[] {
  const cwdFamilies = new Set([
    "github-repository",
    "status",
    "branches",
    "working-tree-diff",
    "pull-request",
  ]);
  const cwds = queryClient
    .getQueryCache()
    .findAll({ queryKey: gitQueryKeys.all })
    .flatMap((query) => {
      const family = query.queryKey[1];
      const cwd = query.queryKey[2];
      return typeof family === "string" && cwdFamilies.has(family) && typeof cwd === "string"
        ? [cwd]
        : [];
    });
  return [...new Set(cwds)];
}

export function invalidateGitQueries(queryClient: QueryClient) {
  return Promise.all(
    cachedGitCwds(queryClient).map((cwd) => refreshGitQueriesForCwd(queryClient, cwd)),
  );
}

// Scope live file-change invalidations so unrelated project/worktree git caches stay warm.
export function invalidateGitQueriesForCwds(queryClient: QueryClient, cwds: Iterable<string>) {
  const uniqueCwds = [...new Set([...cwds].filter((cwd) => cwd.length > 0))];
  return Promise.all(uniqueCwds.map((cwd) => refreshGitQueriesForCwd(queryClient, cwd)));
}

export function gitStatusQueryOptions(cwd: string | null, enabled = true) {
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status({ cwd });
    },
    enabled: enabled && cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
    ...GIT_EXPENSIVE_READ_RETRY_OPTIONS,
  });
}

export function gitGithubRepositoryQueryOptions(cwd: string | null, enabled = true) {
  return queryOptions({
    queryKey: gitQueryKeys.githubRepository(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("GitHub repository is unavailable.");
      return api.git.githubRepository({ cwd });
    },
    enabled: enabled && cwd !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitBranchesQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.branches(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: [...gitQueryKeys.pullRequest(input.cwd), input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

// Refresh cadence for the Environment panel PR section: cheap enough to poll while the
// panel is open, and event-based git invalidation covers pushes from this client.
const GIT_PR_SNAPSHOT_STALE_TIME_MS = 30_000;
const GIT_PR_SNAPSHOT_REFETCH_INTERVAL_MS = 60_000;

export function gitPullRequestSnapshotQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    // Shares the ["git", "pull-request", cwd] prefix so existing invalidations cover it.
    queryKey: [...gitQueryKeys.pullRequest(input.cwd), "snapshot", input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request snapshot is unavailable.");
      }
      return api.git.pullRequestSnapshot({ cwd: input.cwd, reference: input.reference });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.reference !== null,
    staleTime: GIT_PR_SNAPSHOT_STALE_TIME_MS,
    // Once the snapshot itself reports the PR merged/closed, stop polling it — the cached
    // git status can lag behind and would otherwise keep the interval alive.
    refetchInterval: (query) =>
      query.state.data && query.state.data.pullRequest.state !== "open"
        ? false
        : GIT_PR_SNAPSHOT_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: (query) =>
      !query.state.data || query.state.data.pullRequest.state === "open",
    refetchOnReconnect: true,
    ...GIT_EXPENSIVE_READ_RETRY_OPTIONS,
  });
}

/**
 * Line counts for the selected scope, resolved server-side.
 *
 * Separate from `gitWorkingTreeDiffQueryOptions` on purpose: the badge surfaces poll these
 * numbers every few seconds while a turn is live, and the patch they used to be derived from
 * grows with the working tree — on a 10k-line diff that meant refetching megabytes of text and
 * reparsing it on the renderer's main thread just to show `+N/-M`. The response here is three
 * integers regardless of diff size. Fetch the patch itself only when showing the diff.
 */
export function gitWorkingTreeDiffStatsQueryOptions(input: {
  cwd: string | null;
  scope?: GitReadWorkingTreeDiffInput["scope"];
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const scope = input.scope ?? "workingTree";
  const refetchInterval = input.refetchInterval;
  return queryOptions({
    queryKey: gitQueryKeys.workingTreeDiffStats(input.cwd, scope),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Working tree diff stats are unavailable.");
      }
      return api.git.workingTreeDiffStats({ cwd: input.cwd, scope });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: GIT_WORKING_TREE_DIFF_STALE_TIME_MS,
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    ...GIT_EXPENSIVE_READ_RETRY_OPTIONS,
  });
}

export function gitWorkingTreeDiffQueryOptions(input: {
  cwd: string | null;
  scope?: GitReadWorkingTreeDiffInput["scope"];
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const scope = input.scope ?? "workingTree";
  const refetchInterval = input.refetchInterval;
  return queryOptions({
    queryKey: gitQueryKeys.workingTreeDiff(input.cwd, scope),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Working tree diff is unavailable.");
      }
      return api.git.readWorkingTreeDiff({ cwd: input.cwd, scope });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: GIT_WORKING_TREE_DIFF_STALE_TIME_MS,
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    ...GIT_EXPENSIVE_READ_RETRY_OPTIONS,
  });
}

type GitMutationInvalidation = "all" | "cwd";
type GitMutationInvalidateOn = "success" | "settled";

// Shared scaffolding for cwd-bound git mutations: resolve the native API, guard a
// missing cwd with a clear message, run the single call, then invalidate git
// caches — globally or scoped to this cwd — on success or settle. Keeps each
// mutation definition down to its key + the one API call it performs.
function makeGitMutationOptions<TArgs, TResult>(config: {
  cwd: string | null;
  queryClient: QueryClient;
  mutationKey: readonly unknown[];
  unavailableMessage: string;
  run: (api: NativeApi, cwd: string, args: TArgs) => Promise<TResult>;
  invalidate?: GitMutationInvalidation;
  invalidateOn?: GitMutationInvalidateOn;
  awaitInvalidation?: boolean;
}) {
  const invalidate = config.invalidate ?? "all";
  const invalidateOn = config.invalidateOn ?? "settled";
  const runInvalidation = async () => {
    if (invalidate === "cwd") {
      if (config.cwd) {
        await invalidateGitQueriesForCwds(config.queryClient, [config.cwd]);
      }
      return;
    }
    await invalidateGitQueries(config.queryClient);
  };
  const handleInvalidation =
    config.awaitInvalidation === false
      ? () => {
          void runInvalidation().catch(() => undefined);
        }
      : runInvalidation;

  return mutationOptions({
    mutationKey: config.mutationKey,
    mutationFn: async (args: TArgs) => {
      const api = ensureNativeApi();
      if (!config.cwd) throw new Error(config.unavailableMessage);
      return config.run(api, config.cwd, args);
    },
    ...(invalidateOn === "success"
      ? { onSuccess: handleInvalidation }
      : { onSettled: handleInvalidation }),
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return makeGitMutationOptions<void, void>({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.init(input.cwd),
    unavailableMessage: "Git init is unavailable.",
    invalidateOn: "success",
    run: (api, cwd) => api.git.init({ cwd }),
  });
}

export function gitStageFilesMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return makeGitMutationOptions<readonly string[], { ok: boolean }>({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.stageFiles(input.cwd),
    unavailableMessage: "Staging is unavailable.",
    invalidate: "cwd",
    run: (api, cwd, paths) => {
      if (paths.length === 0) throw new Error("No files selected to stage.");
      return api.git.stageFiles({ cwd, paths: [...paths] });
    },
  });
}

export function gitUnstageFilesMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return makeGitMutationOptions<readonly string[], { ok: boolean }>({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.unstageFiles(input.cwd),
    unavailableMessage: "Unstaging is unavailable.",
    invalidate: "cwd",
    run: (api, cwd, paths) => {
      if (paths.length === 0) throw new Error("No files selected to unstage.");
      return api.git.unstageFiles({ cwd, paths: [...paths] });
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
  model?: string | null;
  modelSelection?: ModelSelection | null;
  codexHomePath?: string | null;
  providerOptions?: ProviderStartOptions | null;
}) {
  return makeGitMutationOptions<
    {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      prTitle?: string;
      prBody?: string;
      prDraft?: boolean;
      allowDirtyWorkingTree?: boolean;
    },
    Awaited<ReturnType<NativeApi["git"]["runStackedAction"]>>
  >({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.runStackedAction(input.cwd),
    unavailableMessage: "Git action is unavailable.",
    invalidate: "cwd",
    awaitInvalidation: false,
    run: (
      api,
      cwd,
      {
        actionId,
        action,
        commitMessage,
        featureBranch,
        filePaths,
        prTitle,
        prBody,
        prDraft,
        allowDirtyWorkingTree,
      },
    ) =>
      api.git.runStackedAction({
        actionId,
        cwd,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(prTitle ? { prTitle } : {}),
        ...(prBody ? { prBody } : {}),
        ...(prDraft !== undefined ? { prDraft } : {}),
        ...(allowDirtyWorkingTree ? { allowDirtyWorkingTree } : {}),
        ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
        ...(input.model ? { textGenerationModel: input.model } : {}),
        ...(input.modelSelection ? { textGenerationModelSelection: input.modelSelection } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      }),
  });
}

export function gitPullMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return makeGitMutationOptions<void, Awaited<ReturnType<NativeApi["git"]["pull"]>>>({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.pull(input.cwd),
    unavailableMessage: "Git pull is unavailable.",
    invalidate: "cwd",
    awaitInvalidation: false,
    run: (api, cwd) => api.git.pull({ cwd }),
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      path,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree({ cwd, branch, newBranch, path: path ?? null });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateDetachedWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      ref,
      path,
      copyChangesFrom,
      newBranch,
    }: {
      cwd: string;
      ref: string;
      path?: string | null;
      copyChangesFrom?: string;
      newBranch?: string;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createDetachedWorktree({
        cwd,
        ref,
        path: path ?? null,
        ...(copyChangesFrom ? { copyChangesFrom } : {}),
        ...(newBranch ? { newBranch } : {}),
      });
    },
    mutationKey: ["git", "mutation", "create-detached-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path, force }: { cwd: string; path: string; force?: boolean }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      // Every UI removal retires a thread-scoped managed worktree, so its
      // temporary synara/* branch (if any) is reclaimed with it.
      return api.git.removeWorktree({ cwd, path, force, reclaimTemporaryBranch: true });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return makeGitMutationOptions<
    { reference: string; mode: "local" | "worktree" },
    Awaited<ReturnType<NativeApi["git"]["preparePullRequestThread"]>>
  >({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd),
    unavailableMessage: "Pull request thread preparation is unavailable.",
    run: (api, cwd, { reference, mode }) =>
      api.git.preparePullRequestThread({ cwd, reference, mode }),
  });
}

export function gitHandoffThreadMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return makeGitMutationOptions<
    Omit<GitHandoffThreadInput, "cwd">,
    Awaited<ReturnType<NativeApi["git"]["handoffThread"]>>
  >({
    cwd: input.cwd,
    queryClient: input.queryClient,
    mutationKey: gitMutationKeys.handoffThread(input.cwd),
    unavailableMessage: "Git handoff is unavailable.",
    run: (api, cwd, request) => api.git.handoffThread({ cwd, ...request }),
  });
}
