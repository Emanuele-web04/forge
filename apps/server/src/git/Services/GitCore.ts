/**
 * GitCore - Effect service contract for low-level Git operations.
 *
 * Wraps core repository primitives used by higher-level orchestration
 * services and WebSocket routes.
 *
 * @module GitCore
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitCreateDetachedWorktreeResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullResult,
  GitRemoveIndexLockInput,
  GitRemoveWorktreeInput,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStashInfoResult,
  GitStatusInput,
  GitStatusResult,
} from "@synara/contracts";

import type { GitCheckoutDirtyWorktreeError, GitCommandError } from "../Errors.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: "error" | "truncate";
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitStatusDetails extends Omit<GitStatusResult, "pr"> {
  isRepo: boolean;
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  upstreamRef: string | null;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitWorkingTreePatch {
  patch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitDeleteBranchInput {
  cwd: string;
  branch: string;
  force?: boolean | undefined;
}

export interface GitWorktreeOwnershipProof {
  readonly token: string;
  readonly gitDir: string;
  readonly branch: string | null;
  readonly head: string;
  /** Baseline state, including copied tracked, untracked, and .worktreeinclude files. */
  readonly stateHash?: string;
}

export interface GitVerifyWorktreeOwnershipResult {
  readonly verified: boolean;
  readonly reason: string | null;
}

