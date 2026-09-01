import type {
  ProjectId,
  PullRequestDetailInput,
  PullRequestProjectContext,
  PullRequestProvider,
  PullRequestSetPinnedInput,
  PullRequestState,
  PullRequestsListResult,
} from "@synara/contracts";
import {
  coalescePullRequestListEntries,
  normalizePullRequestProvider,
  pullRequestListEntryHasProject,
  pullRequestListProjectContexts,
  pullRequestListProjectPin,
  pullRequestProjectIdentityKey as sharedPullRequestProjectIdentityKey,
  pullRequestRemoteIdentityKey as sharedPullRequestRemoteIdentityKey,
  updatePullRequestListEntryProjectPin,
} from "@synara/shared/githubRepository";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { PULL_REQUEST_STATES } from "./pullRequestQueryOptions";

export type PullRequestListCacheEntry = {
  projectId: ProjectId;
  projectTitle?: string;
  provider?: PullRequestProvider;
  repository: string;
  number: number;
  isPinned: boolean;
  headBranch?: string;
  projectContexts?: ReadonlyArray<PullRequestProjectContext>;
  state?: PullRequestState;
  isDraft?: boolean;
};

export type PullRequestListCache = {
  entries: PullRequestListCacheEntry[];
};

export type PinCacheRollback = {
  queryKey: QueryKey;
  previousIsPinned: boolean;
};

export type PullRequestActionListPatch = {
  state?: PullRequestState;
  isDraft?: boolean;
};

export type ActionListCacheRollback = {
  queryKey: QueryKey;
  previousFields: PullRequestActionListPatch;
};

export type PullRequestListQueryScope = {
  state: PullRequestState;
  projectId: ProjectId | null;
};

type PullRequestRemoteIdentityInput = {
  provider?: PullRequestProvider | undefined;
  repository: string;
  number: number;
};

type PullRequestProjectIdentityInput = PullRequestRemoteIdentityInput & {
  projectId: ProjectId;
};

export function pullRequestIdentityKey(
  input: PullRequestProjectIdentityInput,
): string {
  return sharedPullRequestProjectIdentityKey({
    projectId: input.projectId,
    provider: normalizePullRequestProvider(input.provider),
    repository: input.repository,
    number: input.number,
  });
}

export function pullRequestRemoteIdentityKey(
  input: PullRequestRemoteIdentityInput,
): string {
  return sharedPullRequestRemoteIdentityKey({
    provider: normalizePullRequestProvider(input.provider),
    repository: input.repository,
    number: input.number,
  });
}

function matchesPullRequestRemoteIdentity(
  entry: PullRequestRemoteIdentityInput,
  input: PullRequestRemoteIdentityInput,
): boolean {
  return pullRequestRemoteIdentityKey(entry) === pullRequestRemoteIdentityKey(input);
}

function matchesPullRequestPinIdentity(
  entry: PullRequestListCacheEntry,
  input: PullRequestProjectIdentityInput,
): boolean {
  return (
    matchesPullRequestRemoteIdentity(entry, input) &&
    pullRequestListEntryHasProject(entry, input.projectId)
  );
}

function updateEntryProjectPin(
  entry: PullRequestListCacheEntry,
  projectId: ProjectId,
  isPinned: boolean,
): PullRequestListCacheEntry {
  return updatePullRequestListEntryProjectPin(entry, projectId, isPinned);
}

export function isPullRequestListQueryKey(queryKey: QueryKey): boolean {
  return (
    queryKey[0] === "pull-requests" &&
    (queryKey[1] === "list" || queryKey[1] === "list-involvement")
  );
}

export function queryKeysEqual(left: QueryKey, right: QueryKey): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function pullRequestListQueryScope(queryKey: QueryKey): PullRequestListQueryScope | null {
  if (!isPullRequestListQueryKey(queryKey)) return null;
  const stateIndex = queryKey[1] === "list" ? 2 : 3;
  const projectIdIndex = queryKey[1] === "list" ? 3 : 4;
  const state = queryKey[stateIndex];
  const projectId = queryKey[projectIdIndex];
  if (!PULL_REQUEST_STATES.includes(state as PullRequestState)) return null;
  if (projectId !== null && typeof projectId !== "string") return null;
  return { state: state as PullRequestState, projectId: projectId as ProjectId | null };
}

function scopeKey(scope: PullRequestListQueryScope): string {
  return `${scope.state}\u0000${scope.projectId ?? ""}`;
}

export function listScopesContainingPullRequest(
  queryClient: QueryClient,
  input: PullRequestProjectIdentityInput,
): PullRequestListQueryScope[] {
  const scopes = new Map<string, PullRequestListQueryScope>();
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    if (!data?.entries.some((entry) => matchesPullRequestPinIdentity(entry, input))) continue;
    const scope = pullRequestListQueryScope(queryKey);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()];
}

/** List scopes whose cached rows prove they cover this PR or another PR from its repository.
 * This reaches the relevant state/involvement siblings without invalidating unrelated projects. */
