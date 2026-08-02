import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsFeatureRpcGroup } from "@synara/contracts";
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
        WS_METHODS.serverProbeRemoteHost,
        WS_METHODS.serverGetRemoteHostFingerprint,
        WS_METHODS.serverGetPhoneReachability,
      ].toSorted(),
    );
  });

  it("keeps remote-host key fingerprinting owner-only", () => {
    // Same outbound capability as probing: it resolves a caller-chosen
    // destination through the OPERATOR's ~/.ssh/config and dials it. A paired
    // non-owner could otherwise use this server to scan hosts it cannot reach
    // itself, and read the operator's config by inference from the results.
    expect(OWNER_ONLY_WS_METHODS.has(WS_METHODS.serverGetRemoteHostFingerprint)).toBe(true);
  });

  it("keeps phone-reachability detection owner-only", () => {
    // It reports this machine's tailnet name and how it is exposed — network
    // topology of the operator's host, not work inside a thread. It also exists
    // solely to build a pairing QR code, and only an owner may issue pairing
    // credentials, so a paired non-owner learning how to reach the host is the
    // first half of handing out access nobody granted.
    expect(OWNER_ONLY_WS_METHODS.has(WS_METHODS.serverGetPhoneReachability)).toBe(true);
  });

  it("keeps remote-host probing owner-only on every deployment shape", () => {
    // The probe makes THIS server dial an address the caller chose. Reachable
    // from a paired non-owner client it would be an outbound amplifier.
    for (const config of [loopback, remote, published]) {
      expect(
        authorizeWsMethod({ method: WS_METHODS.serverProbeRemoteHost, role: "client", config }),
      ).not.toBeNull();
      expect(
        authorizeWsMethod({ method: WS_METHODS.serverProbeRemoteHost, role: "owner", config }),
      ).toBeNull();
    }
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
  const unclassifiedMethods = [
    "server.someFutureUnclassifiedMethod",
    "orchestration.someFutureUnclassifiedMethod",
    "server.someFutureHostLocalMethod",
    "",
  ];

  // The failure class these tables exist to remove: a privileged handler added
  // to the RPC group without a decision recorded must NOT be reachable — and
  // that has to hold for EVERY role. An owner pass placed above this check made
  // the default-deny client-only, so a forgotten handler stayed remotely
  // callable by an owner on a remote-reachable deployment.
  it.each(unclassifiedMethods)("refuses unclassified method %j for a client session", (method) => {
    const rejection = authorizeWsMethod({ method, role: "client", config: loopback });
    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("not classified");
  });

  it.each(unclassifiedMethods)("refuses unclassified method %j for an owner session", (method) => {
    for (const config of [loopback, remote, published]) {
      const rejection = authorizeWsMethod({ method, role: "owner", config });
      expect(rejection, `${method} was admitted for an owner`).not.toBeNull();
      expect(rejection?.message).toContain("not classified");
    }
  });

  // The two refusals must stay distinguishable. A developer who forgets the
  // table should read "unclassified", not a permission error that sends them
  // looking at session roles.
  it("distinguishes an unclassified method from a privilege refusal", () => {
    const unclassified = authorizeWsMethod({
      method: "server.someFutureUnclassifiedMethod",
      role: "client",
      config: loopback,
    });
    const privileged = authorizeWsMethod({
      method: WS_METHODS.serverUpdateSettings,
      role: "client",
      config: loopback,
    });
    expect(unclassified?.message).toContain("not classified");
    expect(privileged?.message).toContain("Owner authorization");
    expect(unclassified?.message).not.toEqual(privileged?.message);
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

  /**
   * The runtime twin of the build-time exhaustiveness gate in
   * wsMethodAuthorization.ts. The type-level check proves the tables cover the
   * group; this proves the same for the values actually consulted at runtime,
   * and would catch a table populated through a cast that defeats the types.
   */
  it("classifies every method the feature RPC group can dispatch", () => {
    const dispatchableMethods = [
      ...(
        WsFeatureRpcGroup as unknown as { readonly requests: ReadonlyMap<string, unknown> }
      ).requests.keys(),
    ];
    expect(dispatchableMethods.length).toBeGreaterThan(0);
    const unclassified = dispatchableMethods.filter(
      (method) =>
        !CLIENT_ALLOWED_WS_METHODS.has(method) &&
        !OWNER_ONLY_WS_METHODS.has(method) &&
        !LOCAL_ONLY_WS_METHODS.has(method),
    );
    expect(unclassified).toEqual([]);
  });

  it("lists no method that the feature RPC group cannot dispatch", () => {
    const dispatchableMethods = new Set(
      (
        WsFeatureRpcGroup as unknown as { readonly requests: ReadonlyMap<string, unknown> }
      ).requests.keys(),
    );
    const stale = [
      ...CLIENT_ALLOWED_WS_METHODS,
      ...OWNER_ONLY_WS_METHODS,
      ...LOCAL_ONLY_WS_METHODS,
    ].filter((method) => !dispatchableMethods.has(method));
    expect(stale).toEqual([]);
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
