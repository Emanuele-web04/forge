// FILE: buildSkew.ts
// Purpose: Classify client/server build skew and decide what a skewed session
//          is still allowed to do.
// Layer: Shared protocol policy
// Exports: parseBuildVersion, classifyBuildSkew, isReadOnlySafeWsMethod,
//          READ_ONLY_SAFE_WS_METHODS

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";

export type BuildSkew = "compatible" | "read-only";

export interface BuildVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Accepts the leading `major.minor` of a semver-ish build string and ignores
 * patch/prerelease/build metadata. Returns null for anything unparseable so
 * callers can decide the fail-safe direction explicitly.
 */
export function parseBuildVersion(build: string | undefined): BuildVersion | null {
  const match = /^\s*v?(\d+)\.(\d+)(?:[.+-]|$)/.exec(build ?? "");
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? { major, minor } : null;
}

/**
 * The RFC's skew policy: never hard-fail, never silently write cross-version.
 * A major/minor mismatch degrades the session to read-only; patch differences
 * are routine within a release line and stay fully usable.
 *
 * An unparseable build on either side is treated as skew. A degraded session is
 * recoverable (the user updates and reloads); a wrongly-trusted one is not.
 */
export function classifyBuildSkew(input: {
  readonly clientBuild: string | undefined;
  readonly serverBuild: string | undefined;
}): BuildSkew {
  const client = parseBuildVersion(input.clientBuild);
  const server = parseBuildVersion(input.serverBuild);
  if (!client || !server) return "read-only";
  return client.major === server.major && client.minor === server.minor
    ? "compatible"
    : "read-only";
}

/**
 * Allowlist of methods a read-only degraded session may still issue. It is an
 * allowlist, not a denylist, so a method added to the protocol later is refused
 * by default in a skewed session rather than silently writing across versions.
 */
export const READ_ONLY_SAFE_WS_METHODS: ReadonlySet<string> = new Set<string>([
  ORCHESTRATION_WS_METHODS.getSnapshot,
  ORCHESTRATION_WS_METHODS.getShellSnapshot,
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_WS_METHODS.replayEvents,
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.unsubscribeShell,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  ORCHESTRATION_WS_METHODS.unsubscribeThread,
  WS_METHODS.subscribeOrchestrationDomainEvents,

  WS_METHODS.projectsDiscoverScripts,
  WS_METHODS.projectsListDirectories,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsSearchLocalEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsListDevServers,
  WS_METHODS.subscribeProjectDevServerEvents,
  WS_METHODS.studioListThreadOutputs,
  WS_METHODS.filesystemBrowse,

  WS_METHODS.gitGithubRepository,
  WS_METHODS.gitStatus,
  WS_METHODS.gitReadWorkingTreeDiff,
  WS_METHODS.gitWorkingTreeDiffStats,
  WS_METHODS.gitSummarizeDiff,
  WS_METHODS.gitListBranches,
  WS_METHODS.gitStashInfo,
  WS_METHODS.gitResolvePullRequest,
  WS_METHODS.gitPullRequestSnapshot,
  WS_METHODS.pullRequestsList,
  WS_METHODS.pullRequestsReviewRequestCount,
  WS_METHODS.pullRequestsDetail,
  WS_METHODS.pullRequestsDiff,

  WS_METHODS.serverGetConfig,
  WS_METHODS.serverGetEnvironment,
  WS_METHODS.serverGetSettings,
  WS_METHODS.serverListExternalMcpIntegrations,
  // Safe only because its handler is a pure inventory scan. It previously ran
  // retention pruning (snapshot + force-remove) despite the "list" name; that
  // side effect now lives on the thread.archive path. If listing ever mutates
  // again, remove this entry.
  WS_METHODS.serverListWorktrees,
  WS_METHODS.serverListLocalServers,
  WS_METHODS.serverGetProviderUsageSnapshot,
  WS_METHODS.serverListProviderUsage,
  WS_METHODS.serverGetDiagnostics,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerProviderStatuses,
  WS_METHODS.subscribeServerSettings,
  WS_METHODS.statsGetProfileStats,
  WS_METHODS.statsGetProfileTokenStats,

  WS_METHODS.providerGetComposerCapabilities,
  WS_METHODS.providerListCommands,
  WS_METHODS.providerListSkills,
  WS_METHODS.providerListSkillsCatalog,
  WS_METHODS.providerListPlugins,
  WS_METHODS.providerReadPlugin,
  WS_METHODS.providerListModels,
  WS_METHODS.providerListAgents,

  WS_METHODS.automationList,
  WS_METHODS.automationGetMemory,
  WS_METHODS.subscribeAutomationEvents,
  WS_METHODS.subscribeTerminalEvents,
]);

export function isReadOnlySafeWsMethod(method: string): boolean {
  return READ_ONLY_SAFE_WS_METHODS.has(method);
}