export function listScopesContainingPullRequestRepository(
  queryClient: QueryClient,
  input: PullRequestProjectIdentityInput,
): PullRequestListQueryScope[] {
  const scopes = new Map<string, PullRequestListQueryScope>();
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const coversRepository = data?.entries.some(
      (entry) =>
        normalizePullRequestProvider(entry.provider) ===
          normalizePullRequestProvider(input.provider) &&
        entry.repository.toLowerCase() === input.repository.toLowerCase(),
    );
    if (!coversRepository) continue;
    const scope = pullRequestListQueryScope(queryKey);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()];
}

export function invalidatePullRequestListScopes(
  queryClient: QueryClient,
  scopes: ReadonlyArray<PullRequestListQueryScope>,
) {
  const keys = new Set(scopes.map(scopeKey));
  if (keys.size === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const scope = pullRequestListQueryScope(query.queryKey);
      return scope !== null && keys.has(scopeKey(scope));
    },
  });
}

/** Stop in-flight list snapshots for only the scopes an optimistic mutation will own. */
export function cancelPullRequestListScopes(
  queryClient: QueryClient,
  scopes: ReadonlyArray<PullRequestListQueryScope>,
) {
  const keys = new Set(scopes.map(scopeKey));
  if (keys.size === 0) return Promise.resolve();
  return queryClient.cancelQueries({
    predicate: (query) => {
      const scope = pullRequestListQueryScope(query.queryKey);
      return scope !== null && keys.has(scopeKey(scope));
    },
  });
}

/** Marks only same-state, same-project LIST-family siblings stale after a forced refresh. */
export function invalidateOtherPullRequestListQueries(
  queryClient: QueryClient,
  refreshedQueryKey: QueryKey,
) {
  const refreshedScope = pullRequestListQueryScope(refreshedQueryKey);
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const candidateScope = pullRequestListQueryScope(query.queryKey);
      return (
        refreshedScope !== null &&
        candidateScope !== null &&
        candidateScope.state === refreshedScope.state &&
        candidateScope.projectId === refreshedScope.projectId &&
        !queryKeysEqual(query.queryKey, refreshedQueryKey)
      );
    },
  });
}

export function optimisticallyPatchPullRequestActionFieldsInListCaches(
  queryClient: QueryClient,
  input: PullRequestProjectIdentityInput,
  entryPatch: PullRequestActionListPatch,
): ActionListCacheRollback[] {
  const rollbackByQuery: ActionListCacheRollback[] = [];
  if (Object.keys(entryPatch).length === 0) return rollbackByQuery;
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const match = data?.entries.find((entry) => matchesPullRequestRemoteIdentity(entry, input));
    if (!match) continue;
    rollbackByQuery.push({
      queryKey,
      previousFields: {
        ...(entryPatch.state !== undefined ? { state: match.state } : {}),
        ...(entryPatch.isDraft !== undefined ? { isDraft: match.isDraft } : {}),
      },
    });
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              matchesPullRequestRemoteIdentity(entry, input) ? { ...entry, ...entryPatch } : entry,
            ),
          }
        : current,
    );
  }
  return rollbackByQuery;
}

export function rollbackPullRequestActionFieldsInListCaches(input: {
  queryClient: QueryClient;
  identity: PullRequestProjectIdentityInput;
  optimisticPatch: PullRequestActionListPatch;
  rollbackByQuery: ReadonlyArray<ActionListCacheRollback>;
}) {
  for (const rollback of input.rollbackByQuery) {
    input.queryClient.setQueryData<PullRequestListCache>(rollback.queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) => {
              if (!matchesPullRequestRemoteIdentity(entry, input.identity)) return entry;
              const ownedRollback: PullRequestActionListPatch = {};
              if (
                input.optimisticPatch.state !== undefined &&
                entry.state === input.optimisticPatch.state
              ) {
                const previousState = rollback.previousFields.state;
                if (previousState !== undefined) ownedRollback.state = previousState;
              }
              if (
                input.optimisticPatch.isDraft !== undefined &&
                entry.isDraft === input.optimisticPatch.isDraft
              ) {
                const previousIsDraft = rollback.previousFields.isDraft;
                if (previousIsDraft !== undefined) ownedRollback.isDraft = previousIsDraft;
              }
              return Object.keys(ownedRollback).length > 0 ? { ...entry, ...ownedRollback } : entry;
            }),
          }
        : current,
    );
  }
}

export function patchPullRequestPinInListCaches(
  queryClient: QueryClient,
  input: PullRequestProjectIdentityInput,
  isPinned: boolean,
) {
  for (const [queryKey] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              matchesPullRequestPinIdentity(entry, input)
                ? updateEntryProjectPin(entry, input.projectId, isPinned)
                : entry,
            ),
          }
        : current,
    );
  }
}

export function optimisticallyPatchPullRequestPinInListCaches(
  queryClient: QueryClient,
  input: PullRequestSetPinnedInput,
): PinCacheRollback[] {
  const rollbackByQuery: PinCacheRollback[] = [];
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const match = data?.entries.find((entry) => matchesPullRequestPinIdentity(entry, input));
    if (!match) continue;
    rollbackByQuery.push({
      queryKey,
      previousIsPinned: pullRequestListProjectPin(match, input.projectId)!,
    });
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              matchesPullRequestPinIdentity(entry, input)
                ? updateEntryProjectPin(entry, input.projectId, input.isPinned)
                : entry,
            ),
          }
        : current,
    );
  }
  return rollbackByQuery;
}

