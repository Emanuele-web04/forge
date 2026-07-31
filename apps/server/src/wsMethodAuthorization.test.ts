import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  authorizeWsMethod,
  CLIENT_ALLOWED_WS_METHODS,
  LOCAL_ONLY_WS_METHODS,
  OWNER_ONLY_WS_METHODS,
} from "./wsMethodAuthorization";

const loopback = { host: "127.0.0.1", publicUrl: undefined, allowInsecureRemote: false } as const;
const remote = { host: "0.0.0.0", publicUrl: undefined, allowInsecureRemote: false } as const;
const published = {
  host: "127.0.0.1",
  publicUrl: new URL("https://synara.example.test/"),
  allowInsecureRemote: false,
} as const;

describe("owner-only enforcement", () => {
  it("covers every host-administration method", () => {
    // Pinned so a new host-administration method cannot be added to the RPC
    // group without a deliberate decision about its authorization.
    expect([...OWNER_ONLY_WS_METHODS].toSorted()).toEqual(
      [
        WS_METHODS.serverListExternalMcpIntegrations,
        WS_METHODS.serverCreateExternalMcpIntegration,
        WS_METHODS.serverRevokeExternalMcpIntegration,
        WS_METHODS.serverRefreshExternalMcpPairing,
        WS_METHODS.serverUpdateSettings,
        WS_METHODS.serverUpdateProvider,
        WS_METHODS.serverUpsertKeybinding,
        WS_METHODS.serverStopLocalServer,
      ].toSorted(),
    );
  });

  it.each([...OWNER_ONLY_WS_METHODS])("rejects %s for a non-owner client", (method) => {
    const rejection = authorizeWsMethod({ method, role: "client", config: loopback });
    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("Owner authorization");
  });

  it.each([...OWNER_ONLY_WS_METHODS])("admits %s for an owner on a local-only bind", (method) => {
    expect(authorizeWsMethod({ method, role: "owner", config: loopback })).toBeNull();
  });
});

describe("local-only enforcement", () => {
  // Every local-only method is also owner-only. Without this, a method could be
  // restricted to loopback deployments yet reachable by a non-owner client on
  // that same loopback box, which is not the intent of either table.
  it("keeps LOCAL_ONLY a subset of OWNER_ONLY", () => {
    for (const method of LOCAL_ONLY_WS_METHODS) {
      expect(OWNER_ONLY_WS_METHODS.has(method), `${method} is local-only but not owner-only`).toBe(
        true,
      );
    }
  });

  it("refuses every local-only method for a non-owner even on a loopback bind", () => {
    for (const method of LOCAL_ONLY_WS_METHODS) {
      expect(authorizeWsMethod({ method, role: "client", config: loopback })).not.toBeNull();
    }
  });

  it.each([...LOCAL_ONLY_WS_METHODS])(
    "rejects %s on a remote-reachable bind even for an owner",
    (method) => {
      for (const config of [remote, published, { ...loopback, allowInsecureRemote: true }]) {
        const rejection = authorizeWsMethod({ method, role: "owner", config });
        expect(rejection).not.toBeNull();
        expect(rejection?.message).toContain("loopback-only");
      }
    },
  );

  it("prefers the local-only refusal over the role refusal for a remote client", () => {
    const rejection = authorizeWsMethod({
      method: WS_METHODS.serverCreateExternalMcpIntegration,
      role: "client",
      config: remote,
    });
    expect(rejection?.message).toContain("loopback-only");
  });
});

it("leaves ordinary thread work authorized for a paired client", () => {
  for (const method of [
    WS_METHODS.gitStatus,
    WS_METHODS.serverGetSettings,
    WS_METHODS.terminalWrite,
  ]) {
    expect(authorizeWsMethod({ method, role: "client", config: remote })).toBeNull();
  }
});

