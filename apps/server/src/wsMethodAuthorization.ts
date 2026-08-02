// FILE: wsMethodAuthorization.ts
// Purpose: Declarative authorization table for WebSocket RPC methods, enforced
//          centrally by the admission middleware instead of per handler.
// Layer: Server transport security
// Exports: CLIENT_ALLOWED_WS_METHODS, OWNER_ONLY_WS_METHODS,
//          LOCAL_ONLY_WS_METHODS, WsFeatureMethod, authorizeWsMethod

import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsFeatureRpcGroup,
  WsRpcError,
} from "@synara/contracts";
import { isReadOnlySafeWsMethod } from "@synara/shared/buildSkew";
import type { RpcGroup } from "effect/unstable/rpc";

import { isLocalOnlyDeployment, type RemoteAccessDeployment } from "./remoteAccessPolicy";
import type { WsSessionRole } from "./wsConnectionSessions";

/**
 * Every method name the feature RPC group can dispatch, derived from the group
 * itself rather than restated here. This is what makes the coverage assertion
 * at the bottom of this file a real build-time gate: adding an RPC to the group
 * widens this union, and any method left out of all three tables below then
 * fails to typecheck.
 */
export type WsFeatureMethod =
  typeof WsFeatureRpcGroup extends RpcGroup.RpcGroup<infer Rpcs> ? Rpcs["_tag"] : never;

/**
 * Methods a non-owner ("client") session may invoke. This is an ALLOWLIST and
 * the authorization default is DENY: a handler added to the RPC group without
 * a decision recorded here is refused for client sessions rather than silently
 * exposed. Adding a privileged method must be a deliberate act.
 *
 * Owners are not filtered by this list — they are gated by the owner-only and
 * local-only tables below.
 */
const CLIENT_ALLOWED_WS_METHOD_LIST = [
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
] as const satisfies readonly WsFeatureMethod[];

export const CLIENT_ALLOWED_WS_METHODS: ReadonlySet<string> = new Set<string>(
  CLIENT_ALLOWED_WS_METHOD_LIST,
);

/**
 * Methods that administer the machine the server runs on rather than the work
 * happening inside a thread. A paired non-owner client may run turns and read
 * state, but may not reconfigure the host.
 */
const OWNER_ONLY_WS_METHOD_LIST = [
  WS_METHODS.serverListExternalMcpIntegrations,
  WS_METHODS.serverCreateExternalMcpIntegration,
  WS_METHODS.serverRevokeExternalMcpIntegration,
  WS_METHODS.serverRefreshExternalMcpPairing,
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverUpsertKeybinding,
  WS_METHODS.serverStopLocalServer,
  // Probing a remote host makes this server dial an arbitrary address chosen by
  // the caller. That is an outbound capability of the operator's machine, not
  // work inside a thread, so a paired non-owner client may not trigger it.
  WS_METHODS.serverProbeRemoteHost,
  // Reports this machine's tailnet name and how it is exposed — network topology
  // of the operator's host, not work inside a thread. It also exists solely to
  // build a pairing QR code, and only an owner may issue pairing credentials.
  WS_METHODS.serverGetPhoneReachability,
] as const satisfies readonly WsFeatureMethod[];

export const OWNER_ONLY_WS_METHODS: ReadonlySet<string> = new Set<string>(
  OWNER_ONLY_WS_METHOD_LIST,
);

/**
 * Methods whose blast radius is the operator's own machine and which therefore
 * stay unavailable on any remote-reachable deployment, regardless of role.
 */
const LOCAL_ONLY_WS_METHOD_LIST = [
  WS_METHODS.serverListExternalMcpIntegrations,
  WS_METHODS.serverCreateExternalMcpIntegration,
  WS_METHODS.serverRevokeExternalMcpIntegration,
  WS_METHODS.serverRefreshExternalMcpPairing,
] as const satisfies readonly WsFeatureMethod[];

export const LOCAL_ONLY_WS_METHODS: ReadonlySet<string> = new Set<string>(
  LOCAL_ONLY_WS_METHOD_LIST,
);

/**
 * BUILD-TIME EXHAUSTIVENESS GATE.
 *
 * Every method the RPC group can dispatch must appear in at least one table
 * above. `UnclassifiedWsMethod` is the remainder of that subtraction, and the
 * assignment below only compiles while the remainder is empty — so adding an
 * RPC without recording an authorization decision is a type error at the point
 * the method is introduced, not a permission mystery at runtime.
 *
 * The runtime default-deny in `authorizeWsMethod` stays as the backstop: this
 * check covers the statically-known group, while the runtime guard also covers
 * method strings that never came from the group at all.
 */
type UnclassifiedWsMethod = Exclude<
  WsFeatureMethod,
  | (typeof CLIENT_ALLOWED_WS_METHOD_LIST)[number]
  | (typeof OWNER_ONLY_WS_METHOD_LIST)[number]
  | (typeof LOCAL_ONLY_WS_METHOD_LIST)[number]
>;

// If this line fails to compile, the methods named in the error are missing an
// authorization decision. Add each to the table that matches its blast radius.
const _WS_METHOD_AUTHORIZATION_IS_EXHAUSTIVE: never[] = [] as UnclassifiedWsMethod[];
void _WS_METHOD_AUTHORIZATION_IS_EXHAUSTIVE;

function isClassifiedWsMethod(method: string): boolean {
  return (
    CLIENT_ALLOWED_WS_METHODS.has(method) ||
    OWNER_ONLY_WS_METHODS.has(method) ||
    LOCAL_ONLY_WS_METHODS.has(method)
  );
}

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
  // Unknown methods are refused for EVERY role, owners included. The tables are
  // the whole record of what this transport exposes, so a handler added without
  // an entry must fail closed rather than inherit the owner pass. The message
  // names the real cause — an unclassified method, not a lacking privilege — so
  // a developer who forgot the table is not sent hunting through session roles.
  if (!isClassifiedWsMethod(input.method)) {
    return new WsRpcError({
      message:
        "This operation is not classified in the WebSocket authorization tables and is refused.",
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
