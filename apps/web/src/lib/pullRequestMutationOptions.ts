import type {
  ProjectId,
  PullRequestActionInput,
  PullRequestCommentInput,
  PullRequestReviewDraftCreateInput,
  PullRequestReviewDraftDeleteInput,
  PullRequestReviewDraftListInput,
  PullRequestReviewDraftUpdateInput,
  PullRequestReviewSubmitInput,
  PullRequestSetPinnedInput,
  PullRequestState,
} from "@synara/contracts";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";
import { gitQueryKeys } from "./gitReactQuery";
import {
  cancelPullRequestListScopes,
  invalidateOtherPullRequestListQueries,
  invalidatePullRequestListScopes,
  isPullRequestListQueryKey,
  listScopesContainingPullRequest,
  listScopesContainingPullRequestRepository,
  optimisticallyPatchPullRequestActionFieldsInListCaches,
  optimisticallyPatchPullRequestPinInListCaches,
  patchOwnedPullRequestPinInCache,
  patchPullRequestPinInListCaches,
  preserveProtectedActionValues,
  preserveProtectedPinValues,
  rollbackPullRequestActionFieldsInListCaches,
  type ActionListCacheRollback,
  type PullRequestActionListPatch,
  type PullRequestListCache,
  type PullRequestListQueryScope,
} from "./pullRequestCache";
import {
  beginPinMutation,
  beginPullRequestActionProtection,
  beginPullRequestRefresh,
  finishPinMutation,
  finishPullRequestActionProtection,
  finishPullRequestRefresh,
  isFinalActivePinMutation,
  isLatestPinMutation,
  pinMutationRollbackState,
  protectedActionFieldsForRefresh,
  protectedPinIdentitiesForRefresh,
  PULL_REQUEST_ACTION_REFRESH_SCOPE_ID,
  recordPinMutationAcknowledgement,
  recordPinMutationBaseline,
  runPinMutationInIdentityOrder,
  type PinMutationContext,
  type PullRequestActionProtectionContext,
} from "./pullRequestMutationCoordinator";
import { normalizePullRequestListKeyInput, pullRequestQueryKeys } from "./pullRequestQueryOptions";

export const pullRequestMutationKeys = {
  action: ["pull-requests", "action"] as const,
  setPinned: ["pull-requests", "set-pinned"] as const,
  comment: ["pull-requests", "comment"] as const,
  forceRefresh: ["pull-requests", "force-refresh"] as const,
  createReviewDraft: ["pull-requests", "review-drafts", "create"] as const,
  updateReviewDraft: ["pull-requests", "review-drafts", "update"] as const,
  deleteReviewDraft: ["pull-requests", "review-drafts", "delete"] as const,
  submitReview: ["pull-requests", "review", "submit"] as const,
};

function refreshReviewDrafts(
  queryClient: QueryClient,
  input: PullRequestReviewDraftListInput,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: pullRequestQueryKeys.reviewDrafts(input),
    exact: true,
  });
}

export function pullRequestReviewDraftCreateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.createReviewDraft,
    networkMode: "always",
    mutationFn: (input: PullRequestReviewDraftCreateInput) =>
      ensureNativeApi().pullRequests.createReviewDraft(input),
    onSettled: (_result, _error, input) => refreshReviewDrafts(queryClient, input),
  });
}

export function pullRequestReviewDraftUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.updateReviewDraft,
    networkMode: "always",
    mutationFn: (input: PullRequestReviewDraftUpdateInput) =>
      ensureNativeApi().pullRequests.updateReviewDraft(input),
    onSettled: (_result, _error, input) => refreshReviewDrafts(queryClient, input),
  });
}

export function pullRequestReviewDraftDeleteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.deleteReviewDraft,
    networkMode: "always",
    mutationFn: (input: PullRequestReviewDraftDeleteInput) =>
      ensureNativeApi().pullRequests.deleteReviewDraft(input),
    onSettled: (_result, _error, input) => refreshReviewDrafts(queryClient, input),
  });
}

export function pullRequestReviewSubmitMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.submitReview,
    networkMode: "always",
    mutationFn: (input: PullRequestReviewSubmitInput) =>
      ensureNativeApi().pullRequests.submitReview(input),
    onSettled: async (_result, _error, input) => {
      await Promise.all([
        refreshReviewDrafts(queryClient, input),
        queryClient.invalidateQueries({
          queryKey: pullRequestQueryKeys.detail(input),
          exact: true,
        }),
      ]);
    },
  });
}

function refreshPullRequestReviewRequestCounts(queryClient: QueryClient): void {
  // This global sidebar badge is passive UI. Mark it stale and refresh active observers without
  // keeping the originating PR action pending while every repository is counted again.
  void queryClient
    .invalidateQueries({ queryKey: pullRequestQueryKeys.reviewRequestCounts })
    .catch(() => undefined);
}

type ActionOwnedFields = { state?: PullRequestState; isDraft?: boolean; closedAt?: string | null };
type ActionMutationContext = {
  previousDetailFields: ActionOwnedFields | null;
  listRollbackByQuery: ActionListCacheRollback[];
  optimisticListPatch: PullRequestActionListPatch;
  affectedScopes: PullRequestListQueryScope[];
  protection: PullRequestActionProtectionContext;
};

function optimisticPullRequestActionPatch(
  action: PullRequestActionInput["action"],
): { state?: PullRequestState; isDraft?: boolean; closedAt?: string | null } | null {
  switch (action) {
    case "ready":
      return { isDraft: false };
    case "draft":
      return { isDraft: true };
    case "close":
      return { state: "closed", closedAt: new Date().toISOString() };
    case "reopen":
      return { state: "open", closedAt: null };
    case "merge":
      return null;
  }
}

function actionListScopes(
  queryClient: QueryClient,
  input: PullRequestActionInput,
  targetState: PullRequestState | undefined,
): PullRequestListQueryScope[] {
  const scopes = listScopesContainingPullRequestRepository(queryClient, input);
  if (targetState === undefined) return scopes;
  const byKey = new Map(
    scopes.map((scope) => [`${scope.state}\u0000${scope.projectId ?? ""}`, scope] as const),
  );
  const projectIds = new Set<ProjectId | null>([
    input.projectId,
    null,
    ...scopes.map((scope) => scope.projectId),
  ]);
  for (const projectId of projectIds) {
    const target = { state: targetState, projectId };
    byKey.set(`${target.state}\u0000${target.projectId ?? ""}`, target);
  }
  return [...byKey.values()];
}

function pullRequestActionTargetState(
  action: PullRequestActionInput["action"],
): PullRequestState | undefined {
  switch (action) {
    case "close":
      return "closed";
    case "reopen":
      return "open";
    case "merge":
      return "merged";
    case "ready":
    case "draft":
      return undefined;
  }
}