describe("default deny", () => {
  // The failure class this table exists to remove: a privileged handler added
  // to the RPC group without a decision recorded must NOT be reachable.
  it.each([
    "server.someFutureUnclassifiedMethod",
    "orchestration.someFutureUnclassifiedMethod",
    "",
  ])("refuses unregistered method %j for a client session", (method) => {
    const rejection = authorizeWsMethod({ method, role: "client", config: loopback });
    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("not available to this session");
  });

  /**
   * The literal roster, mirroring the one that anchors READ_ONLY_SAFE_WS_METHODS
   * in buildSkew.test.ts. Without it this set drifts silently: every other test
   * here iterates the set under test, so they prove behaviour for whichever
   * members remain and say nothing about a member that was removed — or one
   * added without review. Removing an entry left both authorization suites
   * green before this existed.
   *
   * Adding a method here is a deliberate act: it grants a non-owner session the
   * right to call it. Check the handler, then update this list.
   */
  it("matches the exact reviewed roster of client-allowed methods", () => {
    expect([...CLIENT_ALLOWED_WS_METHODS].toSorted()).toEqual(
      [
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        ORCHESTRATION_WS_METHODS.getShellSnapshot,
        ORCHESTRATION_WS_METHODS.getSnapshot,
        ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        ORCHESTRATION_WS_METHODS.importThread,
        ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
        ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
        ORCHESTRATION_WS_METHODS.repairState,
        ORCHESTRATION_WS_METHODS.replayEvents,
        ORCHESTRATION_WS_METHODS.subscribeShell,
        ORCHESTRATION_WS_METHODS.subscribeThread,
        ORCHESTRATION_WS_METHODS.unsubscribeShell,
        ORCHESTRATION_WS_METHODS.unsubscribeThread,
        WS_METHODS.automationArchiveRun,
        WS_METHODS.automationCancelRun,
        WS_METHODS.automationCreate,
        WS_METHODS.automationDelete,
        WS_METHODS.automationGetMemory,
        WS_METHODS.automationList,
        WS_METHODS.automationMarkRunRead,
        WS_METHODS.automationResolveProposal,
        WS_METHODS.automationRunNow,
        WS_METHODS.automationUpdate,
        WS_METHODS.filesystemBrowse,
        WS_METHODS.gitCheckout,
        WS_METHODS.gitCreateBranch,
        WS_METHODS.gitCreateDetachedWorktree,
        WS_METHODS.gitCreateWorktree,
        WS_METHODS.gitGithubRepository,
        WS_METHODS.gitHandoffThread,
        WS_METHODS.gitInit,
        WS_METHODS.gitListBranches,
        WS_METHODS.gitPreparePullRequestThread,
        WS_METHODS.gitPull,
        WS_METHODS.gitPullRequestSnapshot,
        WS_METHODS.gitReadWorkingTreeDiff,
        WS_METHODS.gitRemoveIndexLock,
        WS_METHODS.gitRemoveWorktree,
        WS_METHODS.gitResolvePullRequest,
        WS_METHODS.gitRunStackedAction,
        WS_METHODS.gitStageFiles,
        WS_METHODS.gitStashAndCheckout,
        WS_METHODS.gitStashDrop,
        WS_METHODS.gitStashInfo,
        WS_METHODS.gitStatus,
        WS_METHODS.gitSummarizeDiff,
        WS_METHODS.gitUnstageFiles,
        WS_METHODS.gitWorkingTreeDiffStats,
        WS_METHODS.projectsCreateLocalFilePreviewGrant,
        WS_METHODS.projectsDiscoverScripts,
        WS_METHODS.projectsListDevServers,
        WS_METHODS.projectsListDirectories,
        WS_METHODS.projectsReadFile,
        WS_METHODS.projectsRunDevServer,
        WS_METHODS.projectsSearchEntries,
        WS_METHODS.projectsSearchLocalEntries,
        WS_METHODS.projectsStopDevServer,
        WS_METHODS.projectsWriteFile,
        WS_METHODS.providerCompactThread,
        WS_METHODS.providerGetComposerCapabilities,
        WS_METHODS.providerListAgents,
        WS_METHODS.providerListCommands,
        WS_METHODS.providerListModels,
        WS_METHODS.providerListPlugins,
        WS_METHODS.providerListSkills,
        WS_METHODS.providerListSkillsCatalog,
        WS_METHODS.providerReadPlugin,
        WS_METHODS.pullRequestsAction,
        WS_METHODS.pullRequestsComment,
        WS_METHODS.pullRequestsDetail,
        WS_METHODS.pullRequestsDiff,
        WS_METHODS.pullRequestsList,
        WS_METHODS.pullRequestsReviewRequestCount,
        WS_METHODS.pullRequestsSetPinned,
        WS_METHODS.serverGenerateAutomationIntent,
        WS_METHODS.serverGenerateThreadRecap,
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverGetDiagnostics,
        WS_METHODS.serverGetEnvironment,
        WS_METHODS.serverGetProviderUsageSnapshot,
        WS_METHODS.serverGetSettings,
        WS_METHODS.serverListLocalServers,
        WS_METHODS.serverListProviderUsage,
        WS_METHODS.serverListWorktrees,
        WS_METHODS.serverRefreshProviders,
        WS_METHODS.serverTranscribeVoice,
        WS_METHODS.shellOpenInEditor,
        WS_METHODS.statsGetProfileStats,
        WS_METHODS.statsGetProfileTokenStats,
        WS_METHODS.studioListThreadOutputs,
        WS_METHODS.subscribeAutomationEvents,
        WS_METHODS.subscribeOrchestrationDomainEvents,
        WS_METHODS.subscribeProjectDevServerEvents,
        WS_METHODS.subscribeServerConfig,
        WS_METHODS.subscribeServerLifecycle,
        WS_METHODS.subscribeServerProviderStatuses,
        WS_METHODS.subscribeServerSettings,
        WS_METHODS.subscribeTerminalEvents,
        WS_METHODS.terminalAckOutput,
        WS_METHODS.terminalClear,
        WS_METHODS.terminalClose,
        WS_METHODS.terminalOpen,
        WS_METHODS.terminalResize,
        WS_METHODS.terminalRestart,
        WS_METHODS.terminalWrite,
      ].toSorted(),
    );
  });

  it("never lists an owner-only method as client-allowed", () => {
    for (const method of OWNER_ONLY_WS_METHODS) {
      expect(CLIENT_ALLOWED_WS_METHODS.has(method), `${method} is client-allowed`).toBe(false);
    }
  });
});

describe("server-side version skew", () => {
  it("refuses a mutation from a skewed client regardless of role", () => {
    for (const role of ["owner", "client"] as const) {
      const rejection = authorizeWsMethod({
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
        role,
        config: loopback,
        buildSkewed: true,
      });
      expect(rejection).not.toBeNull();
      expect(rejection?.message).toContain("different Synara build");
    }
  });

  // Mutating methods stay refused under skew regardless of how read-like the
  // name is. server.listWorktrees is deliberately NOT in this list anymore: its
  // handler was made a pure scan (see managedWorktrees.test.ts).
  it.each([
    WS_METHODS.gitCheckout,
    WS_METHODS.gitRemoveWorktree,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.terminalWrite,
  ])("refuses mutating %s from a skewed client", (method) => {
    expect(
      authorizeWsMethod({ method, role: "owner", config: loopback, buildSkewed: true }),
    ).not.toBeNull();
  });

  it("still admits reads from a skewed client", () => {
    expect(
      authorizeWsMethod({
        method: WS_METHODS.gitStatus,
        role: "client",
        config: loopback,
        buildSkewed: true,
      }),
    ).toBeNull();
  });
});
