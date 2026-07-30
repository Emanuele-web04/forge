// FILE: wsMethodAuthorization.ts
// Purpose: Declarative authorization table for WebSocket RPC methods, enforced
//          centrally by the admission middleware instead of per handler.
// Layer: Server transport security
// Exports: CLIENT_ALLOWED_WS_METHODS, OWNER_ONLY_WS_METHODS,
//          LOCAL_ONLY_WS_METHODS, authorizeWsMethod

import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcError } from "@synara/contracts";
import { isReadOnlySafeWsMethod } from "@synara/shared/buildSkew";

import { isLocalOnlyDeployment, type RemoteAccessDeployment } from "./remoteAccessPolicy";
import type { WsSessionRole } from "./wsConnectionSessions";

/**
 * Methods a non-owner ("client") session may invoke. This is an ALLOWLIST and
 * the authorization default is DENY: a handler added to the RPC group without
 * a decision recorded here is refused for client sessions rather than silently
 * exposed. Adding a privileged method must be a deliberate act.
 *
 * Owners are not filtered by this list — they are gated by the owner-only and
 * local-only tables below.
 */
export const CLIENT_ALLOWED_WS_METHODS: ReadonlySet<string> = new Set<string>([
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
]);

/**
 * Methods that administer the machine the server runs on rather than the work
 * happening inside a thread. A paired non-owner client may run turns and read
 * state, but may not reconfigure the host.
 */
export const OWNER_ONLY_WS_METHODS: ReadonlySet<string> = new Set<string>([
  WS_METHODS.serverListExternalMcpIntegrations,
  WS_METHODS.serverCreateExternalMcpIntegration,
  WS_METHODS.serverRevokeExternalMcpIntegration,
  WS_METHODS.serverRefreshExternalMcpPairing,
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverUpsertKeybinding,
  WS_METHODS.serverStopLocalServer,
]);

/**
 * Methods whose blast radius is the operator's own machine and which therefore
 * stay unavailable on any remote-reachable deployment, regardless of role.
 */
export const LOCAL_ONLY_WS_METHODS: ReadonlySet<string> = new Set<string>([
  WS_METHODS.serverListExternalMcpIntegrations,
  WS_METHODS.serverCreateExternalMcpIntegration,
  WS_METHODS.serverRevokeExternalMcpIntegration,
  WS_METHODS.serverRefreshExternalMcpPairing,
]);

/**
 * Returns the rejection for a method/role/deployment combination, or null when
 * the call is authorized. Ordering is deliberate: a remote client learns the
 * capability does not exist here before it learns anything about its own role.
 */
export function authorizeWsMethod(input: {
  readonly method: string;
  readonly role: WsSessionRole;
  readonly config: RemoteAccessDeployment;
  readonly buildSkewed?: boolean;
}): WsRpcError | null {
  // Version skew is enforced server-side, not just in the client's transport:
  // a client on a different build must never mutate cross-version, however it
  // was built. Reads stay available so the session degrades rather than dies.
  if (input.buildSkewed && !isReadOnlySafeWsMethod(input.method)) {
    return new WsRpcError({
      message:
        "This client runs a different Synara build than the server. Update both to the same version to make changes.",
    });
  }
  if (LOCAL_ONLY_WS_METHODS.has(input.method) && !isLocalOnlyDeployment(input.config)) {
    return new WsRpcError({
      message: "This operation is available only on a loopback-only Synara instance.",
    });
  }
  if (input.role === "owner") return null;
  if (OWNER_ONLY_WS_METHODS.has(input.method)) {
    return new WsRpcError({
      message: "Owner authorization is required for this operation.",
    });
  }
  // Default deny for anything not explicitly cleared for client sessions.
  if (!CLIENT_ALLOWED_WS_METHODS.has(input.method)) {
    return new WsRpcError({
      message: "This operation is not available to this session.",
    });
  }
  return null;
}
