import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import { Effect, FileSystem, Layer, Option, Path } from "effect";
import type {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitStackedAction,
  ModelSelection,
  ProviderStartOptions,
} from "@synara/contracts";
import {
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@synara/shared/git";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@synara/shared/githubRepository";
import { resolveWorktreeHandoffIntent } from "@synara/shared/worktreeHandoff";

import { GitManagerError } from "../Errors.ts";
import {
  GitManager,
  type GitActionProgressReporter,
  type GitManagerShape,
  type GitRunStackedActionOptions,
} from "../Services/GitManager.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitHubCli, type GitHubPullRequestSummary } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { detectPrTemplate } from "../PrTemplateDetection.ts";
import { buildGitTextGenerationCallInput } from "../textGenerationSelection.ts";
import { ServerConfig } from "../../config.ts";

const COMMIT_TIMEOUT_MS = 10 * 60_000;
const MAX_PROGRESS_TEXT_LENGTH = 500;
const OPEN_PR_LOOKUP_LIMIT = 10;
// Any-state lookups scan more PRs so the newest merged/closed PR still surfaces.
const PR_LOOKUP_ALL_STATES_LIMIT = 20;
type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;

// GitManager's working PR shape: a GitHubPullRequestSummary whose state/updatedAt are
// always resolved. Derived from the service summary so the shapes cannot drift field by field.
interface PullRequestInfo extends Omit<GitHubPullRequestSummary, "state" | "updatedAt"> {
  readonly state: NonNullable<GitHubPullRequestSummary["state"]>;
  readonly updatedAt: string | null;
}

interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  mergeability: "mergeable" | "conflicting" | "unknown";
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

interface GitTextGenerationParams {
  textGenerationModel?: string | undefined;
  textGenerationModelSelection?: ModelSelection | undefined;
  codexHomePath?: string | undefined;
  providerOptions?: ProviderStartOptions | undefined;
}

interface FailedLocalHandoffRecovery {
  worktreeRecreated: boolean;
  worktreeChangesRestored: boolean;
  localChangesRestored: boolean;
  recoveryNotes: ReadonlyArray<string>;
}

interface FailedLocalTransferRecovery extends FailedLocalHandoffRecovery {
  localCheckoutRestored: boolean;
}

interface FailedWorktreeHandoffRecovery {
  checkoutRestored: boolean;
  stashRestored: boolean;
  recoveryNotes: ReadonlyArray<string>;
}

interface FailedWorktreeTransferRecovery extends FailedWorktreeHandoffRecovery {
  worktreeRemoved: boolean;
}

// Host + owner/repo extraction from a PR web URL. Used to query the repository that owns
// the PR even when the local checkout's remotes point at a fork or a GitHub Enterprise host.
function parsePullRequestRepositoryFromUrl(
  url: string,
): { host: string; owner: string; repo: string } | null {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(url.trim());
  const host = match?.[1]?.trim() ?? "";
  const owner = match?.[2]?.trim() ?? "";
  const repo = match?.[3]?.trim() ?? "";
  return host.length > 0 && owner.length > 0 && repo.length > 0 ? { host, owner, repo } : null;
}

// github.com-only on purpose: callers use it to reconstruct `owner/repo` for fork heads,
// which is only well-defined for PRs hosted on github.com.
function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return null;
  }
  const repository = parsePullRequestRepositoryFromUrl(trimmed);
  return repository && repository.host.toLowerCase() === "github.com" ? repository.repo : null;
}

function resolveHeadRepositoryNameWithOwner(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string | null {
  const explicitRepository = pullRequest.headRepositoryNameWithOwner?.trim() ?? "";
  if (explicitRepository.length > 0) {
    return explicitRepository;
  }

  if (!pullRequest.isCrossRepository) {
    return null;
  }

  const ownerLogin = pullRequest.headRepositoryOwnerLogin?.trim() ?? "";
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url);
  if (ownerLogin.length === 0 || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `synara/pr-${pullRequest.number}/${suffix}`;
}

function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function resolvePullRequestHeadRepositoryNameWithOwner(
  pr: PullRequestHeadRemoteInfo & { url: string },
): string | null {
  const explicitRepository = normalizeOptionalString(pr.headRepositoryNameWithOwner);
  if (explicitRepository) {
    return explicitRepository;
  }

  if (!pr.isCrossRepository) {
    return null;
  }

  const ownerLogin = normalizeOptionalString(pr.headRepositoryOwnerLogin);
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pr.url);
  if (!ownerLogin || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

function matchesBranchHeadContext(
  pr: PullRequestInfo,
  headContext: Pick<
    BranchHeadContext,
    "headBranch" | "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin" | "isCrossRepository"
  >,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  const expectedHeadOwner =
    normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(expectedHeadRepository);
  const prHeadRepository = normalizeOptionalRepositoryNameWithOwner(
    resolvePullRequestHeadRepositoryNameWithOwner(pr),
  );
  const prHeadOwner =
    normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
    parseRepositoryOwnerLogin(prHeadRepository);

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    if ((expectedHeadRepository || expectedHeadOwner) && !prHeadRepository && !prHeadOwner) {
      return false;
    }
    if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
      return false;
    }
    if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
      return false;
    }
    return true;
  }

  if (pr.isCrossRepository === true) {
    return false;
  }
  if (expectedHeadRepository && prHeadRepository && expectedHeadRepository !== prHeadRepository) {
    return false;
  }
  if (expectedHeadOwner && prHeadOwner && expectedHeadOwner !== prHeadOwner) {
    return false;
  }
  return true;
}

// Normalizes `gh pr view/list` service output into the richer internal PR shape.
function toPullRequestInfo(pullRequest: GitHubPullRequestSummary): PullRequestInfo {
  return {
    ...pullRequest,
    state: pullRequest.state ?? "open",
    updatedAt: pullRequest.updatedAt ?? null,
  };
}

// Detects GitHub's duplicate-PR response from `gh pr create`.
function isPullRequestAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("pull request") &&
    message.includes("branch") &&
    message.includes("already exists")
  );
}

// Pulls the existing PR URL out of GitHub's duplicate-PR error when present.
function extractPullRequestUrlFromError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/i.exec(error.message);
  return match?.[0] ?? null;
}

function gitManagerError(operation: string, detail: string, cause?: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

function summarizePathForCommitSubject(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return "project files";
  }

  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

function deriveFallbackCommitSubject(stagedSummary: string): string {
  const lines = stagedSummary
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "Update project files";
  }

  const firstEntry = lines[0]?.split("\t") ?? [];
  const rawStatus = firstEntry[0]?.trim().toUpperCase() ?? "";
  const firstPath = firstEntry.at(-1)?.trim() ?? "";
  const fileLabel = summarizePathForCommitSubject(firstPath);

  if (lines.length === 1) {
    if (rawStatus.startsWith("A")) {
      return `Add ${fileLabel}`;
    }
    if (rawStatus.startsWith("D")) {
      return `Remove ${fileLabel}`;
    }
    if (rawStatus.startsWith("R")) {
      return `Rename ${fileLabel}`;
    }
    return `Update ${fileLabel}`;
  }

  const uniqueTopLevelDirs = Array.from(
    new Set(
      lines
        .map((line) => {
          const entry = line.split("\t");
          const filePath = entry.at(-1)?.trim() ?? "";
          return filePath.split("/")[0]?.trim() ?? "";
        })
        .filter((segment) => segment.length > 0),
    ),
  );

  if (uniqueTopLevelDirs.length === 1) {
    return `Update ${uniqueTopLevelDirs[0]} files`;
  }

  return "Update project files";
}

function createFallbackCommitSuggestion(input: {
  stagedSummary: string;
  includeBranch?: boolean;
}): CommitAndBranchSuggestion {
  const subject = deriveFallbackCommitSubject(input.stagedSummary);
  return {
    subject,
    body: "",
    ...(input.includeBranch ? { branch: sanitizeFeatureBranchName(subject) } : {}),
    commitMessage: formatCommitMessage(subject, ""),
  };
}

function sanitizeProgressText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= MAX_PROGRESS_TEXT_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_PROGRESS_TEXT_LENGTH).trimEnd();
}

interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

interface FeatureBranchStepOptions {
  allowCommittedHead?: boolean;
  restoreOriginalBranchRef?: string | null;
}

