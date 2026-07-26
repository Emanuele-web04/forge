import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AutomationCancelRunInput,
  AutomationCancelRunResult,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationDeleteInput,
  AutomationGetMemoryInput,
  AutomationListInput,
  AutomationListResult,
  AutomationMarkRunReadInput,
  AutomationMemory,
  AutomationResolveProposalInput,
  AutomationResolveProposalResult,
  AutomationRunActionResult,
  AutomationRunNowInput,
  AutomationRunNowResult,
  AutomationStreamEvent,
  AutomationUpdateInput,
} from "./automation";
import { OpenInEditorInput } from "./editor";
import {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpCreateIntegrationResult,
  ExternalMcpIntegration,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "./externalMcp";
import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import { StudioListThreadOutputsInput, StudioListThreadOutputsResult } from "./studio";
import {
  GitCheckoutInput,
  GitActionProgressEvent,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitCreateDetachedWorktreeResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitHubRepositoryInput,
  GitHubRepositoryResult,
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitPullRequestSnapshotResult,
  GitPullResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitWorkingTreeDiffStatsResult,
  GitRemoveIndexLockInput,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStageFilesInput,
  GitStageFilesResult,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStashInfoResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizeDiffInput,
  GitSummarizeDiffResult,
  GitUnstageFilesInput,
  GitUnstageFilesResult,
} from "./git";
import {
  PullRequestActionInput,
  PullRequestCommentInput,
  PullRequestActionResult,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestReviewRequestCountInput,
  PullRequestReviewRequestCountResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
  PullRequestsListInput,
  PullRequestsListResult,
  PullRequestsUnavailableError,
} from "./pullRequests";
import { KeybindingRule } from "./keybindings";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
  OrchestrationRpcSchemas,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
} from "./orchestration";
import { ProviderCompactThreadInput } from "./provider";
import {
  ProviderGetComposerCapabilitiesInput,
  ProviderComposerCapabilities,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillsCatalogInput,
  ProviderSkillsCatalogResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from "./providerDiscovery";
import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectListDevServersResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRunDevServerInput,
  ProjectRunDevServerResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  ProjectStopDevServerInput,
  ProjectStopDevServerResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerDiagnosticsResult,
  ServerGenerateAutomationIntentInput,
  ServerGenerateAutomationIntentResult,
  ServerGenerateThreadRecapInput,
  ServerGenerateThreadRecapResult,
  ServerGetEnvironmentResult,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerLifecycleStreamEvent,
  ServerGetSettingsResult,
  ServerListLocalServersResult,
  ServerListWorktreesResult,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerRefreshProvidersResult,
  ServerStopLocalServerInput,
  ServerStopLocalServerResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
  ServerUpsertKeybindingResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "./server";
import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import {
  StatsGetProfileStatsInput,
  StatsGetProfileStatsResult,
  StatsGetProfileTokenStatsInput,
  StatsGetProfileTokenStatsResult,
} from "./stats";
import { WS_METHODS } from "./ws";
import {
  WS_BOOTSTRAP_METHOD,
  WsBootstrapNegotiateInput,
  WsBootstrapNegotiateResult,
  WsCompatibilityError,
} from "./wsCompatibility";

export class WsRpcError extends Schema.TaggedErrorClass<WsRpcError>()("WsRpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

export const WsBootstrapNegotiateRpc = Rpc.make(WS_BOOTSTRAP_METHOD, {
  payload: WsBootstrapNegotiateInput,
  success: WsBootstrapNegotiateResult,
  error: WsCompatibilityError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationImportThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.importThread, {
  payload: OrchestrationImportThreadInput,
  success: OrchestrationImportThreadResult,
  error: WsRpcError,
});

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationRpcSchemas.getSnapshot.input,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: WsRpcError,
});

export const WsOrchestrationGetShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getShellSnapshot.input,
    success: OrchestrationRpcSchemas.getShellSnapshot.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationRepairStateRpc = Rpc.make(ORCHESTRATION_WS_METHODS.repairState, {
  payload: OrchestrationRpcSchemas.repairState.input,
  success: OrchestrationRpcSchemas.repairState.output,
  error: WsRpcError,
});

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationRpcSchemas.getTurnDiff.input,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: WsRpcError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationRpcSchemas.getFullThreadDiff.input,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationGetThreadDetailSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  {
    payload: OrchestrationRpcSchemas.getThreadDetailSnapshot.input,
    success: OrchestrationRpcSchemas.getThreadDetailSnapshot.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationRpcSchemas.replayEvents.input,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: WsRpcError,
});

