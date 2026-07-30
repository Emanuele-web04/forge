import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyBuildSkew,
  isReadOnlySafeWsMethod,
  parseBuildVersion,
  READ_ONLY_SAFE_WS_METHODS,
} from "./buildSkew";

describe("parseBuildVersion", () => {
  it.each([
    ["0.6.3", { major: 0, minor: 6 }],
    ["v1.2.3", { major: 1, minor: 2 }],
    ["10.20.0-beta.1", { major: 10, minor: 20 }],
    ["1.2", { major: 1, minor: 2 }],
    ["1.2+build.5", { major: 1, minor: 2 }],
  ])("parses %s", (build, expected) => {
    expect(parseBuildVersion(build)).toEqual(expected);
  });

  it.each([undefined, "", "dev", "1", "x.y.z", ".1.2", "1.x"])(
    "returns null for unparseable build %s",
    (build) => {
      expect(parseBuildVersion(build)).toBeNull();
    },
  );
});

describe("classifyBuildSkew", () => {
  it("treats patch differences within a release line as compatible", () => {
    expect(classifyBuildSkew({ clientBuild: "0.6.3", serverBuild: "0.6.9" })).toBe("compatible");
    expect(classifyBuildSkew({ clientBuild: "0.6.3", serverBuild: "0.6.3" })).toBe("compatible");
  });

  it.each([
    ["a minor skew", "0.6.3", "0.7.0"],
    ["a major skew", "1.0.0", "2.0.0"],
    ["a client ahead of the server", "0.7.0", "0.6.3"],
  ])("degrades to read-only on %s", (_label, clientBuild, serverBuild) => {
    expect(classifyBuildSkew({ clientBuild, serverBuild })).toBe("read-only");
  });

  // Fail safe: a degraded session is recoverable, a wrongly-trusted one is not.
  it.each([
    [undefined, "0.6.3"],
    ["0.6.3", undefined],
    ["dev", "0.6.3"],
    ["0.6.3", "unknown"],
  ])("degrades to read-only for unparseable builds (%s, %s)", (clientBuild, serverBuild) => {
    expect(classifyBuildSkew({ clientBuild, serverBuild })).toBe("read-only");
  });
});

describe("read-only method allowlist", () => {
  it.each([
    ORCHESTRATION_WS_METHODS.getSnapshot,
    ORCHESTRATION_WS_METHODS.subscribeThread,
    WS_METHODS.gitStatus,
    WS_METHODS.serverGetSettings,
    WS_METHODS.providerListModels,
  ])("permits read %s", (method) => {
    expect(isReadOnlySafeWsMethod(method)).toBe(true);
  });

  // Every one of these mutates server-side state, so a skewed client issuing
  // them would be writing cross-version.
  it.each([
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    ORCHESTRATION_WS_METHODS.importThread,
    ORCHESTRATION_WS_METHODS.repairState,
    ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.gitCheckout,
    WS_METHODS.gitRunStackedAction,
    WS_METHODS.gitCreateBranch,
    WS_METHODS.serverUpdateSettings,
    WS_METHODS.serverUpdateProvider,
    WS_METHODS.terminalOpen,
    WS_METHODS.terminalWrite,
    WS_METHODS.automationCreate,
    WS_METHODS.automationRunNow,
    WS_METHODS.pullRequestsAction,
  ])("refuses write %s", (method) => {
    expect(isReadOnlySafeWsMethod(method)).toBe(false);
  });

  it("refuses an unknown method by default", () => {
    expect(isReadOnlySafeWsMethod("some.future.method")).toBe(false);
  });

  // A name heuristic cannot classify safety: server.listWorktrees reads as a
  // "list" but its handler prunes and force-removes archived worktrees. The
  // allowlist is therefore pinned to an exact, reviewed roster — any addition
  // or removal has to be made here deliberately, with the handler inspected.
  it("matches the exact reviewed roster of skew-safe methods", () => {
    expect([...READ_ONLY_SAFE_WS_METHODS].toSorted()).toEqual(
      [
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
      ].toSorted(),
    );
  });

  // server.listWorktrees is allowlisted ONLY because its handler was made a
  // pure scan; the retention pruning it used to run moved to thread.archive.
  // This pairs with managedWorktrees.test.ts, which asserts the list path
  // performs no removal — together they pin the reason, not just the entry.
  it("allowlists server.listWorktrees only as a pure read", () => {
    expect(isReadOnlySafeWsMethod(WS_METHODS.serverListWorktrees)).toBe(true);
  });
});