export function pullRequestActionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.action,
    // Manual refreshes share this scope, so their snapshot cannot race a PR state action.
    scope: { id: PULL_REQUEST_ACTION_REFRESH_SCOPE_ID },
    networkMode: "always",
    mutationFn: (input: PullRequestActionInput) => ensureNativeApi().pullRequests.action(input),
    onMutate: async (input): Promise<ActionMutationContext> => {
      const patch = optimisticPullRequestActionPatch(input.action) ?? {};
      const optimisticListPatch = {
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.isDraft !== undefined ? { isDraft: patch.isDraft } : {}),
      };
      const protection = beginPullRequestActionProtection(queryClient, input, optimisticListPatch);
      try {
        const detailKey = pullRequestQueryKeys.detail(input);
        const affectedScopes = actionListScopes(
          queryClient,
          input,
          pullRequestActionTargetState(input.action),
        );
        await Promise.all([
          queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
          cancelPullRequestListScopes(queryClient, affectedScopes),
        ]);
        const previousDetail = queryClient.getQueryData<
          ActionOwnedFields & Record<string, unknown>
        >(detailKey);
        let previousDetailFields: ActionOwnedFields | null = null;
        if (previousDetail && Object.keys(patch).length > 0) {
          previousDetailFields = {
            ...(patch.state !== undefined ? { state: previousDetail.state } : {}),
            ...(patch.isDraft !== undefined ? { isDraft: previousDetail.isDraft } : {}),
            ...(patch.closedAt !== undefined ? { closedAt: previousDetail.closedAt } : {}),
          };
          queryClient.setQueryData(detailKey, { ...previousDetail, ...patch });
        }

        return {
          previousDetailFields,
          optimisticListPatch,
          listRollbackByQuery: optimisticallyPatchPullRequestActionFieldsInListCaches(
            queryClient,
            input,
            optimisticListPatch,
          ),
          affectedScopes,
          protection,
        };
      } catch (error) {
        finishPullRequestActionProtection(queryClient, protection);
        throw error;
      }
    },
    onError: async (_error, input, context) => {
      const patch = optimisticPullRequestActionPatch(input.action);
      if (patch && context) {
        const previousDetailFields = context.previousDetailFields;
        if (previousDetailFields) {
          queryClient.setQueryData<Record<string, unknown>>(
            pullRequestQueryKeys.detail(input),
            (current) => (current ? { ...current, ...previousDetailFields } : current),
          );
        }
        rollbackPullRequestActionFieldsInListCaches({
          queryClient,
          identity: input,
          optimisticPatch: context.optimisticListPatch,
          rollbackByQuery: context.listRollbackByQuery,
        });
      }
      // The command may have reached GitHub even when transport failed. Mark the rollback
      // provisional so reconnect/refetch converges on server truth instead of assuming failure.
      await Promise.all([
        context
          ? invalidatePullRequestListScopes(queryClient, context.affectedScopes)
          : Promise.resolve(),
        queryClient.invalidateQueries({
          queryKey: pullRequestQueryKeys.detail(input),
          exact: true,
        }),
      ]);
      refreshPullRequestReviewRequestCounts(queryClient);
    },
    onSuccess: async (result, input, context) => {
      await Promise.all([
        invalidatePullRequestListScopes(queryClient, context.affectedScopes),
        queryClient.invalidateQueries({
          queryKey: pullRequestQueryKeys.detail(input),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: gitQueryKeys.pullRequest(result.workspaceRoot),
        }),
      ]);
      refreshPullRequestReviewRequestCounts(queryClient);
    },
    onSettled: (_result, _error, _input, context) => {
      if (context) finishPullRequestActionProtection(queryClient, context.protection);
    },
  });
}

function rollbackPullRequestPinInListCaches(
  queryClient: QueryClient,
  input: PullRequestSetPinnedInput,
  context: PinMutationContext,
) {
  const rollbackState = pinMutationRollbackState(queryClient, context);
  if (!rollbackState.latest) return;

  if (rollbackState.acknowledgedIsPinned !== null) {
    for (const [queryKey] of queryClient.getQueriesData<PullRequestListCache>({
      predicate: (query) => isPullRequestListQueryKey(query.queryKey),
    })) {
      patchOwnedPullRequestPinInCache({
        queryClient,
        queryKey,
        identity: input,
        expectedIsPinned: context.optimisticIsPinned,
        nextIsPinned: rollbackState.acknowledgedIsPinned,
      });
    }
    return;
  }

  for (const baseline of rollbackState.baselineByQuery) {
    patchOwnedPullRequestPinInCache({
      queryClient,
      queryKey: baseline.queryKey,
      identity: input,
      expectedIsPinned: context.optimisticIsPinned,
      nextIsPinned: baseline.previousIsPinned,
    });
  }
}