export const WsOrchestrationListProviderDeliveryBlockersRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  {
    payload: OrchestrationRpcSchemas.listProviderDeliveryBlockers.input,
    success: OrchestrationRpcSchemas.listProviderDeliveryBlockers.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationReconcileProviderDeliveryRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
  {
    payload: OrchestrationRpcSchemas.reconcileProviderDelivery.input,
    success: OrchestrationRpcSchemas.reconcileProviderDelivery.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationShellStreamItem,
  error: WsRpcError,
  stream: true,
});

export const WsOrchestrationUnsubscribeShellRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.unsubscribeShell,
  {
    payload: OrchestrationRpcSchemas.unsubscribeShell.input,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationThreadStreamItem,
    error: WsRpcError,
    stream: true,
  },
);

export const WsOrchestrationSubscribeDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsOrchestrationUnsubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.unsubscribeThread,
  {
    payload: OrchestrationRpcSchemas.unsubscribeThread.input,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsProjectsListDirectoriesRpc = Rpc.make(WS_METHODS.projectsListDirectories, {
  payload: ProjectListDirectoriesInput,
  success: ProjectListDirectoriesResult,
  error: WsRpcError,
});

export const WsProjectsDiscoverScriptsRpc = Rpc.make(WS_METHODS.projectsDiscoverScripts, {
  payload: ProjectDiscoverScriptsInput,
  success: ProjectDiscoverScriptsResult,
  error: WsRpcError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: WsRpcError,
});

export const WsProjectsSearchLocalEntriesRpc = Rpc.make(WS_METHODS.projectsSearchLocalEntries, {
  payload: ProjectSearchLocalEntriesInput,
  success: ProjectSearchLocalEntriesResult,
  error: WsRpcError,
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: WsRpcError,
});

export const WsProjectsCreateLocalFilePreviewGrantRpc = Rpc.make(
  WS_METHODS.projectsCreateLocalFilePreviewGrant,
  {
    payload: ProjectCreateLocalFilePreviewGrantInput,
    success: ProjectCreateLocalFilePreviewGrantResult,
    error: WsRpcError,
  },
);

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: WsRpcError,
});

export const WsProjectsRunDevServerRpc = Rpc.make(WS_METHODS.projectsRunDevServer, {
  payload: ProjectRunDevServerInput,
  success: ProjectRunDevServerResult,
  error: WsRpcError,
});

export const WsProjectsStopDevServerRpc = Rpc.make(WS_METHODS.projectsStopDevServer, {
  payload: ProjectStopDevServerInput,
  success: ProjectStopDevServerResult,
  error: WsRpcError,
});

export const WsProjectsListDevServersRpc = Rpc.make(WS_METHODS.projectsListDevServers, {
  payload: Schema.Struct({}),
  success: ProjectListDevServersResult,
  error: WsRpcError,
});