function isCommitAction(
  action: GitStackedAction,
): action is "commit" | "commit_push" | "commit_push_pr" {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function buildFailedLocalHandoffRecoveryDetail(
  baseMessage: string,
  recovery: FailedLocalHandoffRecovery,
): string {
  return `${baseMessage} ${[
    recovery.worktreeRecreated
      ? "The original worktree was recreated."
      : "The original worktree could not be recreated automatically.",
    recovery.worktreeChangesRestored
      ? "Recovered worktree changes were reapplied."
      : "Recovered worktree changes remain in the Git stash.",
    recovery.localChangesRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

function buildFailedLocalTransferDetail(
  baseMessage: string,
  recovery: FailedLocalTransferRecovery,
): string {
  return `${baseMessage} ${[
    recovery.worktreeRecreated
      ? "The original worktree was recreated."
      : "The original worktree could not be recreated automatically.",
    recovery.worktreeChangesRestored
      ? "The thread changes were restored to that worktree."
      : "The thread changes remain in the Git stash.",
    recovery.localCheckoutRestored
      ? "Local checkout was restored."
      : "Local checkout could not be fully restored automatically.",
    recovery.localChangesRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

function buildFailedWorktreeHandoffRecoveryDetail(
  baseMessage: string,
  recovery: FailedWorktreeHandoffRecovery,
): string {
  return `${baseMessage} ${[
    recovery.checkoutRestored
      ? "Local checkout was restored."
      : "Local checkout could not be fully restored automatically.",
    recovery.stashRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

function buildFailedWorktreeTransferDetail(
  baseMessage: string,
  recovery: FailedWorktreeTransferRecovery,
): string {
  return `${baseMessage} ${[
    recovery.worktreeRemoved
      ? "The new worktree was removed."
      : "The new worktree could not be removed automatically.",
    recovery.checkoutRestored
      ? "Local checkout was restored."
      : "Local checkout could not be fully restored automatically.",
    recovery.stashRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash. Run `git stash list` in Local to recover them.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function extractBranchFromRef(ref: string): string {
  const normalized = ref.trim();

  if (normalized.startsWith("refs/remotes/")) {
    const withoutPrefix = normalized.slice("refs/remotes/".length);
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      return withoutPrefix.trim();
    }
    return withoutPrefix.slice(firstSlash + 1).trim();
  }

  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) {
    return normalized;
  }
  return normalized.slice(firstSlash + 1).trim();
}

function prioritizeRemoteNames(remoteNames: readonly string[]): string[] {
  const normalized = remoteNames
    .map((remoteName) => remoteName.trim())
    .filter((remoteName) => remoteName.length > 0);
  if (!normalized.includes("origin")) {
    return normalized;
  }
  return ["origin", ...normalized.filter((remoteName) => remoteName !== "origin")];
}

function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function combineGitMessages(stdout: string, stderr: string): string | null {
  const parts = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n").trim();
}

function toResolvedPullRequest(pr: {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  state?: "open" | "closed" | "merged";
  isDraft?: boolean;
  mergeability?: "mergeable" | "conflicting" | "unknown";
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
}): ResolvedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state ?? "open",
    isDraft: pr.isDraft ?? false,
    mergeability: pr.mergeability ?? "unknown",
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changedFiles ?? null,
  };
}

function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}): PullRequestHeadRemoteInfo {
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  };
}

// Older gh versions omit the head-repository fields from `pr list` JSON; fall back to what
// the head selector implies so cross-repo matching still works. Shared by the open-PR and
// any-state PR lookups.
function withInferredHeadRemoteInfo(
  pr: PullRequestInfo,
  inferred: PullRequestHeadRemoteInfo,
): PullRequestInfo {
  const reportedByGh =
    pr.isCrossRepository !== undefined ||
    pr.headRepositoryNameWithOwner !== undefined ||
    pr.headRepositoryOwnerLogin !== undefined;
  return reportedByGh ? pr : { ...pr, ...toPullRequestHeadRemoteInfo(inferred) };
}

function inferPullRequestHeadRemoteInfoFromSelector(
  headSelector: string,
  headContext: Pick<
    BranchHeadContext,
    | "headBranch"
    | "remoteName"
    | "headRepositoryNameWithOwner"
    | "headRepositoryOwnerLogin"
    | "isCrossRepository"
  >,
): PullRequestHeadRemoteInfo {
  const separatorIndex = headSelector.indexOf(":");
  if (separatorIndex > 0 && separatorIndex < headSelector.length - 1) {
    const selectorPrefix = headSelector.slice(0, separatorIndex);
    if (selectorPrefix === headContext.remoteName) {
      return {
        isCrossRepository: headContext.isCrossRepository,
        ...(headContext.headRepositoryNameWithOwner
          ? { headRepositoryNameWithOwner: headContext.headRepositoryNameWithOwner }
          : {}),
        ...(headContext.headRepositoryOwnerLogin
          ? { headRepositoryOwnerLogin: headContext.headRepositoryOwnerLogin }
          : {}),
      };
    }

    return {
      isCrossRepository: true,
      headRepositoryOwnerLogin: selectorPrefix,
    };
  }

  if (headContext.isCrossRepository && headSelector === headContext.headBranch) {
    return {
      isCrossRepository: true,
      ...(headContext.headRepositoryNameWithOwner
        ? { headRepositoryNameWithOwner: headContext.headRepositoryNameWithOwner }
        : {}),
      ...(headContext.headRepositoryOwnerLogin
        ? { headRepositoryOwnerLogin: headContext.headRepositoryOwnerLogin }
        : {}),
    };
  }

  return {};
}

