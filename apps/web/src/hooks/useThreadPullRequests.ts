// FILE: useThreadPullRequests.ts
// Purpose: Shared PR-badge source for thread rows (sidebar tree, activity view, kanban
//          cards). Polls live git status per checkout plus the stored PR reference per
//          thread, then resolves which PR each thread row should surface.
// Layer: UI state hook (resolution rules live in Sidebar.logic.ts)
// Exports: useThreadPullRequests, resolveThreadPullRequestFallback, toThreadPullRequest

import type {
  GitStatusResult,
  OrchestrationThreadPullRequest,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { resolveSidebarThreadPullRequest } from "../components/Sidebar.logic";
import { gitResolvePullRequestQueryOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import type { SidebarThreadSummary } from "../types";

export type ThreadPullRequest = GitStatusResult["pr"];

export type ThreadPullRequestSource = Pick<
  SidebarThreadSummary,
  "id" | "projectId" | "branch" | "envMode" | "worktreePath" | "lastKnownPr"
>;

const THREAD_PR_STALE_TIME_MS = 30_000;
const THREAD_PR_REFETCH_INTERVAL_MS = 60_000;

// Also accepts persisted `lastKnownPr` entries, whose draft/mergeability/diff fields are
// optional because older rows predate them.
export function toThreadPullRequest(
  pr:
    | NonNullable<ThreadPullRequest>
    | {
        number: number;
        title: string;
        url: string;
        baseBranch: string;
        headBranch: string;
        state: "open" | "closed" | "merged";
        isDraft?: boolean | undefined;
        mergeability?: "mergeable" | "conflicting" | "unknown" | undefined;
        additions?: number | null | undefined;
        deletions?: number | null | undefined;
        changedFiles?: number | null | undefined;
      },
): ThreadPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    state: pr.state,
    isDraft: pr.isDraft ?? false,
    mergeability: pr.mergeability ?? "unknown",
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changedFiles ?? null,
  };
}

/**
 * Resolution for a thread row without live git-status coverage: rows revealed before the
 * shared hook picks them up (activity paging reveals a row a paint earlier) or rendered
 * where no checkout is resolvable. Runs the same persisted-PR validation as the live
 * path, so a stale "open" badge the resolver already ruled out cannot reappear here.
 */
export function resolveThreadPullRequestFallback(input: {
  readonly branch: string | null;
  readonly hasDedicatedWorktree: boolean;
  readonly lastKnownPr: OrchestrationThreadPullRequest | null | undefined;
}): ThreadPullRequest {
  return resolveSidebarThreadPullRequest({
    threadBranch: input.branch,
    liveBranch: null,
    hasLiveStatus: false,
    hasDedicatedWorktree: input.hasDedicatedWorktree,
    livePullRequest: null,
    persistedPullRequest: input.lastKnownPr ? toThreadPullRequest(input.lastKnownPr) : null,
  });
}

/**
 * Resolves the PR badge for each given thread. Callers pass only the rows they render:
 * every distinct thread-owned worktree gets a polled git-status query and every stored PR
 * reference a polled lookup. Shared local checkouts intentionally use only the durable thread PR:
 * their live branch may belong to another concurrent thread.
 */
export function useThreadPullRequests(input: {
  readonly threads: readonly ThreadPullRequestSource[];
  readonly projectCwdById: ReadonlyMap<ProjectId, string>;
}): ReadonlyMap<ThreadId, ThreadPullRequest> {
  const { threads, projectCwdById } = input;
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        lastKnownPr: thread.lastKnownPr ?? null,
        hasDedicatedWorktree: thread.worktreePath !== null,
        cwd: resolveThreadWorkspaceCwd({
          projectCwd: projectCwdById.get(thread.projectId) ?? null,
          envMode: thread.envMode,
          worktreePath: thread.worktreePath,
        }),
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.hasDedicatedWorktree)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: THREAD_PR_STALE_TIME_MS,
      refetchInterval: THREAD_PR_REFETCH_INTERVAL_MS,
    })),
  });
  const threadStoredPrTargets = useMemo(
    () =>
      threadGitTargets.flatMap((target) =>
        target.cwd !== null &&
        target.lastKnownPr !== null &&
        target.lastKnownPr.url.trim().length > 0
          ? [{ ...target, cwd: target.cwd, lastKnownPr: target.lastKnownPr }]
          : [],
      ),
    [threadGitTargets],
  );
  const threadStoredPrQueries = useQueries({
    queries: threadStoredPrTargets.map((target) => ({
      ...gitResolvePullRequestQueryOptions({
        cwd: target.cwd,
        reference: target.lastKnownPr.url,
      }),
      staleTime: THREAD_PR_STALE_TIME_MS,
      refetchInterval: THREAD_PR_REFETCH_INTERVAL_MS,
    })),
  });
  return useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      // Keep the last successful snapshot during a failed background refetch. React Query
      // retains that data, and it is still a better branch authority than stale thread metadata.
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const storedPrByThreadId = new Map<ThreadId, ThreadPullRequest>();
    for (let index = 0; index < threadStoredPrTargets.length; index += 1) {
      const target = threadStoredPrTargets[index];
      if (!target) {
        continue;
      }
      const result = threadStoredPrQueries[index]?.data?.pullRequest ?? null;
      if (result) {
        storedPrByThreadId.set(target.threadId, toThreadPullRequest(result));
        continue;
      }
      storedPrByThreadId.set(target.threadId, toThreadPullRequest(target.lastKnownPr));
    }

    const map = new Map<ThreadId, ThreadPullRequest>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const persistedPr =
        storedPrByThreadId.get(target.threadId) ??
        (target.lastKnownPr ? toThreadPullRequest(target.lastKnownPr) : null);
      map.set(
        target.threadId,
        resolveSidebarThreadPullRequest({
          threadBranch: target.branch,
          liveBranch: status?.branch ?? null,
          hasLiveStatus: status !== undefined,
          hasDedicatedWorktree: target.hasDedicatedWorktree,
          livePullRequest: status?.pr ?? null,
          persistedPullRequest: persistedPr,
        }),
      );
    }
    return map;
  }, [
    threadGitStatusCwds,
    threadGitStatusQueries,
    threadGitTargets,
    threadStoredPrQueries,
    threadStoredPrTargets,
  ]);
}