export const WsSubscribeProjectDevServerEventsRpc = Rpc.make(
  WS_METHODS.subscribeProjectDevServerEvents,
  {
    payload: Schema.Struct({}),
    success: ProjectDevServerEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsStudioListThreadOutputsRpc = Rpc.make(WS_METHODS.studioListThreadOutputs, {
  payload: StudioListThreadOutputsInput,
  success: StudioListThreadOutputsResult,
  error: WsRpcError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: WsRpcError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStatusRpc = Rpc.make(WS_METHODS.gitStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: WsRpcError,
});

export const WsGitGithubRepositoryRpc = Rpc.make(WS_METHODS.gitGithubRepository, {
  payload: GitHubRepositoryInput,
  success: GitHubRepositoryResult,
  error: WsRpcError,
});

export const WsGitReadWorkingTreeDiffRpc = Rpc.make(WS_METHODS.gitReadWorkingTreeDiff, {
  payload: GitReadWorkingTreeDiffInput,
  success: GitReadWorkingTreeDiffResult,
  error: WsRpcError,
});

export const WsGitWorkingTreeDiffStatsRpc = Rpc.make(WS_METHODS.gitWorkingTreeDiffStats, {
  payload: GitReadWorkingTreeDiffInput,
  success: GitWorkingTreeDiffStatsResult,
  error: WsRpcError,
});

export const WsGitSummarizeDiffRpc = Rpc.make(WS_METHODS.gitSummarizeDiff, {
  payload: GitSummarizeDiffInput,
  success: GitSummarizeDiffResult,
  error: WsRpcError,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: WsRpcError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: WsRpcError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: WsRpcError,
});

export const WsGitPullRequestSnapshotRpc = Rpc.make(WS_METHODS.gitPullRequestSnapshot, {
  payload: GitPullRequestSnapshotInput,
  success: GitPullRequestSnapshotResult,
  error: WsRpcError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: WsRpcError,
});

const PullRequestsRpcError = Schema.Union([PullRequestsUnavailableError, WsRpcError]);

export const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestsListInput,
  success: PullRequestsListResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsReviewRequestCountRpc = Rpc.make(
  WS_METHODS.pullRequestsReviewRequestCount,
  {
    payload: PullRequestReviewRequestCountInput,
    success: PullRequestReviewRequestCountResult,
    error: PullRequestsRpcError,
  },
);

export const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestDetailInput,
  success: PullRequestDetail,
  error: PullRequestsRpcError,
});

export const WsPullRequestsDiffRpc = Rpc.make(WS_METHODS.pullRequestsDiff, {
  payload: PullRequestDetailInput,
  success: PullRequestDiffResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsActionRpc = Rpc.make(WS_METHODS.pullRequestsAction, {
  payload: PullRequestActionInput,
  success: PullRequestActionResult,
  error: PullRequestsRpcError,
});

// Comments reuse the action acknowledgment shape: the mutation is confirmed independently of
// the follow-up detail refetch that surfaces the new comment.
export const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: PullRequestActionResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsSetPinnedRpc = Rpc.make(WS_METHODS.pullRequestsSetPinned, {
  payload: PullRequestSetPinnedInput,
  success: PullRequestSetPinnedResult,
  error: WsRpcError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: WsRpcError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: WsRpcError,
});

export const WsGitCreateDetachedWorktreeRpc = Rpc.make(WS_METHODS.gitCreateDetachedWorktree, {
  payload: GitCreateDetachedWorktreeInput,
  success: GitCreateDetachedWorktreeResult,
  error: WsRpcError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStashAndCheckoutRpc = Rpc.make(WS_METHODS.gitStashAndCheckout, {
  payload: GitStashAndCheckoutInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStashDropRpc = Rpc.make(WS_METHODS.gitStashDrop, {
  payload: GitStashDropInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStashInfoRpc = Rpc.make(WS_METHODS.gitStashInfo, {
  payload: GitStashInfoInput,
  success: GitStashInfoResult,
  error: WsRpcError,
});

export const WsGitRemoveIndexLockRpc = Rpc.make(WS_METHODS.gitRemoveIndexLock, {
  payload: GitRemoveIndexLockInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStageFilesRpc = Rpc.make(WS_METHODS.gitStageFiles, {
  payload: GitStageFilesInput,
  success: GitStageFilesResult,
  error: WsRpcError,
});

export const WsGitUnstageFilesRpc = Rpc.make(WS_METHODS.gitUnstageFiles, {
  payload: GitUnstageFilesInput,
  success: GitUnstageFilesResult,
  error: WsRpcError,
});

export const WsGitHandoffThreadRpc = Rpc.make(WS_METHODS.gitHandoffThread, {
  payload: GitHandoffThreadInput,
  success: GitHandoffThreadResult,
  error: WsRpcError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: WsRpcError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalAckOutputRpc = Rpc.make(WS_METHODS.terminalAckOutput, {
  payload: TerminalAckOutputInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: WsRpcError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: WsRpcError,
  stream: true,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: WsRpcError,
});

export const WsServerGetEnvironmentRpc = Rpc.make(WS_METHODS.serverGetEnvironment, {
  payload: Schema.Struct({}),
  success: ServerGetEnvironmentResult,
  error: WsRpcError,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerGetSettingsResult,
  error: WsRpcError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: ServerUpdateSettingsInput,
  success: ServerUpdateSettingsResult,
  error: WsRpcError,
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerRefreshProvidersResult,
  error: WsRpcError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdateResult,
  error: ServerProviderUpdateError,
});

export const WsServerListExternalMcpIntegrationsRpc = Rpc.make(
  WS_METHODS.serverListExternalMcpIntegrations,
  {
    payload: Schema.Struct({}),
    success: Schema.Array(ExternalMcpIntegration),
    error: WsRpcError,
  },
);

export const WsServerCreateExternalMcpIntegrationRpc = Rpc.make(
  WS_METHODS.serverCreateExternalMcpIntegration,
  {
    payload: ExternalMcpCreateIntegrationInput,
    success: ExternalMcpCreateIntegrationResult,
    error: WsRpcError,
  },
);

export const WsServerRevokeExternalMcpIntegrationRpc = Rpc.make(
  WS_METHODS.serverRevokeExternalMcpIntegration,
  {
    payload: ExternalMcpRevokeIntegrationInput,
    success: Schema.Struct({ revoked: Schema.Boolean }),
    error: WsRpcError,
  },
);

export const WsServerRefreshExternalMcpPairingRpc = Rpc.make(
  WS_METHODS.serverRefreshExternalMcpPairing,
  {
    payload: ExternalMcpRefreshPairingInput,
    success: ExternalMcpCreateIntegrationResult,
    error: WsRpcError,
  },
);

export const WsServerListWorktreesRpc = Rpc.make(WS_METHODS.serverListWorktrees, {
  payload: Schema.Struct({}),
  success: ServerListWorktreesResult,
  error: WsRpcError,
});

export const WsServerListLocalServersRpc = Rpc.make(WS_METHODS.serverListLocalServers, {
  payload: Schema.Struct({}),
  success: ServerListLocalServersResult,
  error: WsRpcError,
});

export const WsServerStopLocalServerRpc = Rpc.make(WS_METHODS.serverStopLocalServer, {
  payload: ServerStopLocalServerInput,
  success: ServerStopLocalServerResult,
  error: WsRpcError,
});

export const WsServerGetProviderUsageSnapshotRpc = Rpc.make(
  WS_METHODS.serverGetProviderUsageSnapshot,
  {
    payload: ServerGetProviderUsageSnapshotInput,
    success: ServerGetProviderUsageSnapshotResult,
    error: WsRpcError,
  },
);

export const WsServerListProviderUsageRpc = Rpc.make(WS_METHODS.serverListProviderUsage, {
  payload: ServerListProviderUsageInput,
  success: ServerListProviderUsageResult,
  error: WsRpcError,
});

export const WsStatsGetProfileStatsRpc = Rpc.make(WS_METHODS.statsGetProfileStats, {
  payload: StatsGetProfileStatsInput,
  success: StatsGetProfileStatsResult,
  error: WsRpcError,
});

export const WsStatsGetProfileTokenStatsRpc = Rpc.make(WS_METHODS.statsGetProfileTokenStats, {
  payload: StatsGetProfileTokenStatsInput,
  success: StatsGetProfileTokenStatsResult,
  error: WsRpcError,
});

export const WsServerGetDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerDiagnosticsResult,
  error: WsRpcError,
});

export const WsServerTranscribeVoiceRpc = Rpc.make(WS_METHODS.serverTranscribeVoice, {
  payload: ServerVoiceTranscriptionInput,
  success: ServerVoiceTranscriptionResult,
  error: WsRpcError,
});

export const WsServerGenerateThreadRecapRpc = Rpc.make(WS_METHODS.serverGenerateThreadRecap, {
  payload: ServerGenerateThreadRecapInput,
  success: ServerGenerateThreadRecapResult,
  error: WsRpcError,
});

export const WsServerGenerateAutomationIntentRpc = Rpc.make(
  WS_METHODS.serverGenerateAutomationIntent,
  {
    payload: ServerGenerateAutomationIntentInput,
    success: ServerGenerateAutomationIntentResult,
    error: WsRpcError,
  },
);

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: KeybindingRule,
  success: ServerUpsertKeybindingResult,
  error: WsRpcError,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerProviderStatusesRpc = Rpc.make(
  WS_METHODS.subscribeServerProviderStatuses,
  {
    payload: Schema.Struct({}),
    success: ServerRefreshProvidersResult,
    error: WsRpcError,
    stream: true,
  },
);

export const WsSubscribeServerSettingsRpc = Rpc.make(WS_METHODS.subscribeServerSettings, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ settings: ServerGetSettingsResult }),
  error: WsRpcError,
  stream: true,
});

export const WsProviderGetComposerCapabilitiesRpc = Rpc.make(
  WS_METHODS.providerGetComposerCapabilities,
  {
    payload: ProviderGetComposerCapabilitiesInput,
    success: ProviderComposerCapabilities,
    error: WsRpcError,
  },
);

export const WsProviderCompactThreadRpc = Rpc.make(WS_METHODS.providerCompactThread, {
  payload: ProviderCompactThreadInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsProviderListCommandsRpc = Rpc.make(WS_METHODS.providerListCommands, {
  payload: ProviderListCommandsInput,
  success: ProviderListCommandsResult,
  error: WsRpcError,
});

export const WsProviderListSkillsRpc = Rpc.make(WS_METHODS.providerListSkills, {
  payload: ProviderListSkillsInput,
  success: ProviderListSkillsResult,
  error: WsRpcError,
});

export const WsProviderListSkillsCatalogRpc = Rpc.make(WS_METHODS.providerListSkillsCatalog, {
  payload: ProviderSkillsCatalogInput,
  success: ProviderSkillsCatalogResult,
  error: WsRpcError,
});

export const WsProviderListPluginsRpc = Rpc.make(WS_METHODS.providerListPlugins, {
  payload: ProviderListPluginsInput,
  success: ProviderListPluginsResult,
  error: WsRpcError,
});

export const WsProviderReadPluginRpc = Rpc.make(WS_METHODS.providerReadPlugin, {
  payload: ProviderReadPluginInput,
  success: ProviderReadPluginResult,
  error: WsRpcError,
});

export const WsProviderListModelsRpc = Rpc.make(WS_METHODS.providerListModels, {
  payload: ProviderListModelsInput,
  success: ProviderListModelsResult,
  error: WsRpcError,
});

export const WsProviderListAgentsRpc = Rpc.make(WS_METHODS.providerListAgents, {
  payload: ProviderListAgentsInput,
  success: ProviderListAgentsResult,
  error: WsRpcError,
});

export const WsAutomationListRpc = Rpc.make(WS_METHODS.automationList, {
  payload: AutomationListInput,
  success: AutomationListResult,
  error: WsRpcError,
});

export const WsAutomationGetMemoryRpc = Rpc.make(WS_METHODS.automationGetMemory, {
  payload: AutomationGetMemoryInput,
  success: Schema.NullOr(AutomationMemory),
  error: WsRpcError,
});

export const WsAutomationCreateRpc = Rpc.make(WS_METHODS.automationCreate, {
  payload: AutomationCreateInput,
  success: AutomationDefinition,
  error: WsRpcError,
});

export const WsAutomationUpdateRpc = Rpc.make(WS_METHODS.automationUpdate, {
  payload: AutomationUpdateInput,
  success: AutomationDefinition,
  error: WsRpcError,
});

export const WsAutomationDeleteRpc = Rpc.make(WS_METHODS.automationDelete, {
  payload: AutomationDeleteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsAutomationRunNowRpc = Rpc.make(WS_METHODS.automationRunNow, {
  payload: AutomationRunNowInput,
  success: AutomationRunNowResult,
  error: WsRpcError,
});

export const WsAutomationCancelRunRpc = Rpc.make(WS_METHODS.automationCancelRun, {
  payload: AutomationCancelRunInput,
  success: AutomationCancelRunResult,
  error: WsRpcError,
});

export const WsAutomationMarkRunReadRpc = Rpc.make(WS_METHODS.automationMarkRunRead, {
  payload: AutomationMarkRunReadInput,
  success: AutomationRunActionResult,
  error: WsRpcError,
});

export const WsAutomationArchiveRunRpc = Rpc.make(WS_METHODS.automationArchiveRun, {
  payload: AutomationArchiveRunInput,
  success: AutomationRunActionResult,
  error: WsRpcError,
});

export const WsAutomationResolveProposalRpc = Rpc.make(WS_METHODS.automationResolveProposal, {
  payload: AutomationResolveProposalInput,
  success: AutomationResolveProposalResult,
  error: WsRpcError,
});

export const WsSubscribeAutomationEventsRpc = Rpc.make(WS_METHODS.subscribeAutomationEvents, {
  payload: Schema.Struct({}),
  success: AutomationStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsBootstrapRpcGroup = RpcGroup.make(WsBootstrapNegotiateRpc);

export const WsFeatureRpcGroup = RpcGroup.make(
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationImportThreadRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetShellSnapshotRpc,
  WsOrchestrationGetThreadDetailSnapshotRpc,
  WsOrchestrationRepairStateRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationListProviderDeliveryBlockersRpc,
  WsOrchestrationReconcileProviderDeliveryRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationUnsubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationUnsubscribeThreadRpc,
  WsOrchestrationSubscribeDomainEventsRpc,
  WsProjectsDiscoverScriptsRpc,
  WsProjectsListDirectoriesRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsSearchLocalEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsCreateLocalFilePreviewGrantRpc,
  WsProjectsWriteFileRpc,
  WsProjectsRunDevServerRpc,
  WsProjectsStopDevServerRpc,
  WsProjectsListDevServersRpc,
  WsSubscribeProjectDevServerEventsRpc,
  WsStudioListThreadOutputsRpc,
  WsFilesystemBrowseRpc,
  WsShellOpenInEditorRpc,
  WsGitGithubRepositoryRpc,
  WsGitStatusRpc,
  WsGitReadWorkingTreeDiffRpc,
  WsGitWorkingTreeDiffStatsRpc,
  WsGitSummarizeDiffRpc,
  WsGitPullRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPullRequestSnapshotRpc,
  WsGitPreparePullRequestThreadRpc,
  WsPullRequestsListRpc,
  WsPullRequestsReviewRequestCountRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsDiffRpc,
  WsPullRequestsActionRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsSetPinnedRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitCreateDetachedWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitStashAndCheckoutRpc,
  WsGitStashDropRpc,
  WsGitStashInfoRpc,
  WsGitRemoveIndexLockRpc,
  WsGitInitRpc,
  WsGitStageFilesRpc,
  WsGitUnstageFilesRpc,
  WsGitHandoffThreadRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalAckOutputRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsServerGetConfigRpc,
  WsServerGetEnvironmentRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerListExternalMcpIntegrationsRpc,
  WsServerCreateExternalMcpIntegrationRpc,
  WsServerRevokeExternalMcpIntegrationRpc,
  WsServerRefreshExternalMcpPairingRpc,
  WsServerListWorktreesRpc,
  WsServerListLocalServersRpc,
  WsServerStopLocalServerRpc,
  WsServerGetProviderUsageSnapshotRpc,
  WsServerListProviderUsageRpc,
  WsStatsGetProfileStatsRpc,
  WsStatsGetProfileTokenStatsRpc,
  WsServerGetDiagnosticsRpc,
  WsServerTranscribeVoiceRpc,
  WsServerGenerateThreadRecapRpc,
  WsServerGenerateAutomationIntentRpc,
  WsServerUpsertKeybindingRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerProviderStatusesRpc,
  WsSubscribeServerSettingsRpc,
  WsProviderGetComposerCapabilitiesRpc,
  WsProviderCompactThreadRpc,
  WsProviderListCommandsRpc,
  WsProviderListSkillsRpc,
  WsProviderListSkillsCatalogRpc,
  WsProviderListPluginsRpc,
  WsProviderReadPluginRpc,
  WsProviderListModelsRpc,
  WsProviderListAgentsRpc,
  WsAutomationListRpc,
  WsAutomationGetMemoryRpc,
  WsAutomationCreateRpc,
  WsAutomationUpdateRpc,
  WsAutomationDeleteRpc,
  WsAutomationRunNowRpc,
  WsAutomationCancelRunRpc,
  WsAutomationMarkRunReadRpc,
  WsAutomationArchiveRunRpc,
  WsAutomationResolveProposalRpc,
  WsSubscribeAutomationEventsRpc,
);

/** @deprecated Use WsFeatureRpcGroup. Bootstrap is intentionally a separate endpoint/group. */
export const WsRpcGroup = WsFeatureRpcGroup;