export interface GitSnapshotWorktreeInput {
  readonly cwd: string;
  readonly outputPath: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitFetchPullRequestCommitInput {
  cwd: string;
  prNumber: number;
  /** When provided by a full PR URL, must match the remote used for the fetch. */
  expectedRepositoryNameWithOwner?: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitPublishBranchInput {
  cwd: string;
  branch: string;
}

/**
 * GitCoreShape - Service API for low-level Git repository interactions.
 */
export interface GitCoreShape {
  /** Serialize one complete mutation saga by canonical repository common directory. */
  readonly withMutation: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
  /**
   * Execute a raw Git command.
   */
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;

  /**
   * Read Git status for a repository.
   */
  readonly status: (input: GitStatusInput) => Effect.Effect<GitStatusResult, GitCommandError>;

  /**
   * Read detailed working tree / branch status for a repository.
   */
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;

  /**
   * Read a unified patch for the current working tree, including untracked files.
   */
  readonly readWorkingTreePatch: (
    cwd: string,
  ) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  /**
   * Read only unstaged tracked changes plus untracked files.
   */
  readonly readUnstagedPatch: (cwd: string) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  /**
   * Read only staged changes.
   */
  readonly readStagedPatch: (cwd: string) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  /**
   * Read aggregate branch changes from the upstream/base merge-base through the working tree.
   */
  readonly readBranchPatch: (cwd: string) => Effect.Effect<GitWorkingTreePatch, GitCommandError>;

  /**
   * Build staged change context for commit generation.
   */
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;

  /**
   * Create a commit with provided subject/body.
   */
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;

  /**
   * Push current branch, setting upstream if needed.
   */
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
  ) => Effect.Effect<GitPushResult, GitCommandError>;

  /**
   * Collect commit/diff context between base branch and current HEAD.
   */
  readonly readRangeContext: (
    cwd: string,
    baseBranch: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;

  /**
   * Read a Git config value from the local repository.
   */
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;

  /**
   * List local + remote branches and branch metadata.
   */
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;

  /**
   * Pull current branch from upstream using fast-forward only.
   */
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;

  /**
   * Create a worktree and branch from a base branch.
   */
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;

  /** Attach a non-versioned marker to a newly-created linked worktree's Git admin entry. */
  readonly recordWorktreeOwnership: (input: {
    readonly path: string;
    readonly branch: string | null;
    readonly token: string;
  }) => Effect.Effect<GitWorktreeOwnershipProof, GitCommandError>;

  /** Verify that a linked worktree is still the unchanged object carrying a marker. */
  readonly verifyWorktreeOwnership: (input: {
    readonly path: string;
    readonly proof: GitWorktreeOwnershipProof;
  }) => Effect.Effect<GitVerifyWorktreeOwnershipResult, GitCommandError>;

  /** Snapshot tracked changes and transferable local files before managed cleanup. */
  readonly snapshotWorktree: (
    input: GitSnapshotWorktreeInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Create a detached worktree from a branch or ref.
   */
  readonly createDetachedWorktree: (
    input: GitCreateDetachedWorktreeInput,
  ) => Effect.Effect<GitCreateDetachedWorktreeResult, GitCommandError>;

  /**
   * Materialize a GitHub pull request head as a local branch without switching checkout.
   */
  readonly fetchPullRequestBranch: (
    input: GitFetchPullRequestBranchInput,
  ) => Effect.Effect<void, GitCommandError>;

  /** Fetch a GitHub pull request head without creating or occupying a local branch. */
  readonly fetchPullRequestCommit: (
    input: GitFetchPullRequestCommitInput,
  ) => Effect.Effect<string, GitCommandError>;

  /**
   * Ensure a named remote exists for the provided URL, returning the reused or created remote name.
   */
  readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;

  /**
   * Fetch a remote branch into a local branch without checkout.
   */
  readonly fetchRemoteBranch: (
    input: GitFetchRemoteBranchInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Set the upstream tracking branch for a local branch.
   */
  readonly setBranchUpstream: (
    input: GitSetBranchUpstreamInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Remove an existing worktree.
   */
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Delete an existing local branch.
   */
  readonly deleteBranch: (input: GitDeleteBranchInput) => Effect.Effect<void, GitCommandError>;

  /** Atomically delete a local branch only when it still points at the expected object id. */
  readonly deleteBranchIfUnchanged: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly expectedHead: string;
  }) => Effect.Effect<void, GitCommandError>;

  /**
   * Rename an existing local branch.
   */
  readonly renameBranch: (
    input: GitRenameBranchInput,
  ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;

  /**
   * Create a local branch.
   */
  readonly createBranch: (input: GitCreateBranchInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Publish a local branch and set upstream tracking.
   */
  readonly publishBranch: (input: GitPublishBranchInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Checkout an existing branch and refresh its upstream metadata in background.
   */
  readonly checkoutBranch: (
    input: GitCheckoutInput,
  ) => Effect.Effect<void, GitCommandError | GitCheckoutDirtyWorktreeError, Scope.Scope>;

  /**
   * Stash local changes, checkout a branch, and re-apply the stash.
   */
  readonly stashAndCheckout: (
    input: GitStashAndCheckoutInput,
  ) => Effect.Effect<void, GitCommandError | GitCheckoutDirtyWorktreeError, Scope.Scope>;

  /** Drop the stash entry the caller inspected. */
  readonly stashDrop: (input: GitStashDropInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Read metadata for the latest stash entry.
   */
  readonly stashInfo: (
    input: GitStashInfoInput,
  ) => Effect.Effect<GitStashInfoResult, GitCommandError>;

  /**
   * Remove the repository index lock file after Git reports a stale lock.
   */
  readonly removeIndexLock: (
    input: GitRemoveIndexLockInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Initialize a repository in the provided directory.
   */
  readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;

  /**
   * List local branch names (short format).
   */
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;

  /**
   * Stage the provided paths into the index (`git add`).
   */
  readonly stageFiles: (
    cwd: string,
    paths: readonly string[],
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Unstage the provided paths from the index, handling the pre-initial-commit case.
   */
  readonly unstageFiles: (
    cwd: string,
    paths: readonly string[],
  ) => Effect.Effect<void, GitCommandError>;
}

/**
 * GitCore - Service tag for low-level Git repository operations.
 */
export class GitCore extends ServiceMap.Service<GitCore, GitCoreShape>()(
  "synara/git/Services/GitCore",
) {}
