import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import { resolveThreadBranchRegressionGuard } from "@synara/shared/git";

export type ThreadPullRequestLookup =
  | {
      readonly status: "resolved";
      readonly pullRequest: OrchestrationThreadPullRequest | null;
    }
  | { readonly status: "unavailable" };

export interface ThreadGitMetadataPatch {
  readonly branch?: string | null;
  readonly lastKnownPr?: OrchestrationThreadPullRequest | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}

function pullRequestsEqual(
  left: OrchestrationThreadPullRequest | null,
  right: OrchestrationThreadPullRequest | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    left.baseBranch === right.baseBranch &&
    left.headBranch === right.headBranch &&
    left.state === right.state &&
    (left.isDraft ?? false) === (right.isDraft ?? false) &&
    (left.mergeability ?? "unknown") === (right.mergeability ?? "unknown") &&
    (left.additions ?? null) === (right.additions ?? null) &&
    (left.deletions ?? null) === (right.deletions ?? null) &&
    (left.changedFiles ?? null) === (right.changedFiles ?? null)
  );
}

/**
 * Derives the durable thread metadata observed at a provider-turn boundary.
 *
 * A successful lookup may intentionally clear a prior PR when the current branch has none.
 * A transient lookup failure preserves a PR on an unchanged branch, but clears it when the
 * branch itself changed so the sidebar never labels the new branch with the previous branch's PR.
 */
export function deriveThreadGitMetadataPatch(input: {
  readonly currentBranch: string | null;
  readonly currentPullRequest: OrchestrationThreadPullRequest | null;
  readonly observedBranch: string | null;
  readonly pullRequestLookup: ThreadPullRequestLookup;
  readonly dedicatedWorktree?: {
    readonly cwd: string;
    readonly currentPath: string | null;
    readonly currentBranch: string | null;
  };
}): ThreadGitMetadataPatch | null {
  const guardedBranch = resolveThreadBranchRegressionGuard({
    currentBranch: input.currentBranch,
    nextBranch: input.observedBranch,
  });
  if (guardedBranch !== input.observedBranch) {
    return null;
  }

  const branchChanged = input.currentBranch !== input.observedBranch;
  let nextPullRequest = input.currentPullRequest;

  if (input.observedBranch === null) {
    nextPullRequest = null;
  } else if (input.pullRequestLookup.status === "resolved") {
    nextPullRequest = input.pullRequestLookup.pullRequest;
  } else if (branchChanged) {
    nextPullRequest = null;
  }

  const pullRequestChanged = !pullRequestsEqual(input.currentPullRequest, nextPullRequest);
  const dedicatedWorktree = input.dedicatedWorktree;
  const associatedPathChanged =
    dedicatedWorktree !== undefined && dedicatedWorktree.currentPath !== dedicatedWorktree.cwd;
  const associatedBranchChanged =
    input.observedBranch !== null &&
    dedicatedWorktree !== undefined &&
    dedicatedWorktree.currentBranch !== input.observedBranch;
  const associatedWorktreePatch =
    dedicatedWorktree !== undefined && (associatedPathChanged || associatedBranchChanged)
      ? {
          ...(associatedPathChanged ? { associatedWorktreePath: dedicatedWorktree.cwd } : {}),
          ...(associatedBranchChanged
            ? {
                associatedWorktreeBranch: input.observedBranch,
                associatedWorktreeRef: input.observedBranch,
              }
            : {}),
        }
      : null;
  if (!branchChanged && !pullRequestChanged && associatedWorktreePatch === null) {
    return null;
  }

  return {
    ...(branchChanged ? { branch: input.observedBranch } : {}),
    ...(pullRequestChanged ? { lastKnownPr: nextPullRequest } : {}),
    ...(associatedWorktreePatch ?? {}),
  };
}