export function patchOwnedPullRequestPinInCache(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  identity: PullRequestProjectIdentityInput;
  expectedIsPinned: boolean;
  nextIsPinned: boolean;
}) {
  input.queryClient.setQueryData<PullRequestListCache>(input.queryKey, (current) =>
    current
      ? {
          ...current,
          entries: current.entries.map((entry) =>
            matchesPullRequestPinIdentity(entry, input.identity) &&
            pullRequestListProjectPin(entry, input.identity.projectId) === input.expectedIsPinned
              ? updateEntryProjectPin(entry, input.identity.projectId, input.nextIsPinned)
              : entry,
          ),
        }
      : current,
  );
}

export function preserveProtectedPinValues(
  result: PullRequestsListResult,
  current: PullRequestListCache | undefined,
  protectedIdentities: ReadonlySet<string>,
): PullRequestsListResult {
  if (!current || protectedIdentities.size === 0) return result;
  type ResultEntry = PullRequestsListResult["entries"][number];
  const currentEntries = current.entries as unknown as ReadonlyArray<ResultEntry>;
  const currentByRemoteIdentity = new Map(
    currentEntries.map((entry) => [pullRequestRemoteIdentityKey(entry), entry] as const),
  );
  const resultRemoteIdentities = new Set(result.entries.map(pullRequestRemoteIdentityKey));
  const missingProtectedPinnedEntries = currentEntries.filter((entry) => {
    if (resultRemoteIdentities.has(pullRequestRemoteIdentityKey(entry))) return false;
    return pullRequestListProjectContexts(entry).some(
      (context) =>
        context.isPinned &&
        protectedIdentities.has(
          pullRequestIdentityKey({
            projectId: context.projectId,
            provider: entry.provider,
            repository: entry.repository,
            number: entry.number,
          }),
        ),
    );
  });
  return {
    ...result,
    entries: [
      ...missingProtectedPinnedEntries,
      ...result.entries.flatMap((entry) => {
        const currentEntry = currentByRemoteIdentity.get(pullRequestRemoteIdentityKey(entry));
        const contexts = pullRequestListProjectContexts(entry);
        const protectedContexts = contexts.filter((context) =>
          protectedIdentities.has(
            pullRequestIdentityKey({
              projectId: context.projectId,
              provider: entry.provider,
              repository: entry.repository,
              number: entry.number,
            }),
          ),
        );
        if (!currentEntry) {
          if (protectedContexts.length === 0) return [entry];
          // A missing current row is an acknowledged unpin of recovered-only data. Retain an
          // aggregate row only when it still represents an unprotected project context.
          if (protectedContexts.length === contexts.length) return [];
          return [
            protectedContexts.reduce(
              (next, context) =>
                updatePullRequestListEntryProjectPin(next, context.projectId, false),
              entry,
            ),
          ];
        }
        const hasAggregateContexts =
          (entry.projectContexts?.length ?? 0) > 0 ||
          (currentEntry.projectContexts?.length ?? 0) > 0;
        const mergedEntry = hasAggregateContexts
          ? coalescePullRequestListEntries([entry, currentEntry], {
              preferredProjectId: entry.projectId,
            })[0]!
          : entry;
        return [
          pullRequestListProjectContexts(currentEntry).reduce((next, context) => {
            const identityKey = pullRequestIdentityKey({
              projectId: context.projectId,
              provider: entry.provider,
              repository: entry.repository,
              number: entry.number,
            });
            return protectedIdentities.has(identityKey)
              ? updatePullRequestListEntryProjectPin(next, context.projectId, context.isPinned)
              : next;
          }, mergedEntry),
        ];
      }),
    ],
  };
}

export type ProtectedActionFieldsByIdentity = ReadonlyMap<
  string,
  ReadonlySet<keyof PullRequestActionListPatch>
>;

export function preserveProtectedActionValues(
  result: PullRequestsListResult,
  current: PullRequestListCache | undefined,
  protectedFieldsByIdentity: ProtectedActionFieldsByIdentity,
): PullRequestsListResult {
  if (!current || protectedFieldsByIdentity.size === 0) return result;
  const currentByIdentity = new Map(
    current.entries.map((entry) => [pullRequestRemoteIdentityKey(entry), entry] as const),
  );
  return {
    ...result,
    entries: result.entries.map((entry) => {
      const identityKey = pullRequestRemoteIdentityKey(entry);
      const protectedFields = protectedFieldsByIdentity.get(identityKey);
      const currentEntry = currentByIdentity.get(identityKey);
      if (!protectedFields || !currentEntry) return entry;
      return {
        ...entry,
        ...(protectedFields.has("state") && currentEntry.state !== undefined
          ? { state: currentEntry.state }
          : {}),
        ...(protectedFields.has("isDraft") && currentEntry.isDraft !== undefined
          ? { isDraft: currentEntry.isDraft }
          : {}),
      };
    }),
  };
}
