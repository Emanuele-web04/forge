/**
 * GitManager - Effect service contract for stacked Git workflows.
 *
 * Orchestrates status inspection and commit/push/PR flows by composing
 * lower-level Git and external tool services.
 *
 * @module GitManager
 */
import {
  GitActionProgressEvent,
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitPullRequestSnapshotResult,
  GitResolvedPullRequest,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitWorkingTreeDiffStatsResult,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizeDiffInput,
  GitSummarizeDiffResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitManagerServiceError } from "../Errors.ts";

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export interface GitRunStackedActionOptions {
  readonly actionId?: string;
  readonly progressReporter?: GitActionProgressReporter;
}

/**
 * GitManagerShape - Service API for high-level Git workflow actions.
 */
export interface GitManagerShape {
  /**
   * Read current repository Git status plus open PR metadata when available.
   */
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

  /**
   * Resolve the most relevant pull request for an already-captured branch.
   * Unlike status(), lookup failures remain typed failures so callers can distinguish
   * “no PR exists” from “GitHub is temporarily unavailable”.
   */
  readonly pullRequestForBranch: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly upstreamRef: string | null;
  }) => Effect.Effect<GitResolvedPullRequest | null, GitManagerServiceError>;

  /**
   * Read a unified patch for the current repository working tree.
   */
  readonly readWorkingTreeDiff: (
    input: GitReadWorkingTreeDiffInput,
  ) => Effect.Effect<GitReadWorkingTreeDiffResult, GitManagerServiceError>;

  /**
   * Count the lines a scope's patch changes without returning the patch text.
   */
  readonly readWorkingTreeDiffStats: (
    input: GitReadWorkingTreeDiffInput,
  ) => Effect.Effect<GitWorkingTreeDiffStatsResult, GitManagerServiceError>;

  /**
   * Generate a read-only markdown summary for an existing diff patch.
   */
  readonly summarizeDiff: (
    input: GitSummarizeDiffInput,
  ) => Effect.Effect<GitSummarizeDiffResult, GitManagerServiceError>;

  /**
   * Resolve a pull request by URL/number against the current repository.
   */
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;

  /**
   * Load live CI checks and top-level review comments for a pull request.
   */
  readonly pullRequestSnapshot: (
    input: GitPullRequestSnapshotInput,
  ) => Effect.Effect<GitPullRequestSnapshotResult, GitManagerServiceError>;

  /**
   * Prepare a new thread workspace from a pull request in local or worktree mode.
   */
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;

  /**
   * Move a thread between Local and Worktree while preserving recoverable Git state.
   */
  readonly handoffThread: (
    input: Omit<GitHandoffThreadInput, "commandId" | "threadId">,
  ) => Effect.Effect<GitHandoffThreadResult, GitManagerServiceError>;

  /**
   * Run a Git action (`commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`).
   * When `featureBranch` is set, creates and checks out a feature branch first.
   */
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
}

/**
 * GitManager - Service tag for stacked Git workflow orchestration.
 */
export class GitManager extends ServiceMap.Service<GitManager, GitManagerShape>()(
  "synara/git/Services/GitManager",
) {}
