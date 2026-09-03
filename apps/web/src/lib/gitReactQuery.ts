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
import { EXPENSIVE_READ_RETRY_OPTIONS, isRpcCapacityExceededError } from "./expensiveReadRetry";

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

export function isGitExpensiveReadCapacityError(
  error: unknown,
): error is { readonly code: string; readonly retryAfterMs?: unknown } {
  return isRpcCapacityExceededError(error);
}

const GIT_EXPENSIVE_READ_RETRY_OPTIONS = EXPENSIVE_READ_RETRY_OPTIONS;

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
  depth: GitRefreshDepth;
  started: boolean;
  /** Resolves after the availability phase (repository/status/branches). */
  availability: Promise<void>;
  /** Resolves after the full refresh, including active detail reads when requested. */
  promise: Promise<void>;
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
  entry: ActiveGitRefresh,
): Promise<void> {
  let refreshes = activeGitRefreshes.get(queryClient);
  if (!refreshes) {
    refreshes = new Map();
    activeGitRefreshes.set(queryClient, refreshes);
  }
  refreshes.set(cwd, entry);
  const cleanup = () => {
    if (refreshes.get(cwd) === entry) refreshes.delete(cwd);
  };
  void entry.promise.then(cleanup, cleanup);
  return entry.promise;
}

/**
 * Refetches the matching active queries from scratch. A fetch already in flight may have
 * read the repository before whatever change triggered this refresh (e.g. a checkout or
 * pull that just settled), so reusing it would mark stale data fresh. It is cancelled
 * explicitly first because refetchQueries' cancelRefetch only cancels fetches on queries
 * that already hold data — a cold query's initial fetch would otherwise be joined.
 */
async function refetchFreshGitQueries(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  await queryClient.cancelQueries({ queryKey, exact: true, fetchStatus: "fetching" });
  await queryClient.refetchQueries(
    { queryKey, exact: true, type: "active" },
    { cancelRefetch: true },
  );
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
    refetchFreshGitQueries(queryClient, gitQueryKeys.githubRepository(cwd)),
    refetchFreshGitQueries(queryClient, gitQueryKeys.status(cwd)),
    refetchFreshGitQueries(queryClient, gitQueryKeys.branches(cwd)),
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
    await enqueueGitRefresh(queryClient, () => refetchFreshGitQueries(queryClient, query.queryKey));
  }
}

/**
 * Coalesces refreshes by repository and serializes their expensive reads across the client.
 * Availability is refreshed first; active diff/PR details follow one at a time so Git UI work
 * cannot consume both expensive-read leases or fan out across every visible worktree.
 *
 * A refresh only joins an existing one while that refresh is still queued: once its reads
 * have begun they may predate whatever change triggered this request (a checkout or pull
 * that just settled), so joining would return without ever observing the new repository
 * state. In that case a fresh refresh is queued behind the running one instead.
 */
export function refreshGitQueriesForCwd(
  queryClient: QueryClient,
  cwd: string,
  depth: GitRefreshDepth = "active-details",
): Promise<void> {
  const existing = activeGitRefreshes.get(queryClient)?.get(cwd);
  if (existing && !existing.started) {
    if (depth === "active-details") existing.depth = "active-details";
    return depth === "availability" ? existing.availability : existing.promise;
  }

  const entry: ActiveGitRefresh = {
    depth,
    started: false,
    availability: Promise.resolve(),
    promise: Promise.resolve(),
  };
  entry.availability = enqueueGitRefresh(queryClient, () => {
    entry.started = true;
    return refreshGitAvailability(queryClient, cwd);
  });
  // Read entry.depth only after availability settles so a pre-start upgrade to
  // "active-details" is honored even when the original request was availability-only.
  entry.promise = entry.availability.then(() =>
    entry.depth === "active-details" ? refreshActiveGitDetails(queryClient, cwd) : undefined,
  );
  trackGitRefresh(queryClient, cwd, entry);
  return depth === "availability" ? entry.availability : entry.promise;
}

/** Resolves once repository/status/branches are fresh, even when the underlying refresh
 * was upgraded to also re-read active details after the availability phase. */
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

// excludeCwds lets a caller that already refreshed (and awaited) specific checkouts fan the
// rest out in the background without queueing duplicate refreshes for the awaited ones.
export function invalidateGitQueries(
  queryClient: QueryClient,
  options?: { readonly excludeCwds?: Iterable<string> },
) {
  const excludedCwds = new Set(options?.excludeCwds ?? []);
  return Promise.all(
    cachedGitCwds(queryClient)
      .filter((cwd) => !excludedCwds.has(cwd))
      .map((cwd) => refreshGitQueriesForCwd(queryClient, cwd)),
  );
}

// Scope live file-change invalidations so unrelated project/worktree git caches stay warm.
export function invalidateGitQueriesForCwds(queryClient: QueryClient, cwds: Iterable<string>) {
  const uniqueCwds = [...new Set([...cwds].filter((cwd) => cwd.length > 0))];
  return Promise.all(uniqueCwds.map((cwd) => refreshGitQueriesForCwd(queryClient, cwd)));
}

/**
 * Refreshes the given checkouts and resolves once they are fresh; every other cached
 * repository refreshes in the background. For callers gating UI on a refresh (e.g. a
 * branch action transition) so one slow unrelated worktree cannot hold the UI busy.
 * The awaited checkouts are queued first so background work cannot delay them.
 */
export function refreshGitQueriesScoped(
  queryClient: QueryClient,
  cwds: Iterable<string>,
): Promise<void> {
  const awaitedCwds = [...new Set([...cwds].filter((cwd) => cwd.length > 0))];
  const scoped = invalidateGitQueriesForCwds(queryClient, awaitedCwds);
  void invalidateGitQueries(queryClient, { excludeCwds: awaitedCwds }).catch(() => undefined);
  return scoped.then(() => undefined);
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
      progressId,
    }: {
      cwd: string;
      ref: string;
      path?: string | null;
      copyChangesFrom?: string;
      newBranch?: string;
      progressId?: string;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createDetachedWorktree({
        cwd,
        ref,
        path: path ?? null,
        ...(copyChangesFrom ? { copyChangesFrom } : {}),
        ...(newBranch ? { newBranch } : {}),
        ...(progressId ? { progressId } : {}),
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