export function pullRequestSetPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.setPinned,
    // Pins no longer block refreshes or unrelated PRs. The coordinator serializes only writes
    // for the same identity, while the epochs below keep optimistic callbacks field-safe.
    networkMode: "always",
    mutationFn: (input: PullRequestSetPinnedInput) =>
      runPinMutationInIdentityOrder(queryClient, input, () =>
        ensureNativeApi().pullRequests.setPinned(input),
      ),
    onMutate: async (input): Promise<PinMutationContext> => {
      const mutation = beginPinMutation(queryClient, input);
      const context: PinMutationContext = {
        ...mutation,
        rollbackByQuery: [],
        affectedScopes: listScopesContainingPullRequest(queryClient, input),
      };
      try {
        await cancelPullRequestListScopes(queryClient, context.affectedScopes);
        context.rollbackByQuery = optimisticallyPatchPullRequestPinInListCaches(queryClient, input);
        recordPinMutationBaseline(queryClient, context);
        return context;
      } catch (error) {
        finishPinMutation(queryClient, context);
        throw error;
      }
    },
    onError: (_error, input, context) => {
      if (context) rollbackPullRequestPinInListCaches(queryClient, input, context);
    },
    onSuccess: async (result, _input, context) => {
      if (!context) return;
      recordPinMutationAcknowledgement(queryClient, context, result.isPinned);
      if (!isLatestPinMutation(queryClient, context)) return;
      await cancelPullRequestListScopes(queryClient, context.affectedScopes);
      if (!isLatestPinMutation(queryClient, context)) return;
      patchPullRequestPinInListCaches(queryClient, result, result.isPinned);
    },
    onSettled: async (_result, _error, _input, context) => {
      if (!context) return;
      const reconcileMembership = isFinalActivePinMutation(queryClient, context);
      const affectedScopes = context.affectedScopes;
      finishPinMutation(queryClient, context);
      // A row may exist only in an exact truncated query. Revalidate the All/exact siblings
      // once the rapid-toggle chain settles so pin membership is added or removed correctly.
      if (reconcileMembership) {
        await invalidatePullRequestListScopes(queryClient, affectedScopes);
      }
    },
  });
}

export function pullRequestCommentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.comment,
    networkMode: "always",
    mutationFn: (input: PullRequestCommentInput) => ensureNativeApi().pullRequests.comment(input),
    onSettled: async (_result, _error, input) => {
      const detailKey = pullRequestQueryKeys.detail(input);
      const detailState = queryClient.getQueryData<{ state?: PullRequestState }>(detailKey)?.state;
      const affectedScopes = listScopesContainingPullRequestRepository(queryClient, input);
      if (detailState) {
        // A new comment updates GitHub's `updatedAt` and can move an out-of-cap PR into either
        // aggregate. Include those destination scopes even when no cached row proves membership.
        affectedScopes.push(
          { state: detailState, projectId: input.projectId },
          { state: detailState, projectId: null },
        );
      }
      await Promise.all([
        invalidatePullRequestListScopes(queryClient, affectedScopes),
        queryClient.invalidateQueries({
          queryKey: detailKey,
          exact: true,
        }),
      ]);
    },
  });
}

export function pullRequestsForceRefreshMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.forceRefresh,
    // State-changing actions and snapshots are serialized; pins remain concurrent and are
    // merged field-by-field through the retained identity protection below.
    scope: { id: PULL_REQUEST_ACTION_REFRESH_SCOPE_ID },
    networkMode: "always",
    mutationFn: (input: { state: PullRequestState; projectId: ProjectId | null }) =>
      ensureNativeApi().pullRequests.list({
        involvement: "all",
        state: input.state,
        projectId: input.projectId,
        forceRefresh: true,
      }),
    onMutate: async (input) => {
      const context = beginPullRequestRefresh(queryClient);
      try {
        await queryClient.cancelQueries({
          queryKey: pullRequestQueryKeys.list(normalizePullRequestListKeyInput(input)),
          exact: true,
        });
        return context;
      } catch (error) {
        finishPullRequestRefresh(queryClient, context);
        throw error;
      }
    },
    onSuccess: async (result, input, context) => {
      const refreshedQueryKey = pullRequestQueryKeys.list(normalizePullRequestListKeyInput(input));
      const protectedIdentities = context
        ? protectedPinIdentitiesForRefresh(queryClient, context)
        : new Set<string>();
      const current = queryClient.getQueryData<PullRequestListCache>(refreshedQueryKey);
      const actionProtectedResult = context
        ? preserveProtectedActionValues(
            result,
            current,
            protectedActionFieldsForRefresh(queryClient, context),
          )
        : result;
      queryClient.setQueryData(
        refreshedQueryKey,
        preserveProtectedPinValues(actionProtectedResult, current, protectedIdentities),
      );
      await invalidateOtherPullRequestListQueries(queryClient, refreshedQueryKey);
    },
    onSettled: (_result, _error, _input, context) => {
      finishPullRequestRefresh(queryClient, context);
    },
  });
}