export const makeGitManager = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;

  const createProgressEmitter = (
    input: { cwd: string; action: GitStackedAction },
    options?: GitRunStackedActionOptions,
  ) => {
    const actionId = options?.actionId ?? randomUUID();
    const reporter = options?.progressReporter;

    const emit = (event: GitActionProgressPayload) =>
      reporter
        ? reporter.publish({
            actionId,
            cwd: input.cwd,
            action: input.action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    return {
      actionId,
      emit,
    };
  };

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        });
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch(() =>
        gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        }),
      ),
    );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const gitRefExists = (cwd: string, ref: string) =>
    gitCore
      .execute({
        operation: "GitManager.gitRefExists",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
        allowNonZeroExit: true,
        maxOutputBytes: 256,
      })
      .pipe(
        Effect.map((result) => result.code === 0),
        Effect.catch(() => Effect.succeed(false)),
      );

  const resolveRemoteRepositoryContext = (cwd: string, remoteName: string | null) =>
    Effect.gen(function* () {
      if (!remoteName) {
        return {
          repositoryNameWithOwner: null,
          ownerLogin: null,
        };
      }

      const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
      const repositoryNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      return {
        repositoryNameWithOwner,
        ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
      };
    });

  const resolveBranchHeadContext = (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) =>
    Effect.gen(function* () {
      const remoteName = yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`);
      const headBranchFromUpstream = details.upstreamRef
        ? extractBranchFromRef(details.upstreamRef)
        : "";
      const headBranch =
        headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;

      const [remoteRepository, originRepository] = yield* Effect.all(
        [
          resolveRemoteRepositoryContext(cwd, remoteName),
          resolveRemoteRepositoryContext(cwd, "origin"),
        ],
        { concurrency: "unbounded" },
      );

      const isCrossRepository =
        remoteRepository.repositoryNameWithOwner !== null &&
        originRepository.repositoryNameWithOwner !== null
          ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
            originRepository.repositoryNameWithOwner.toLowerCase()
          : remoteName !== null &&
            remoteName !== "origin" &&
            remoteRepository.repositoryNameWithOwner !== null;

      const ownerHeadSelector =
        remoteRepository.ownerLogin && headBranch.length > 0
          ? `${remoteRepository.ownerLogin}:${headBranch}`
          : null;
      const remoteAliasHeadSelector =
        remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
      const shouldProbeRemoteOwnedSelectors = remoteName !== null;

      const headSelectors: string[] = [];
      if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
        appendUnique(headSelectors, ownerHeadSelector);
        appendUnique(
          headSelectors,
          remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
        );
        appendUnique(headSelectors, headBranch);
      }

      appendUnique(headSelectors, details.branch);
      if (!isCrossRepository) {
        appendUnique(headSelectors, headBranch !== details.branch ? headBranch : null);
      }
      if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
        appendUnique(headSelectors, ownerHeadSelector);
        appendUnique(
          headSelectors,
          remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
        );
      }

      return {
        localBranch: details.branch,
        headBranch,
        headSelectors,
        preferredHeadSelector:
          ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
        remoteName,
        headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
        headRepositoryOwnerLogin: remoteRepository.ownerLogin,
        isCrossRepository,
      } satisfies BranchHeadContext;
    });

  const findOpenPr = (
    cwd: string,
    headContext: Pick<
      BranchHeadContext,
      | "headSelectors"
      | "headBranch"
      | "remoteName"
      | "headRepositoryNameWithOwner"
      | "headRepositoryOwnerLogin"
      | "isCrossRepository"
    >,
  ) =>
    Effect.gen(function* () {
      for (const headSelector of headContext.headSelectors) {
        const pullRequests = yield* gitHubCli.listOpenPullRequests({
          cwd,
          headSelector,
          limit: OPEN_PR_LOOKUP_LIMIT,
        });
        const inferredHeadInfo = inferPullRequestHeadRemoteInfoFromSelector(
          headSelector,
          headContext,
        );

        for (const pullRequest of pullRequests) {
          const candidate = withInferredHeadRemoteInfo(
            toPullRequestInfo(pullRequest),
            inferredHeadInfo,
          );
          if (!matchesBranchHeadContext(candidate, headContext)) {
            continue;
          }

          return candidate;
        }
      }

      return null;
    });

  const findLatestPr = (cwd: string, details: { branch: string; upstreamRef: string | null }) =>
    Effect.gen(function* () {
      const headContext = yield* resolveBranchHeadContext(cwd, details);
      const parsedByNumber = new Map<number, PullRequestInfo>();

      for (const headSelector of headContext.headSelectors) {
        const inferredHeadInfo = inferPullRequestHeadRemoteInfoFromSelector(
          headSelector,
          headContext,
        );
        const pullRequests = yield* gitHubCli.listPullRequests({
          cwd,
          headSelector,
          limit: PR_LOOKUP_ALL_STATES_LIMIT,
        });

        for (const pullRequest of pullRequests) {
          const candidate = withInferredHeadRemoteInfo(
            toPullRequestInfo(pullRequest),
            inferredHeadInfo,
          );
          if (!matchesBranchHeadContext(candidate, headContext)) {
            continue;
          }
          parsedByNumber.set(candidate.number, candidate);
        }
      }

      const parsed = Array.from(parsedByNumber.values()).toSorted((a, b) => {
        const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return right - left;
      });

      const latestOpenPr = parsed.find((pr) => pr.state === "open");
      if (latestOpenPr) {
        return latestOpenPr;
      }
      return parsed[0] ?? null;
    });

  const resolveAlreadyExistingPullRequest = (
    cwd: string,
    error: unknown,
    headContext: BranchHeadContext,
  ) =>
    Effect.gen(function* () {
      const pullRequestUrl = extractPullRequestUrlFromError(error);
      if (pullRequestUrl) {
        const pullRequest = yield* gitHubCli
          .getPullRequest({ cwd, reference: pullRequestUrl })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (pullRequest) {
          const candidate = toPullRequestInfo(pullRequest);
          if (candidate.state === "open" && matchesBranchHeadContext(candidate, headContext)) {
            return candidate;
          }
        }
      }

      // `gh pr create` can race with an existing-PR probe. Treat GitHub's
      // create-time duplicate response as success when the PR can be found.
      return yield* findOpenPr(cwd, headContext);
    });

  const resolveBaseBranch = (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository">,
  ) =>
    Effect.gen(function* () {
      const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
      if (configured) return configured;

      if (upstreamRef && !headContext.isCrossRepository) {
        const upstreamBranch = extractBranchFromRef(upstreamRef);
        if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
          return upstreamBranch;
        }
      }

      const defaultFromGh = yield* gitHubCli
        .getDefaultBranch({ cwd })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (defaultFromGh) {
        return defaultFromGh;
      }

      return "main";
    });

  const resolveCommitAndBranchSuggestion = (
    input: {
      cwd: string;
      branch: string | null;
      commitMessage?: string;
      /** When true, also produce a semantic feature branch name. */
      includeBranch?: boolean;
      filePaths?: readonly string[];
    } & GitTextGenerationParams,
  ) =>
    Effect.gen(function* () {
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths);
      if (!context) {
        return null;
      }

      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...buildGitTextGenerationCallInput(input),
        })
        .pipe(
          Effect.map((result) => sanitizeCommitMessage(result)),
          Effect.catchTag("TextGenerationError", (error) =>
            Effect.logWarning(
              `GitManager.resolveCommitAndBranchSuggestion: falling back to heuristic commit message in ${input.cwd}: ${error.message}`,
            ).pipe(
              Effect.as(
                createFallbackCommitSuggestion({
                  stagedSummary: context.stagedSummary,
                  ...(input.includeBranch ? { includeBranch: true } : {}),
                }),
              ),
            ),
          ),
        );

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    });

  const runCommitStep = (
    cwd: string,
    action: "commit" | "commit_push" | "commit_push_pr",
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    textGenerationParams?: GitTextGenerationParams,
    progressReporter?: GitActionProgressReporter,
    actionId?: string,
  ) =>
    Effect.gen(function* () {
      const emit = (event: GitActionProgressPayload) =>
        progressReporter && actionId
          ? progressReporter.publish({
              actionId,
              cwd,
              action,
              ...event,
            } as GitActionProgressEvent)
          : Effect.void;

      let suggestion: CommitAndBranchSuggestion | null | undefined = preResolvedSuggestion;
      if (!suggestion) {
        const needsGeneration = !commitMessage?.trim();
        if (needsGeneration) {
          yield* emit({
            kind: "phase_started",
            phase: "commit",
            label: "Generating commit message...",
          });
        }
        suggestion = yield* resolveCommitAndBranchSuggestion({
          cwd,
          branch,
          ...(commitMessage ? { commitMessage } : {}),
          ...(filePaths ? { filePaths } : {}),
          ...(textGenerationParams ?? {}),
        });
      }
      if (!suggestion) {
        return { status: "skipped_no_changes" as const };
      }

      yield* emit({
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
      });

      let currentHookName: string | null = null;
      const commitProgress =
        progressReporter && actionId
          ? {
              onOutputLine: ({ stream, text }: { stream: "stdout" | "stderr"; text: string }) => {
                const sanitized = sanitizeProgressText(text);
                if (!sanitized) {
                  return Effect.void;
                }
                return emit({
                  kind: "hook_output",
                  hookName: currentHookName,
                  stream,
                  text: sanitized,
                });
              },
              onHookStarted: (hookName: string) => {
                currentHookName = hookName;
                return emit({
                  kind: "hook_started",
                  hookName,
                });
              },
              onHookFinished: ({
                hookName,
                exitCode,
                durationMs,
              }: {
                hookName: string;
                exitCode: number | null;
                durationMs: number | null;
              }) => {
                if (currentHookName === hookName) {
                  currentHookName = null;
                }
                return emit({
                  kind: "hook_finished",
                  hookName,
                  exitCode,
                  durationMs,
                });
              },
            }
          : null;
      const { commitSha } = yield* gitCore.commit(cwd, suggestion.subject, suggestion.body, {
        timeoutMs: COMMIT_TIMEOUT_MS,
        ...(commitProgress ? { progress: commitProgress } : {}),
      });
      if (currentHookName !== null) {
        yield* emit({
          kind: "hook_finished",
          hookName: currentHookName,
          exitCode: 0,
          durationMs: null,
        });
        currentHookName = null;
      }
      return {
        status: "created" as const,
        commitSha,
        subject: suggestion.subject,
      };
    });

  const runPrStep = (
    cwd: string,
    fallbackBranch: string | null,
    textGenerationParams?: GitTextGenerationParams,
    prOptions?: {
      readonly title?: string | undefined;
      readonly body?: string | undefined;
      readonly draft?: boolean | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const details = yield* gitCore.statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* gitManagerError(
          "runPrStep",
          "Cannot create a pull request from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* gitManagerError(
          "runPrStep",
          "Current branch has not been pushed. Push before creating a PR.",
        );
      }

      const headContext = yield* resolveBranchHeadContext(cwd, {
        branch,
        upstreamRef: details.upstreamRef,
      });

      const existing = yield* findOpenPr(cwd, headContext);
      if (existing) {
        return {
          status: "opened_existing" as const,
          url: existing.url,
          number: existing.number,
          baseBranch: existing.baseRefName,
          headBranch: existing.headRefName,
          title: existing.title,
        };
      }

      const baseBranch = yield* resolveBaseBranch(cwd, branch, details.upstreamRef, headContext);
      if (!headContext.isCrossRepository && baseBranch === headContext.headBranch) {
        return yield* gitManagerError(
          "runPrStep",
          `Cannot create a pull request from '${headContext.headBranch}' into itself. Create or switch to a feature branch and retry.`,
        );
      }
      let prTitle = prOptions?.title;
      let prBody = prOptions?.body;
      if (prTitle === undefined || prBody === undefined) {
        const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);
        const originRemoteUrl = headContext.isCrossRepository
          ? yield* readConfigValueNullable(cwd, "remote.origin.url")
          : null;
        const targetRemoteName = headContext.isCrossRepository
          ? originRemoteUrl
            ? "origin"
            : null
          : headContext.remoteName;
        const remoteBaseRef = targetRemoteName
          ? `refs/remotes/${targetRemoteName}/${baseBranch}`
          : null;
        const useRemoteBaseRef =
          remoteBaseRef !== null && (yield* gitRefExists(cwd, remoteBaseRef));
        const prTemplateTreeish = useRemoteBaseRef ? remoteBaseRef : baseBranch;
        const prTemplate = Option.getOrUndefined(
          yield* detectPrTemplate(cwd, prTemplateTreeish, gitCore.execute),
        );

        const generated = yield* textGeneration.generatePrContent({
          cwd,
          baseBranch,
          headBranch: headContext.headBranch,
          commitSummary: limitContext(rangeContext.commitSummary, 20_000),
          diffSummary: limitContext(rangeContext.diffSummary, 20_000),
          diffPatch: limitContext(rangeContext.diffPatch, 60_000),
          ...(prTemplate !== undefined ? { prTemplate } : {}),
          ...buildGitTextGenerationCallInput(textGenerationParams ?? {}),
        });
        prTitle ??= generated.title;
        prBody ??= generated.body;
      }

      const bodyFile = path.join(tempDir, `synara-pr-body-${process.pid}-${randomUUID()}.md`);
      yield* fileSystem
        .writeFileString(bodyFile, prBody)
        .pipe(
          Effect.mapError((cause) =>
            gitManagerError("runPrStep", "Failed to write pull request body temp file.", cause),
          ),
        );
      const existingAfterCreateConflict = yield* gitHubCli
        .createPullRequest({
          cwd,
          baseBranch,
          headSelector: headContext.preferredHeadSelector,
          title: prTitle,
          bodyFile,
          ...(prOptions?.draft !== undefined ? { draft: prOptions.draft } : {}),
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => {
            if (!isPullRequestAlreadyExistsError(error)) {
              return Effect.fail(error);
            }
            return resolveAlreadyExistingPullRequest(cwd, error, headContext);
          }),
          Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))),
        );
      if (existingAfterCreateConflict) {
        return {
          status: "opened_existing" as const,
          url: existingAfterCreateConflict.url,
          number: existingAfterCreateConflict.number,
          baseBranch: existingAfterCreateConflict.baseRefName,
          headBranch: existingAfterCreateConflict.headRefName,
          title: existingAfterCreateConflict.title,
        };
      }

      const created = yield* findOpenPr(cwd, headContext);
      if (!created) {
        return {
          status: "created" as const,
          baseBranch,
          headBranch: headContext.headBranch,
          title: prTitle,
        };
      }

      return {
        status: "created" as const,
        url: created.url,
        number: created.number,
        baseBranch: created.baseRefName,
        headBranch: created.headRefName,
        title: created.title,
      };
    });

  const pullRequestForBranch: GitManagerShape["pullRequestForBranch"] = Effect.fnUntraced(
    function* (input) {
      const latest = yield* findLatestPr(input.cwd, {
        branch: input.branch,
        upstreamRef: input.upstreamRef,
      });
      return latest ? toResolvedPullRequest(latest) : null;
    },
  );

  const status: GitManagerShape["status"] = Effect.fnUntraced(function* (input) {
    const details = yield* gitCore.statusDetails(input.cwd);

    const pr =
      details.branch !== null
        ? yield* pullRequestForBranch({
            cwd: input.cwd,
            branch: details.branch,
            upstreamRef: details.upstreamRef,
          }).pipe(Effect.catch(() => Effect.succeed(null)))
        : null;

    return {
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      upstreamBranch: details.upstreamBranch,
      configuredPrBaseBranch: details.configuredPrBaseBranch,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
    };
  });

  const readWorkingTreeDiff: GitManagerShape["readWorkingTreeDiff"] = Effect.fnUntraced(
    function* (input) {
      switch (input.scope) {
        case "branch":
          return yield* gitCore.readBranchPatch(input.cwd);
        case "staged":
          return yield* gitCore.readStagedPatch(input.cwd);
        case "unstaged":
          return yield* gitCore.readUnstagedPatch(input.cwd);
        case "workingTree":
        default:
          return yield* gitCore.readWorkingTreePatch(input.cwd);
      }
    },
  );
  const readWorkingTreeDiffStats: GitManagerShape["readWorkingTreeDiffStats"] = Effect.fnUntraced(
    function* (input) {
      return yield* gitCore.readDiffStats(input.cwd, input.scope ?? "workingTree");
    },
  );

  // Resolve the patch server-side so large repository data never makes a client→RPC round trip.
  const summarizeDiff: GitManagerShape["summarizeDiff"] = Effect.fnUntraced(function* (input) {
    const { patch } = yield* readWorkingTreeDiff({ cwd: input.cwd, scope: input.scope });
    if (patch.length === 0) {
      return yield* gitManagerError("summarizeDiff", "Cannot summarize an empty diff.");
    }

    const generated = yield* textGeneration.generateDiffSummary({
      cwd: input.cwd,
      patch,
      ...buildGitTextGenerationCallInput({
        textGenerationModel: input.textGenerationModel,
        textGenerationModelSelection: input.textGenerationModelSelection,
        codexHomePath: input.codexHomePath,
        providerOptions: input.providerOptions,
      }),
    });

    return {
      summary: generated.summary,
    };
  });

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fnUntraced(
    function* (input) {
      const pullRequest = yield* gitHubCli
        .getPullRequest({
          cwd: input.cwd,
          reference: normalizePullRequestReference(input.reference),
        })
        .pipe(Effect.map((resolved) => toResolvedPullRequest(resolved)));

      return { pullRequest };
    },
  );

  const pullRequestSnapshot: GitManagerShape["pullRequestSnapshot"] = Effect.fnUntraced(
    function* (input) {
      const reference = normalizePullRequestReference(input.reference);
      // Summary + checks ride one `gh pr view` call: one process/API round trip per poll,
      // and no separate checks failure mode that could discard an otherwise-usable snapshot.
      const { summary, checks } = yield* gitHubCli.getPullRequestWithChecks({
        cwd: input.cwd,
        reference,
      });
      const pullRequest = toResolvedPullRequest(summary);

      const repository = parsePullRequestRepositoryFromUrl(pullRequest.url);
      if (!repository) {
        return yield* gitManagerError(
          "pullRequestSnapshot",
          `Could not determine the repository from the pull request URL: ${pullRequest.url}`,
        );
      }

      const commentsResult = yield* gitHubCli
        .getPullRequestReviewComments({
          cwd: input.cwd,
          host: repository.host,
          owner: repository.owner,
          repo: repository.repo,
          number: pullRequest.number,
        })
        .pipe(
          Effect.map((result) => ({
            comments: result.comments,
            commentsTruncated: result.truncated,
            commentsError: null,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              comments: [],
              commentsTruncated: false,
              commentsError: error.message,
            }),
          ),
        );

      return {
        pullRequest,
        checks,
        comments: commentsResult.comments,
        commentsTruncated: commentsResult.commentsTruncated,
        commentsError: commentsResult.commentsError,
      };
    },
  );

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fnUntraced(
    function* (input) {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = canonicalizeExistingPath(input.cwd);
      const pullRequestSummary = yield* gitHubCli.getPullRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* gitHubCli.checkoutPullRequest({
          cwd: input.cwd,
          reference: normalizedReference,
          force: true,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
        return {
          pullRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
        };
      }

      const ensureExistingWorktreeUpstream = (worktreePath: string) =>
        Effect.gen(function* () {
          const details = yield* gitCore.statusDetails(worktreePath);
          yield* configurePullRequestHeadUpstream(
            worktreePath,
            {
              ...pullRequest,
              ...toPullRequestHeadRemoteInfo(pullRequestSummary),
            },
            details.branch ?? pullRequest.headBranch,
          );
        });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      const findLocalHeadBranch = (cwd: string) =>
        gitCore.listBranches({ cwd }).pipe(
          Effect.map((result) => {
            const localBranch = result.branches.find(
              (branch) => !branch.isRemote && branch.name === localPullRequestBranch,
            );
            if (localBranch) {
              return localBranch;
            }
            if (localPullRequestBranch === pullRequest.headBranch) {
              return null;
            }
            return (
              result.branches.find(
                (branch) =>
                  !branch.isRemote &&
                  branch.name === pullRequest.headBranch &&
                  branch.worktreePath !== null &&
                  canonicalizeExistingPath(branch.worktreePath) !== rootWorktreePath,
              ) ?? null
            );
          }),
        );

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchBeforeFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchBeforeFetch.worktreePath,
        };
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchAfterFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchAfterFetch.worktreePath,
        };
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      const worktree = yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: localPullRequestBranch,
        path: null,
      });
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    },
  );

  const readStashRef = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.handoffThread.readStashRef",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "refs/stash"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) return null;
          const trimmed = result.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      );

  const readHeadRef = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.handoffThread.readHeadRef",
        cwd,
        args: ["rev-parse", "HEAD"],
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => {
          const trimmed = result.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      );

  const checkoutDetached = (cwd: string, ref: string) =>
    gitCore
      .execute({
        operation: "GitManager.handoffThread.checkoutDetached",
        cwd,
        args: ["checkout", "--detach", ref],
        timeoutMs: 30_000,
      })
      .pipe(Effect.asVoid);

  const buildNamedWorktreePath = (cwd: string, name: string) => {
    const repoName = path.basename(cwd);
    const sanitizedName = name.trim().replaceAll("/", "-");
    return path.join(worktreesDir, repoName, sanitizedName);
  };

  const createDetachedWorktree = (input: {
    cwd: string;
    ref: string;
    path: string | null;
    name?: string | null;
  }) =>
    Effect.gen(function* () {
      const resolvedPath =
        input.path ?? (input.name ? buildNamedWorktreePath(input.cwd, input.name) : null);
      const worktree = yield* gitCore.createDetachedWorktree({
        cwd: input.cwd,
        ref: input.ref,
        path: resolvedPath,
      });
      return worktree;
    });

  const createNamedWorktree = (input: {
    cwd: string;
    baseBranch: string;
    name: string;
    path: string | null;
  }) =>
    Effect.gen(function* () {
      const resolvedPath = input.path ?? buildNamedWorktreePath(input.cwd, input.name);
      return yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: input.baseBranch,
        newBranch: input.name,
        path: resolvedPath,
      });
    });

  const stashWorkingTree = (cwd: string, label: string) =>
    Effect.gen(function* () {
      if (!(yield* gitCore.statusDetails(cwd)).hasWorkingTreeChanges) {
        return {
          hadChanges: false,
          stashRef: null,
        };
      }
      const beforeRef = yield* readStashRef(cwd);
      yield* gitCore.execute({
        operation: "GitManager.handoffThread.stashPush",
        cwd,
        args: ["stash", "push", "--include-untracked", "-m", label],
        timeoutMs: 30_000,
      });
      const afterRef = yield* readStashRef(cwd);
      if (afterRef === beforeRef) {
        return yield* gitManagerError(
          "handoffThread",
          "Git did not create a stash entry while preparing the thread handoff.",
        );
      }
      return {
        hadChanges: true,
        stashRef: afterRef,
      };
    });

  const dropStashBySha = (cwd: string, stashSha: string) =>
    Effect.gen(function* () {
      const listResult = yield* gitCore.execute({
        operation: "GitManager.handoffThread.listStashShas",
        cwd,
        args: ["stash", "list", "--format=%H"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (listResult.code !== 0) return;
      const index = listResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .indexOf(stashSha);
      if (index < 0) return;
      yield* gitCore.execute({
        operation: "GitManager.handoffThread.stashDrop",
        cwd,
        args: ["stash", "drop", `stash@{${index}}`],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
    });

  const popStash = (cwd: string, stashRef: string | null) =>
    Effect.gen(function* () {
      if (!stashRef) {
        return {
          conflictsDetected: false,
          message: null,
        };
      }
      // `git stash pop` requires a `stash@{N}` reference, but `stashRef` here is the
      // commit SHA captured via `git rev-parse refs/stash` in `readStashRef`. Apply
      // the stash by SHA (which `git stash apply` accepts for any stash-shaped
      // commit) and then drop the matching list entry on success so callers still
      // observe pop-style semantics.
      const result = yield* gitCore
        .execute({
          operation: "GitManager.handoffThread.stashApply",
          cwd,
          args: ["stash", "apply", "--index", stashRef],
          allowNonZeroExit: true,
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              code: 1,
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      if (result.code === 0) {
        yield* dropStashBySha(cwd, stashRef).pipe(Effect.catch(() => Effect.void));
        return {
          conflictsDetected: false,
          message: null,
        };
      }
      return {
        conflictsDetected: true,
        message:
          combineGitMessages(result.stdout, result.stderr) ??
          "Git reported conflicts while applying the handed off changes.",
      };
    });

  const restoreSourceStash = (cwd: string, stashRef: string | null) =>
    popStash(cwd, stashRef).pipe(Effect.asVoid);

  const restoreStashes = (restores: ReadonlyArray<{ cwd: string; stashRef: string | null }>) =>
    Effect.forEach(restores, (entry) => restoreSourceStash(entry.cwd, entry.stashRef), {
      concurrency: 1,
      discard: true,
    });

  const resolveForegroundFallbackBranch = (cwd: string, excludedBranch: string) =>
    gitCore.listBranches({ cwd }).pipe(
      Effect.map((result) => {
        const localBranches = result.branches.filter(
          (branch) =>
            !branch.isRemote && branch.name !== excludedBranch && branch.worktreePath === null,
        );
        const defaultBranch = localBranches.find((branch) => branch.isDefault)?.name ?? null;
        if (defaultBranch) return defaultBranch;
        return localBranches[0]?.name ?? null;
      }),
    );

  const restoreLocalHandoffSource = (input: {
    cwd: string;
    originalBranch: string | null;
    originalHeadRef: string | null;
    currentBranch: string | null;
    stashRef: string | null;
  }) =>
    Effect.gen(function* () {
      let checkoutRestored = input.originalBranch === input.currentBranch;
      const recoveryNotes: string[] = [];

      if (
        input.originalBranch &&
        input.currentBranch &&
        input.originalBranch !== input.currentBranch
      ) {
        checkoutRestored = yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: input.originalBranch,
          }),
        ).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            recoveryNotes.push(
              `Local could not be returned to '${input.originalBranch}': ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return Effect.succeed(false);
          }),
        );
      } else if (!input.originalBranch && input.originalHeadRef) {
        checkoutRestored = yield* checkoutDetached(input.cwd, input.originalHeadRef).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            recoveryNotes.push(
              `Local could not be returned to its previous detached HEAD: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return Effect.succeed(false);
          }),
        );
      }

      const stashRestore = yield* popStash(input.cwd, input.stashRef);
      const stashRestored = !stashRestore.conflictsDetected;
      if (stashRestore.conflictsDetected) {
        recoveryNotes.push(
          `${stashRestore.message ?? "Git reported conflicts while restoring the original Local changes."}
The local stash entry was kept for recovery.`,
        );
      }

      return {
        checkoutRestored,
        stashRestored,
        recoveryNotes,
      };
    });

  const restoreRemovedWorktreeAfterFailedLocalCheckout = (input: {
    cwd: string;
    worktreePath: string | null;
    branch: string | null;
    ref: string | null;
    worktreeStashRef: string | null;
    localStashRef: string | null;
  }) =>
    Effect.gen(function* () {
      const recoveryNotes: string[] = [];
      let worktreeRecreated = false;
      let worktreeChangesRestored = input.worktreeStashRef === null;
      let localChangesRestored = input.localStashRef === null;

      if (input.worktreePath) {
        const recreated =
          input.branch !== null
            ? yield* gitCore
                .createWorktree({
                  cwd: input.cwd,
                  branch: input.branch,
                  path: input.worktreePath,
                })
                .pipe(Effect.catch(() => Effect.succeed(null)))
            : input.ref
              ? yield* createDetachedWorktree({
                  cwd: input.cwd,
                  ref: input.ref,
                  path: input.worktreePath,
                }).pipe(Effect.catch(() => Effect.succeed(null)))
              : null;

        if (recreated?.worktree.path) {
          worktreeRecreated = true;
          const worktreeRestore = yield* popStash(recreated.worktree.path, input.worktreeStashRef);
          worktreeChangesRestored = !worktreeRestore.conflictsDetected;
          if (worktreeRestore.conflictsDetected) {
            recoveryNotes.push(
              `${worktreeRestore.message ?? "Git reported conflicts while restoring the recovered worktree changes."}
The worktree stash entry was kept for recovery.`,
            );
          }
        } else if (input.worktreeStashRef) {
          recoveryNotes.push(
            "The thread worktree could not be recreated automatically. Its uncommitted changes were kept in the Git stash for manual recovery.",
          );
        }
      }

      const localRestore = yield* popStash(input.cwd, input.localStashRef);
      localChangesRestored = !localRestore.conflictsDetected;
      if (localRestore.conflictsDetected) {
        recoveryNotes.push(
          `${localRestore.message ?? "Git reported conflicts while restoring your previous local changes."}
The local stash entry was kept for recovery.`,
        );
      }

      return {
        worktreeRecreated,
        worktreeChangesRestored,
        localChangesRestored,
        recoveryNotes,
      };
    });

  const rollbackFailedLocalTransfer = (input: {
    cwd: string;
    originalBranch: string | null;
    originalHeadRef: string | null;
    currentBranch: string | null;
    worktreePath: string | null;
    worktreeBranch: string | null;
    worktreeRef: string | null;
    worktreeStashRef: string | null;
    localStashRef: string | null;
  }) =>
    Effect.gen(function* () {
      const worktreeRecovery = yield* restoreRemovedWorktreeAfterFailedLocalCheckout({
        cwd: input.cwd,
        worktreePath: input.worktreePath,
        branch: input.worktreeBranch,
        ref: input.worktreeRef,
        worktreeStashRef: input.worktreeStashRef,
        localStashRef: null,
      });

      const localRecovery = yield* restoreLocalHandoffSource({
        cwd: input.cwd,
        originalBranch: input.originalBranch,
        originalHeadRef: input.originalHeadRef,
        currentBranch: input.currentBranch,
        stashRef: input.localStashRef,
      });

      return {
        worktreeRecreated: worktreeRecovery.worktreeRecreated,
        worktreeChangesRestored: worktreeRecovery.worktreeChangesRestored,
        localCheckoutRestored: localRecovery.checkoutRestored,
        localChangesRestored: localRecovery.stashRestored,
        recoveryNotes: [...worktreeRecovery.recoveryNotes, ...localRecovery.recoveryNotes],
      };
    });

  const rollbackFailedWorktreeTransfer = (input: {
    cwd: string;
    worktreePath: string;
    originalBranch: string | null;
    originalHeadRef: string | null;
    currentBranch: string | null;
    stashRef: string | null;
  }) =>
    Effect.gen(function* () {
      const recoveryNotes: string[] = [];
      const worktreeRemoved = yield* gitCore
        .removeWorktree({
          cwd: input.cwd,
          path: input.worktreePath,
          force: true,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) => {
            recoveryNotes.push(
              `The newly created worktree could not be removed automatically: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return Effect.succeed(false);
          }),
        );

      const localRecovery = yield* restoreLocalHandoffSource({
        cwd: input.cwd,
        originalBranch: input.originalBranch,
        originalHeadRef: input.originalHeadRef,
        currentBranch: input.currentBranch,
        stashRef: input.stashRef,
      });

      return {
        worktreeRemoved,
        checkoutRestored: localRecovery.checkoutRestored,
        stashRestored: localRecovery.stashRestored,
        recoveryNotes: [...recoveryNotes, ...localRecovery.recoveryNotes],
      };
    });

  const handoffThread: GitManagerShape["handoffThread"] = Effect.fnUntraced(function* (input) {
    const currentLocalStatus = yield* gitCore.statusDetails(input.cwd);

    if (input.targetMode === "local") {
      if (!input.worktreePath) {
        return yield* gitManagerError(
          "handoffThread",
          "Cannot hand off to Local because this thread does not have a materialized worktree.",
        );
      }

      const worktreeHeadRef = yield* readHeadRef(input.worktreePath);
      const targetLocalBranch =
        input.currentBranch ?? input.associatedWorktreeBranch ?? input.preferredLocalBranch ?? null;
      if (!(targetLocalBranch ?? worktreeHeadRef)) {
        return yield* gitManagerError(
          "handoffThread",
          "Cannot hand off to Local because the worktree thread does not have a recoverable HEAD reference.",
        );
      }

      const associatedWorktreePath = input.associatedWorktreePath ?? input.worktreePath;
      const associatedWorktreeBranch =
        input.associatedWorktreeBranch ?? input.currentBranch ?? null;
      const associatedWorktreeRef =
        input.associatedWorktreeRef ?? worktreeHeadRef ?? associatedWorktreeBranch;
      const originalLocalBranch = currentLocalStatus.branch ?? null;
      const originalLocalHeadRef = yield* readHeadRef(input.cwd);
      let currentLocalBranchAfterPreparation = originalLocalBranch;

      const preservedLocalStash = yield* stashWorkingTree(
        input.cwd,
        `synara preserve local handoff ${randomUUID()}`,
      );
      const sourceStash = yield* stashWorkingTree(
        input.worktreePath,
        `synara handoff to local ${randomUUID()}`,
      );

      yield* gitCore
        .removeWorktree({
          cwd: input.cwd,
          path: input.worktreePath,
        })
        .pipe(
          Effect.catch((error) =>
            restoreStashes([
              { cwd: input.worktreePath!, stashRef: sourceStash.stashRef },
              { cwd: input.cwd, stashRef: preservedLocalStash.stashRef },
            ]).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

      if (targetLocalBranch && currentLocalStatus.branch !== targetLocalBranch) {
        yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: targetLocalBranch,
          }),
        ).pipe(
          Effect.catch((error) =>
            restoreRemovedWorktreeAfterFailedLocalCheckout({
              cwd: input.cwd,
              worktreePath: associatedWorktreePath,
              branch: associatedWorktreeBranch,
              ref: associatedWorktreeRef,
              worktreeStashRef: sourceStash.stashRef,
              localStashRef: preservedLocalStash.stashRef,
            }).pipe(
              Effect.flatMap((recovery) =>
                Effect.fail(
                  new GitManagerError({
                    operation: "GitManager.handoffThread",
                    detail: buildFailedLocalHandoffRecoveryDetail(error.message, recovery),
                    cause: error,
                  }),
                ),
              ),
            ),
          ),
        );
        currentLocalBranchAfterPreparation = targetLocalBranch;
      } else if (!targetLocalBranch && worktreeHeadRef) {
        yield* checkoutDetached(input.cwd, worktreeHeadRef).pipe(
          Effect.catch((error) =>
            restoreRemovedWorktreeAfterFailedLocalCheckout({
              cwd: input.cwd,
              worktreePath: associatedWorktreePath,
              branch: associatedWorktreeBranch,
              ref: associatedWorktreeRef,
              worktreeStashRef: sourceStash.stashRef,
              localStashRef: preservedLocalStash.stashRef,
            }).pipe(
              Effect.flatMap((recovery) =>
                Effect.fail(
                  new GitManagerError({
                    operation: "GitManager.handoffThread",
                    detail: buildFailedLocalHandoffRecoveryDetail(error.message, recovery),
                    cause: error,
                  }),
                ),
              ),
            ),
          ),
        );
        currentLocalBranchAfterPreparation = null;
      }

      const threadTransfer = yield* popStash(input.cwd, sourceStash.stashRef);
      if (threadTransfer.conflictsDetected) {
        const recovery = yield* rollbackFailedLocalTransfer({
          cwd: input.cwd,
          originalBranch: originalLocalBranch,
          originalHeadRef: originalLocalHeadRef,
          currentBranch: currentLocalBranchAfterPreparation,
          worktreePath: associatedWorktreePath,
          worktreeBranch: associatedWorktreeBranch,
          worktreeRef: associatedWorktreeRef,
          worktreeStashRef: sourceStash.stashRef,
          localStashRef: preservedLocalStash.stashRef,
        });
        return yield* new GitManagerError({
          operation: "GitManager.handoffThread",
          detail: buildFailedLocalTransferDetail(
            `${
              threadTransfer.message ??
              "Git reported conflicts while applying the handed off changes."
            } The handoff was rolled back so the thread stays in its worktree.`,
            recovery,
          ),
        });
      }

      const localTransfer = yield* popStash(input.cwd, preservedLocalStash.stashRef);
      const changesTransferred = sourceStash.hadChanges || preservedLocalStash.hadChanges;
      const movedThreadChanges = sourceStash.hadChanges;
      const restoredLocalChanges = preservedLocalStash.hadChanges;
      const localTargetLabel = targetLocalBranch
        ? `main local checkout on '${targetLocalBranch}'`
        : "local checkout in detached HEAD";
      const message = localTransfer.conflictsDetected
        ? `${
            localTransfer.message ??
            "Git reported conflicts while restoring your previous local changes."
          }\nYour previous local stash entry was kept for recovery.`
        : movedThreadChanges && restoredLocalChanges
          ? `Moved the thread back to the ${localTargetLabel}, carried its uncommitted work over, and restored your previous local changes.`
          : movedThreadChanges
            ? `Moved the thread back to the ${localTargetLabel} and carried its uncommitted work over.`
            : restoredLocalChanges
              ? `Moved the thread back to the ${localTargetLabel} and restored your previous local changes.`
              : `Moved the thread back to the ${localTargetLabel}.`;

      return {
        targetMode: "local",
        branch: targetLocalBranch,
        worktreePath: null,
        associatedWorktreePath,
        associatedWorktreeBranch,
        associatedWorktreeRef,
        changesTransferred,
        conflictsDetected: localTransfer.conflictsDetected,
        message,
      };
    }

    const worktreeIntent = resolveWorktreeHandoffIntent({
      preferredNewWorktreeName: input.preferredNewWorktreeName,
      associatedWorktreePath: input.associatedWorktreePath,
      associatedWorktreeBranch: input.associatedWorktreeBranch,
      associatedWorktreeRef: input.associatedWorktreeRef,
      preferredWorktreeBaseBranch:
        input.preferredWorktreeBaseBranch ?? currentLocalStatus.branch ?? null,
      currentBranch: input.currentBranch,
    });
    if (!worktreeIntent) {
      return yield* gitManagerError(
        "handoffThread",
        "Cannot hand off to a worktree because no worktree target is available.",
      );
    }
    const targetWorktreeName =
      worktreeIntent.kind === "create-new" ? worktreeIntent.worktreeName : null;
    const targetAssociatedWorktreePath =
      worktreeIntent.kind === "reuse-associated" ? worktreeIntent.associatedWorktreePath : null;
    const targetAssociatedWorktreeBranch =
      worktreeIntent.kind === "reuse-associated" ? worktreeIntent.associatedWorktreeBranch : null;
    const targetAssociatedWorktreeRef =
      worktreeIntent.kind === "reuse-associated" ? worktreeIntent.associatedWorktreeRef : null;
    const targetBaseBranch = worktreeIntent.baseBranch;
    if (!targetBaseBranch && !targetAssociatedWorktreeBranch && !targetAssociatedWorktreeRef) {
      return yield* gitManagerError(
        "handoffThread",
        "Select a base branch before handing off this thread to a worktree.",
      );
    }

    const sourceStash = yield* stashWorkingTree(
      input.cwd,
      `synara handoff to worktree ${randomUUID()}`,
    );
    const sourceBranch = currentLocalStatus.branch ?? input.currentBranch ?? null;
    const sourceHeadRef = yield* readHeadRef(input.cwd);
    let foregroundBranchAfterHandoff = currentLocalStatus.branch;

    if (sourceBranch && sourceBranch === targetAssociatedWorktreeBranch) {
      const fallbackLocalBranch = yield* resolveForegroundFallbackBranch(
        input.cwd,
        targetAssociatedWorktreeBranch,
      );
      if (!fallbackLocalBranch) {
        if (!sourceHeadRef) {
          yield* restoreSourceStash(input.cwd, sourceStash.stashRef);
          return yield* gitManagerError(
            "handoffThread",
            `Cannot hand off '${targetAssociatedWorktreeBranch}' to a worktree because there is no recoverable local HEAD reference available.`,
          );
        }
        yield* checkoutDetached(input.cwd, sourceHeadRef).pipe(
          Effect.catch((error) =>
            restoreSourceStash(input.cwd, sourceStash.stashRef).pipe(
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        foregroundBranchAfterHandoff = null;
      } else {
        yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: fallbackLocalBranch,
          }),
        ).pipe(
          Effect.catch((error) =>
            restoreSourceStash(input.cwd, sourceStash.stashRef).pipe(
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        foregroundBranchAfterHandoff = fallbackLocalBranch;
      }
    }

    const worktree = yield* Effect.gen(function* () {
      if (targetAssociatedWorktreeRef && !targetAssociatedWorktreeBranch) {
        return yield* createDetachedWorktree({
          cwd: input.cwd,
          ref: targetAssociatedWorktreeRef,
          path: targetAssociatedWorktreePath,
        });
      }
      if (targetWorktreeName) {
        if (!targetBaseBranch) {
          return yield* gitManagerError(
            "handoffThread",
            "Select a base branch before creating a new worktree.",
          );
        }
        return yield* createNamedWorktree({
          cwd: input.cwd,
          baseBranch: targetBaseBranch,
          name: targetWorktreeName,
          path: null,
        });
      }
      if (targetAssociatedWorktreeBranch) {
        if (
          (yield* gitCore.listLocalBranchNames(input.cwd)).includes(targetAssociatedWorktreeBranch)
        ) {
          return yield* gitCore.createWorktree({
            cwd: input.cwd,
            branch: targetAssociatedWorktreeBranch,
            path: targetAssociatedWorktreePath,
          });
        }
        if (!targetBaseBranch) {
          return yield* createDetachedWorktree({
            cwd: input.cwd,
            ref: targetAssociatedWorktreeBranch,
            path: targetAssociatedWorktreePath,
          });
        }
        return yield* gitCore.createWorktree({
          cwd: input.cwd,
          branch: targetBaseBranch ?? targetAssociatedWorktreeBranch,
          newBranch: targetAssociatedWorktreeBranch,
          path: targetAssociatedWorktreePath,
        });
      }
      if (!targetBaseBranch) {
        return yield* createDetachedWorktree({
          cwd: input.cwd,
          ref: targetAssociatedWorktreeRef!,
          path: targetAssociatedWorktreePath,
        });
      }
      return yield* createDetachedWorktree({
        cwd: input.cwd,
        ref: targetBaseBranch,
        path: targetAssociatedWorktreePath,
        ...(targetWorktreeName ? { name: targetWorktreeName } : {}),
      });
    }).pipe(
      Effect.catch((error) =>
        restoreLocalHandoffSource({
          cwd: input.cwd,
          originalBranch: sourceBranch,
          originalHeadRef: sourceHeadRef,
          currentBranch: foregroundBranchAfterHandoff,
          stashRef: sourceStash.stashRef,
        }).pipe(
          Effect.flatMap((recovery) =>
            Effect.fail(
              new GitManagerError({
                operation: "GitManager.handoffThread",
                detail: buildFailedWorktreeHandoffRecoveryDetail(error.message, recovery),
                cause: error,
              }),
            ),
          ),
        ),
      ),
    );

    const transfer = yield* popStash(worktree.worktree.path, sourceStash.stashRef);
    if (transfer.conflictsDetected) {
      const recovery = yield* rollbackFailedWorktreeTransfer({
        cwd: input.cwd,
        worktreePath: worktree.worktree.path,
        originalBranch: sourceBranch,
        originalHeadRef: sourceHeadRef,
        currentBranch: foregroundBranchAfterHandoff,
        stashRef: sourceStash.stashRef,
      });
      return yield* new GitManagerError({
        operation: "GitManager.handoffThread",
        detail: buildFailedWorktreeTransferDetail(
          `${
            transfer.message ?? "Git reported conflicts while applying the handed off changes."
          } The stash entry was kept for recovery.`,
          recovery,
        ),
      });
    }

    const materializedWorktreeStatus = yield* gitCore.statusDetails(worktree.worktree.path);
    const materializedWorktreeRef =
      (yield* readHeadRef(worktree.worktree.path)) ??
      ("ref" in worktree.worktree ? worktree.worktree.ref : worktree.worktree.branch);
    const materializedWorktreeBranch = materializedWorktreeStatus.branch ?? null;
    if (materializedWorktreeBranch) {
      // Publishing is best-effort: handoff should still succeed for local-only repositories.
      yield* gitCore
        .publishBranch({ cwd: worktree.worktree.path, branch: materializedWorktreeBranch })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("GitManager.handoffThread could not publish worktree branch", {
              cwd: worktree.worktree.path,
              branch: materializedWorktreeBranch,
              reason: error.message,
            }),
          ),
        );
    }
    const changesTransferred = sourceStash.hadChanges;
    const handoffSummary =
      foregroundBranchAfterHandoff && foregroundBranchAfterHandoff !== sourceBranch
        ? `The thread moved into its worktree and Local returned to '${foregroundBranchAfterHandoff}'.`
        : foregroundBranchAfterHandoff === null && sourceBranch === targetAssociatedWorktreeBranch
          ? "The thread moved into its worktree and Local returned to a detached HEAD."
          : "The thread moved into its worktree.";
    const message = changesTransferred
      ? `${handoffSummary} Uncommitted local changes were carried over.`
      : handoffSummary;

    return {
      targetMode: "worktree",
      branch: materializedWorktreeBranch,
      worktreePath: worktree.worktree.path,
      associatedWorktreePath: worktree.worktree.path,
      associatedWorktreeBranch: materializedWorktreeBranch,
      associatedWorktreeRef: materializedWorktreeRef,
      changesTransferred,
      conflictsDetected: false,
      message,
    };
  });

  const runFeatureBranchStep = (
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
    textGenerationParams?: GitTextGenerationParams,
    options?: FeatureBranchStepOptions,
  ) =>
    Effect.gen(function* () {
      const suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        includeBranch: true,
        ...(textGenerationParams ?? {}),
      });
      if (!suggestion && !options?.allowCommittedHead) {
        return yield* gitManagerError(
          "runFeatureBranchStep",
          "Cannot create a feature branch because there are no changes to commit.",
        );
      }

      const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
      const committedHeadBranchBase = yield* Effect.gen(function* () {
        if (suggestion) {
          return suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
        }
        const latestCommitSubject = yield* gitCore
          .execute({
            operation: "GitManager.runFeatureBranchStep.readHeadSubject",
            cwd,
            args: ["log", "-1", "--pretty=%s"],
          })
          .pipe(Effect.map((result) => result.stdout.trim().split(/\r?\n/g)[0]?.trim() ?? ""));
        if (latestCommitSubject.length > 0) {
          return latestCommitSubject;
        }
        return branch ? `${branch}-update` : undefined;
      });
      const resolvedBranch = resolveAutoFeatureBranchName(
        existingBranchNames,
        committedHeadBranchBase,
      );

      yield* gitCore.createBranch({ cwd, branch: resolvedBranch });
      yield* Effect.scoped(gitCore.checkoutBranch({ cwd, branch: resolvedBranch }));
      if (options?.restoreOriginalBranchRef && branch) {
        // Move the original branch back to its trusted remote/upstream ref so
        // "create feature branch and continue" actually removes the commits
        // from the source branch instead of leaving both branches pointing at them.
        yield* gitCore.execute({
          operation: "GitManager.runFeatureBranchStep.restoreOriginalBranch",
          cwd,
          args: ["branch", "--force", branch, options.restoreOriginalBranchRef],
        });
      }

      return {
        branchStep: { status: "created" as const, name: resolvedBranch },
        resolvedCommitMessage: suggestion?.commitMessage,
        resolvedCommitSuggestion: suggestion ?? undefined,
      };
    });

  const resolveCommittedHeadRestoreRef = (
    cwd: string,
    details: { branch: string | null; upstreamRef: string | null },
  ) =>
    Effect.gen(function* () {
      if (!details.branch) {
        return null;
      }
      if (details.upstreamRef) {
        return details.upstreamRef;
      }

      const remoteNames = yield* gitCore
        .execute({
          operation: "GitManager.resolveCommittedHeadRestoreRef.listRemotes",
          cwd,
          args: ["remote"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.map((result) => prioritizeRemoteNames(result.stdout.split(/\r?\n/g))));
      if (remoteNames.length > 1) {
        return yield* gitManagerError(
          "resolveCommittedHeadRestoreRef",
          `Cannot move committed work to a feature branch because '${details.branch}' has no upstream and this repository has multiple remotes. Push the branch first or configure its upstream before retrying.`,
        );
      }

      for (const remoteName of remoteNames) {
        const remoteRef = `${remoteName}/${details.branch}`;
        const remoteExists = yield* gitCore
          .execute({
            operation: "GitManager.resolveCommittedHeadRestoreRef.remoteExists",
            cwd,
            args: ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteRef}`],
            allowNonZeroExit: true,
            timeoutMs: 5_000,
          })
          .pipe(Effect.map((result) => result.code === 0));
        if (!remoteExists) {
          continue;
        }

        yield* gitCore.execute({
          operation: "GitManager.resolveCommittedHeadRestoreRef.refreshRemoteBranch",
          cwd,
          args: [
            "fetch",
            "--quiet",
            "--no-tags",
            remoteName,
            `+refs/heads/${details.branch}:refs/remotes/${remoteRef}`,
          ],
          timeoutMs: 10_000,
        });
        return remoteRef;
      }

      return yield* gitManagerError(
        "resolveCommittedHeadRestoreRef",
        `Cannot move committed work to a feature branch because '${details.branch}' has no upstream or matching remote branch to restore.`,
      );
    });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fnUntraced(
    function* (input, options) {
      const progress = createProgressEmitter(input, options);
      let currentPhase: GitActionProgressPhase | null = null;

      const runAction = Effect.gen(function* () {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const textGenerationParams: GitTextGenerationParams = {
          textGenerationModel: input.textGenerationModel,
          textGenerationModelSelection: input.textGenerationModelSelection,
          codexHomePath: input.codexHomePath,
          providerOptions: input.providerOptions,
        };
        const wantsCommit = isCommitAction(input.action);
        const wantsPush =
          input.action === "push" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr" ||
          (input.action === "create_pr" &&
            (input.featureBranch || !initialStatus.hasUpstream || initialStatus.aheadCount > 0));
        const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";
        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
          ...(wantsPr ? (["pr"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (
          input.action === "push" &&
          initialStatus.hasWorkingTreeChanges &&
          !input.allowDirtyWorkingTree
        ) {
          return yield* gitManagerError(
            "runStackedAction",
            "Commit or stash local changes before pushing.",
          );
        }
        if (
          input.action === "create_pr" &&
          initialStatus.hasWorkingTreeChanges &&
          !input.allowDirtyWorkingTree
        ) {
          return yield* gitManagerError(
            "runStackedAction",
            "Commit local changes before creating a PR.",
          );
        }
        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
        }
        if (!input.featureBranch && wantsPr && !initialStatus.branch) {
          return yield* gitManagerError(
            "runStackedAction",
            "Cannot create a pull request from detached HEAD.",
          );
        }
        const committedHeadRestoreRef =
          input.featureBranch && !wantsCommit
            ? yield* resolveCommittedHeadRestoreRef(input.cwd, {
                branch: initialStatus.branch,
                upstreamRef: initialStatus.upstreamRef,
              })
            : null;

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

        if (input.featureBranch) {
          currentPhase = "branch";
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
            textGenerationParams,
            {
              allowCommittedHead: !wantsCommit,
              restoreOriginalBranchRef: committedHeadRestoreRef,
            },
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;
        const commit = commitAction
          ? yield* Effect.gen(function* () {
              currentPhase = "commit";
              return yield* runCommitStep(
                input.cwd,
                commitAction,
                currentBranch,
                commitMessageForStep,
                preResolvedCommitSuggestion,
                input.filePaths,
                textGenerationParams,
                options?.progressReporter,
                progress.actionId,
              );
            })
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    currentPhase = "push";
                    return yield* gitCore.pushCurrentBranch(input.cwd, currentBranch);
                  }),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const pr = wantsPr
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "pr",
                label: "Creating PR...",
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    currentPhase = "pr";
                    return yield* runPrStep(input.cwd, currentBranch, textGenerationParams, {
                      title: input.prTitle,
                      body: input.prBody,
                      draft: input.prDraft,
                    });
                  }),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction.pipe(
        Effect.catch((error) =>
          progress
            .emit({
              kind: "action_failed",
              phase: currentPhase,
              message: error.message,
            })
            .pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );
    },
  );

  return {
    status,
    pullRequestForBranch,
    readWorkingTreeDiff,
    readWorkingTreeDiffStats,
    summarizeDiff,
    resolvePullRequest,
    pullRequestSnapshot,
    preparePullRequestThread: (input) =>
      gitCore.withMutation(input.cwd, preparePullRequestThread(input)),
    handoffThread: (input) => gitCore.withMutation(input.cwd, handoffThread(input)),
    runStackedAction: (input, options) =>
      gitCore.withMutation(input.cwd, runStackedAction(input, options)),
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager);
