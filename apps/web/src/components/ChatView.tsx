import {
  type AutomationDefinition,
  type AutomationSchedule,
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type ModelSelection,
  type NativeApi,
  type OrchestrationShellSnapshot,
  type ProjectScript,
  type ModelSlug,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  type ProviderStartOptions,
  type ProviderUserInputAnswers,
  type PinnedMessage,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
  ThreadId,
  ThreadMarkerId,
  type ThreadMarker,
  type ThreadMarkerColor,
  type ThreadMarkerStyle,
  type TurnId,
  type EditorId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "@synara/contracts";
import { getModelCapabilities, normalizeModelSlug } from "@synara/shared/model";
import { resolveTailUserMessageEditTarget } from "@synara/shared/conversationEdit";
import { threadExportBlockedReason } from "@synara/shared/threadExport";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import {
  buildPromptThreadTitleFallback,
  GENERIC_CHAT_THREAD_TITLE,
} from "@synara/shared/chatThreads";
import {
  resolveThreadWorkspaceState,
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd,
} from "@synara/shared/threadEnvironment";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { GoTasklist } from "react-icons/go";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Debouncer, useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import { type LegendListRef } from "@legendapp/list/react";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitCreateDetachedWorktreeMutationOptions,
  gitGithubRepositoryQueryOptions,
  gitBranchesQueryOptions,
} from "~/lib/gitReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  providerComposerCapabilitiesQueryOptions,
  providerCommandsQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
  supportsThreadCompaction,
} from "~/lib/providerDiscoveryReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import {
  composerMentionPathNeedsQuoting,
  formatComposerMentionToken,
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  providerMentionReferencesEqual,
  providerSkillReferencesEqual,
  skillMentionPrefix,
} from "~/lib/composerMentions";
import { getLocalFolderBrowseRootPath, isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import {
  findProviderStatus,
  isProviderUsable,
  normalizeCustomBinaryPath,
  normalizeProviderStatusForLocalConfig,
  resolveProviderSendAvailabilityWithRefresh,
} from "~/lib/providerAvailability";
import {
  loadConfirmedCustomBinaryPaths,
  saveConfirmedCustomBinaryPaths,
} from "../confirmedCustomBinaryPathStore";
import { isElectron } from "../env";
import { isScrollContainerNearBottom } from "../chat-scroll";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { ensureHomeChatProject, isHomeChatContainerProject } from "../lib/chatProjects";
import { ensureStudioProject, isStudioContainerProject } from "../lib/studioProjects";
import { resolveFirstSendTarget } from "../lib/chatFirstSend";
import { readActiveSpaceId } from "../spacesUiStore";
import {
  createOrRecoverProjectFromPath,
  PROJECT_CREATE_EXISTING_SYNC_ERROR,
  PROJECT_CREATE_SYNC_ERROR,
} from "../lib/projectCreation";
import {
  maybeResolveBrowserPromptAttachment,
  type BrowserPromptAttachmentResolution,
} from "../lib/browserPromptContext";
import {
  buildComposerFileAttachmentsFromFiles,
  IMAGE_SIZE_LIMIT_LABEL,
  buildComposerImageAttachmentsFromFiles,
  stageUploadComposerAttachments,
  cloneComposerImageAttachment,
  effectiveComposerAttachmentCount,
  findPendingBlobComposerAttachments,
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
} from "../lib/composerSend";
import { composerImageBlobKey, persistComposerImageBlob } from "../lib/composerImageBlobStore";
import { reconcileDeletedThreadFromClient } from "../lib/deletedThreadClientReconciliation";
import { extractChatAutomationInvocation } from "../lib/automationIntent";
import {
  automationClarificationPrompt,
  buildComposerAutomationDraft,
  resolveComposerAutomationRequest,
} from "../lib/composerAutomation";
import {
  acknowledgedRiskIdsForDraft,
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "../lib/automationDraft";
import { dispatchThreadRename } from "../lib/threadRename";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useComposerDropzone } from "../hooks/useComposerDropzone";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import {
  buildThreadBreadcrumbs,
  buildTranscriptAutoFollowSignal,
  derivePromptHistoryFromMessages,
  enrichSubagentWorkEntries,
  hasFileUndoSettled,
  promptStillMatchesActiveHistoryBrowse,
  type PendingFileUndo,
  type PromptHistoryNavigationState,
  resolveActiveThreadTitle,
  resolveActiveTurnLiveDiffState,
  resolveCommittedProviderModel,
  resolveCycledModelSlug,
  resolveDefaultEnvironmentPanelOpen,
  resolveEnvironmentPanelOpen,
  resolveEnvironmentPanelPreferenceAfterFirstSend,
  resolveEnvironmentPanelPreferenceUpdate,
  resolveEnvironmentPanelVisible,
  resolveGitRepoUiState,
  resolveProjectScriptTerminalTarget,
  resolvePromptHistoryNavigation,
  shouldHandlePromptHistoryNavigationKey,
  shouldEnableComposerPastedTextCollapse,
  shouldConsumePendingCustomBinaryConfirmation,
  shouldShowComposerModelBootstrapSkeleton,
} from "./ChatView.logic";
import {
  createRelevantWorkLogThreadsSelector,
  createThreadLineageSelector,
  localSubagentThreadId,
} from "./ChatView.selectors";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  stripComposerTriggerText,
} from "../composer-logic";
import {
  ensureLeadingSpaceForReplacement,
  extendReplacementRangeForTrailingSpace,
} from "../composerTriggerInsertion";
import {
  createProjectSelector,
  createComposerThreadMentionSourcesSelector,
  createThreadSelector,
} from "../storeSelectors";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import {
  canOfferForkSlashCommand,
  canOfferSideSlashCommand,
  canOfferReviewSlashCommand,
  hasProviderNativeSlashCommand,
  providerSupportsTextNativeReviewCommand,
  resolveComposerSlashRootBranch,
} from "../composerSlashCommands";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActiveTaskListState,
  deriveActiveBackgroundTasksState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  buildSourceProposedPlanReference,
  hasActionableProposedPlan,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
  type ActiveTaskListState,
} from "../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  hasCompletePendingUserInputAnswers,
  omitNullPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { getThreadFromState } from "../threadDerivation";
import { useWorkspaceStore } from "../workspaceStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { truncateTitle } from "../truncateTitle";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  type ChatMessage,
  type Thread,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useThreadWorkspaceHandoff } from "../hooks/useThreadWorkspaceHandoff";
import {
  buildSearchableModelOptions,
  useComposerCommandMenuItems,
} from "../hooks/useComposerCommandMenuItems";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar, { RuntimeUsageControls } from "./BranchToolbar";
import { SynaraLogo } from "./SynaraLogo";
import { ThreadWorktreeHandoffDialog } from "./ThreadWorktreeHandoffDialog";
import {
  formatShortcutLabel,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import TerminalWorkspaceTabs from "./TerminalWorkspaceTabs";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  ChevronDownIcon,
  ComposerSendArrowIcon,
  LayoutSidebarIcon,
  RefreshCwIcon,
  TemporaryThreadIcon,
} from "~/lib/icons";
import { ComposerQueuedHeader } from "./chat/ComposerQueuedHeader";
import { ComposerLiveChangesHeader } from "./chat/ComposerLiveChangesHeader";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";
import { randomTerminalId } from "./terminal/terminalSession";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
  type ProjectScriptRunOptions,
  type ProjectScriptRunResult,
} from "~/projectScripts";
import { runProjectCommandInTerminal } from "~/projectTerminalRunner";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { readFavoriteModelSlugs } from "~/lib/modelFavorites";
import {
  getCustomBinaryPathForProvider,
  getProviderStartOptions,
  resolveAppModelSelection,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "../appSettings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableEventTarget } from "../lib/editableEventTarget";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerAssistantSelectionAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  type QueuedComposerChatTurn,
  type QueuedComposerPlanFollowUp,
  type QueuedComposerTurn,
  type RestoredComposerSourceProposedPlan,
  captureComposerPromptHistorySavedDraft,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../composerDraftStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import { useWorkflowRunUiStore, useWorkflowRunUiThreadState } from "../workflowRunUiStore";
import { appendComposerPromptText } from "../lib/chatReferences";
import {
  appendOriginalComposerPromptBlocks,
  appendTerminalContextsToPrompt,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  syncTerminalContextsByIds,
  terminalContextIdListsEqual,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendPastedTextsToPrompt,
  createPastedTextDraft,
  pastedTextTitle,
  type PastedTextDraft,
} from "../lib/composerPastedText";
import {
  appendAssistantSelectionsToPrompt,
  formatAssistantSelectionQueuePreview,
  formatAssistantSelectionTitleSeed,
} from "../lib/assistantSelections";
import {
  appendFileCommentsToPrompt,
  formatFileCommentLabel,
  formatFileCommentTitleSeed,
  type FileCommentDraft,
} from "../lib/fileComments";
import {
  deriveContextWindowSelectionStatus,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowSnapshot,
  deriveSelectedContextWindowSnapshot,
} from "../lib/contextWindow";
import { useComposerVoiceController } from "./chat/useComposerVoiceController";
import {
  composerFooterPlanForTier,
  resolveNextComposerFooterTier,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  resolveSplitViewFocusedThreadId,
  selectSplitView,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../splitViewStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { ChatHeader } from "./chat/ChatHeader";
import { dispatchThreadNotes } from "~/pinnedMessages";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import {
  ENVIRONMENT_DOCKED_CONTENT_INSET_PX,
  EnvironmentPanel,
  type EnvironmentPanelProps,
} from "./chat/environment/EnvironmentPanel";
import { usePinnedMessageActions } from "./chat/environment/usePinnedMessageActions";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
} from "./chat/chatHeaderControls";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { SidebarHeaderTrigger } from "./ui/sidebar";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useNowMs } from "~/hooks/useNowMs";
import { useThreadRecap } from "~/hooks/useThreadRecap";
import { useRepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { useIsMobile } from "~/hooks/useMediaQuery";
import {
  acknowledgedRiskIdsForFormWarnings,
  AutomationDialog,
  automationQueryKey,
  createInputFromForm,
  formatCadence,
  heartbeatAutomationsForThread,
  isFormSubmittable,
  providerOptionsForAutomationEdit,
  projectModelSelection as automationProjectModelSelection,
  type AutomationFormState,
  updateInputFromForm,
} from "../routes/-automations.shared";
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import type { MessagesTimelineController } from "./chat/MessagesTimeline";
import { buildTurnDiffSummaryByAssistantMessageId } from "./chat/MessagesTimeline.logic";
import { deriveAgentActivityTimelineState } from "./chat/agentActivity.logic";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  ProviderModelPicker,
  resolveProviderModelLabel,
} from "./chat/ProviderModelPicker";
import { ComposerModelEffortPicker } from "./chat/ComposerModelEffortPicker";
import { resolveTraitsTriggerSummary, TraitsPicker } from "./chat/TraitsPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { ComposerInputBanners } from "./chat/ComposerInputBanners";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerVoiceButton } from "./chat/ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "./chat/ComposerVoiceRecorderBar";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import { ExpandedImageOverlay } from "./chat/ExpandedImageOverlay";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { useChatTerminalController } from "./chat/useChatTerminalController";
import { useChatAutomationSetup } from "./chat/useChatAutomationSetup";
import { ComposerActiveTaskListCard } from "./chat/ComposerActiveTaskListCard";
import { ComposerSubagentStrip } from "./chat/ComposerSubagentStrip";
import {
  collectForegroundRunningSubagentStripItems,
  collectRunningSubagentStripItems,
  deriveComposerSubagentStripItems,
  type ComposerSubagentStripItem,
} from "./chat/ComposerSubagentStrip.logic";
import {
  deriveSubagentToolTraceByThreadId,
  type SubagentToolTrace,
} from "./chat/subagentToolTrace.logic";
import { WorkflowRunCard } from "./chat/WorkflowRunCard";
import {
  buildWorkflowResumePrompt,
  deriveWorkflowRunState,
  type WorkflowSubagentThreadRef,
} from "./chat/WorkflowRunCard.logic";
import { ComposerColumnFrame } from "./chat/ComposerColumnFrame";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
import { resolveTranscriptMarkerRange } from "./chat/chatSelectionActions";
import {
  dispatchThreadMarkerAdd,
  dispatchThreadMarkerDoneSet,
  dispatchThreadMarkerLabelSet,
  dispatchThreadMarkerRemove,
} from "../threadMarkers";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./chat/composerPickerStyles";
import { getComposerTraitSelection } from "./chat/composerTraits";
import { resolveRuntimeModelDescriptor } from "./chat/runtimeModelCapabilities";
import { ProjectPicker } from "./chat/ProjectPicker";
import { FolderClosed } from "./FolderClosed";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  RateLimitBanner,
  deriveLatestRateLimitStatus,
  type RateLimitStatus,
} from "./chat/RateLimitBanner";
import {
  ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS,
  appendVoiceTranscriptToPrompt,
  shouldStartActiveTurnLayoutGrace,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
  DismissedProviderHealthBannersSchema,
  collectUserMessageBlobPreviewUrls,
  deriveComposerSendState,
  failWorktreeSetupSnapshot,
  filterSidechatTranscriptMessages,
  hasServerAcknowledgedLocalDispatch,
  resolveNextLocalDispatchSnapshot,
  WORKTREE_SETUP_ERROR_HOLD_MS,
  worktreeSetupHasError,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  type WorktreeSetupDispatchOptions,
  PullRequestDialogState,
  type QueuedSteerGate,
  resolveQueuedSteerGateTransition,
  shouldRenderProviderHealthBanner,
  resolveRuntimeModeAfterApprovalDecision,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import { useFeatureFlags } from "../featureFlags";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import {
  resolveDiffEnvironmentState,
  resolveThreadEnvironmentMode,
} from "../lib/threadEnvironment";
import { buildModelSelection, buildNextProviderOptions } from "../providerModelOptions";
import {
  isDuplicateProjectCreateError,
  waitForRecoverableProjectForDuplicateCreate,
} from "../lib/projectCreateRecovery";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PINNED_MESSAGES: readonly PinnedMessage[] = [];
const EMPTY_THREAD_MARKERS: readonly ThreadMarker[] = [];
const EMPTY_PINNED_TEXT: ReadonlyMap<MessageId, string> = new Map();
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
const EMPTY_SUBAGENT_TOOL_TRACES: ReadonlyMap<string, SubagentToolTrace> = new Map();
const LOCAL_PROJECT_DRAFT_CONTEXT = {
  envMode: "local",
  worktreePath: null,
  branch: null,
  lastKnownPr: null,
} as const;
const DRAFT_PROJECT_SYNC_MAX_ATTEMPTS = 6;
const DRAFT_PROJECT_SYNC_DELAY_MS = 50;
const SETUP_SCRIPT_TERMINAL_ACTIVITY_START_TIMEOUT_MS = 1_000;
const SETUP_SCRIPT_TERMINAL_MAX_RUNTIME_MS = 10 * 60 * 1000;

function terminalHasRunningSubprocess(threadId: ThreadId, terminalId: string): boolean {
  const terminalState = selectThreadTerminalState(
    useTerminalStateStore.getState().terminalStateByThreadId,
    threadId,
  );
  return terminalState.runningTerminalIds.includes(terminalId);
}

function waitForSetupScriptTerminalActivity(input: {
  threadId: ThreadId;
  terminalId: string;
  observeStartTimeoutMs?: number;
  maxRuntimeMs?: number;
}): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  const observeStartTimeoutMs =
    input.observeStartTimeoutMs ?? SETUP_SCRIPT_TERMINAL_ACTIVITY_START_TIMEOUT_MS;
  const maxRuntimeMs = input.maxRuntimeMs ?? SETUP_SCRIPT_TERMINAL_MAX_RUNTIME_MS;

  return new Promise((resolve) => {
    let resolved = false;
    let observedRunning = terminalHasRunningSubprocess(input.threadId, input.terminalId);
    let observeStartTimer: number | null = null;
    let maxRuntimeTimer: number | null = null;

    const unsubscribe = useTerminalStateStore.subscribe(() => {
      checkRunningState();
    });

    const clearTimers = () => {
      if (observeStartTimer !== null) {
        window.clearTimeout(observeStartTimer);
        observeStartTimer = null;
      }
      if (maxRuntimeTimer !== null) {
        window.clearTimeout(maxRuntimeTimer);
        maxRuntimeTimer = null;
      }
    };

    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      unsubscribe();
      resolve();
    };

    const ensureMaxRuntimeTimer = () => {
      if (maxRuntimeTimer !== null) return;
      maxRuntimeTimer = window.setTimeout(finish, maxRuntimeMs);
    };

    function checkRunningState() {
      const running = terminalHasRunningSubprocess(input.threadId, input.terminalId);
      if (running) {
        observedRunning = true;
        if (observeStartTimer !== null) {
          window.clearTimeout(observeStartTimer);
          observeStartTimer = null;
        }
        ensureMaxRuntimeTimer();
        return;
      }
      if (observedRunning) {
        finish();
      }
    }

    checkRunningState();
    if (!observedRunning) {
      observeStartTimer = window.setTimeout(finish, observeStartTimeoutMs);
    }
  });
}

function waitForDraftProjectSyncDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// Waits for a project to appear in the shell snapshot before a local draft points at it.
async function waitForShellProjectById(
  api: NativeApi,
  projectId: ProjectId,
): Promise<{
  project: OrchestrationShellSnapshot["projects"][number] | null;
  snapshot: OrchestrationShellSnapshot | null;
}> {
  let latestSnapshot: OrchestrationShellSnapshot | null = null;
  for (let attempt = 1; attempt <= DRAFT_PROJECT_SYNC_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
    if (snapshot) {
      latestSnapshot = snapshot;
      const project = snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (project) {
        return { project, snapshot };
      }
    }
    if (attempt < DRAFT_PROJECT_SYNC_MAX_ATTEMPTS) {
      await waitForDraftProjectSyncDelay(DRAFT_PROJECT_SYNC_DELAY_MS * attempt);
    }
  }
  return { project: null, snapshot: latestSnapshot };
}

function automationScheduleActivityPayload(schedule: AutomationSchedule) {
  switch (schedule.type) {
    case "manual":
      return { type: "manual" } as const;
    case "once":
      return { type: "once", runAt: schedule.runAt } as const;
    case "interval":
      return { type: "interval", everySeconds: schedule.everySeconds } as const;
    case "daily":
      return schedule.timezone
        ? { type: "daily", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone }
        : { type: "daily", timeOfDay: schedule.timeOfDay };
    case "weekdays":
      return schedule.timezone
        ? { type: "weekdays", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone }
        : { type: "weekdays", timeOfDay: schedule.timeOfDay };
    case "weekly":
      return schedule.timezone
        ? {
            type: "weekly",
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
            timezone: schedule.timezone,
          }
        : {
            type: "weekly",
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
          };
    case "cron":
      return {
        type: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      } as const;
  }
}

function revokeBlobPreviewUrlsAfterPaint(previewUrls: readonly string[]): void {
  if (previewUrls.length === 0 || typeof window === "undefined") {
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }, 0);
  });
}

// Shared by the live-composer and prompt-history attachment sync effects:
// AppSnap images persist their bytes as IndexedDB blobs (reusing an existing
// blob key when valid), everything else inlines a data URL. Falls back to the
// already-persisted attachments for images whose serialization fails.
async function stagePersistedComposerImageAttachments(input: {
  threadId: ThreadId;
  images: ReadonlyArray<ComposerImageAttachment>;
  getPersistedAttachments: () => PersistedComposerImageAttachment[];
}): Promise<PersistedComposerImageAttachment[]> {
  try {
    const existingPersistedById = new Map(
      input.getPersistedAttachments().map((attachment) => [attachment.id, attachment]),
    );
    const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
    await Promise.all(
      input.images.map(async (image) => {
        try {
          if (image.source?.kind === "appsnap") {
            const existingPersisted = existingPersistedById.get(image.id);
            const expectedBlobKey = composerImageBlobKey(input.threadId, image.id);
            const blobKey =
              existingPersisted?.blobKey === expectedBlobKey
                ? expectedBlobKey
                : await persistComposerImageBlob({
                    threadId: input.threadId,
                    imageId: image.id,
                    file: image.file,
                  });
            stagedAttachmentById.set(image.id, {
              id: image.id,
              name: image.name,
              mimeType: image.mimeType,
              sizeBytes: image.sizeBytes,
              blobKey,
              source: image.source,
            });
            return;
          }
          const dataUrl = await readFileAsDataUrl(image.file);
          stagedAttachmentById.set(image.id, {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          });
        } catch {
          const existingPersisted = existingPersistedById.get(image.id);
          if (existingPersisted) {
            stagedAttachmentById.set(image.id, existingPersisted);
          }
        }
      }),
    );
    return Array.from(stagedAttachmentById.values());
  } catch {
    const currentImageIds = new Set(input.images.map((image) => image.id));
    return input
      .getPersistedAttachments()
      .filter((attachment) => currentImageIds.has(attachment.id));
  }
}

function eventTargetsComposer(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  const target = event.target;
  return target instanceof Node ? composerForm.contains(target) : false;
}

function canHandleComposerPickerShortcut(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  if (eventTargetsComposer(event, composerForm)) return true;
  const target = event.target;
  return (
    target === document.body ||
    target === document.documentElement ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const MAX_DISMISSED_PROVIDER_HEALTH_BANNERS = 50;
const EMPTY_LAST_INVOKED_SCRIPT_BY_PROJECT: Record<string, string> = {};
const EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS: ReadonlyArray<string> = [];

function getThreadProviderCustomBinaryPathKey(threadId: Thread["id"], provider: ProviderKind) {
  return `${threadId}:${provider}`;
}

function getConfirmedCustomBinarySessionKey(
  thread: Thread | null | undefined,
  provider: ProviderKind,
): string | null {
  const session = thread?.session;
  if (!thread || session?.provider !== provider) {
    return null;
  }
  if (session.status !== "ready" && session.status !== "running") {
    return null;
  }
  return getThreadProviderCustomBinaryPathKey(thread.id, provider);
}

function getProviderStartOptionsCustomBinaryPath(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): string | null {
  switch (provider) {
    case "codex":
      return normalizeCustomBinaryPath(providerOptions?.codex?.binaryPath);
    case "claudeAgent":
      return normalizeCustomBinaryPath(providerOptions?.claudeAgent?.binaryPath);
    case "antigravity":
      return normalizeCustomBinaryPath(providerOptions?.antigravity?.binaryPath);
    case "grok":
      return normalizeCustomBinaryPath(providerOptions?.grok?.binaryPath);
    case "droid":
      return normalizeCustomBinaryPath(providerOptions?.droid?.binaryPath);
    case "kilo":
      return normalizeCustomBinaryPath(providerOptions?.kilo?.binaryPath);
    case "opencode":
      return normalizeCustomBinaryPath(providerOptions?.opencode?.binaryPath);
    case "cursor":
      return normalizeCustomBinaryPath(providerOptions?.cursor?.binaryPath);
    case "pi":
      return normalizeCustomBinaryPath(providerOptions?.pi?.binaryPath);
  }
}

function getProviderHealthBannerDismissalKey(status: ServerProviderStatus | null): string | null {
  if (!status || status.status === "ready") {
    return null;
  }
  return [
    status.provider,
    status.status,
    status.available ? "available" : "unavailable",
    status.authStatus,
    status.message?.trim() ?? "",
  ].join("\u001f");
}

function getRateLimitBannerDismissalKey(
  status: RateLimitStatus | null,
  threadId: Thread["id"] | null,
): string | null {
  if (!status || !threadId) {
    return null;
  }
  return [
    threadId,
    status.status,
    status.resetsAt ?? "",
    typeof status.utilization === "number" ? String(Math.round(status.utilization * 100)) : "",
  ].join("\u001f");
}

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];

function buildQueuedComposerPreviewText(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files: ReadonlyArray<ComposerFileAttachment>;
  assistantSelections: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  pastedTexts: ReadonlyArray<PastedTextDraft>;
}): string {
  if (input.trimmedPrompt.length > 0) {
    return input.trimmedPrompt;
  }
  const firstImage = input.images[0];
  if (firstImage) {
    return `Image: ${firstImage.name}`;
  }
  const firstFile = input.files[0];
  if (firstFile) {
    return `File: ${firstFile.name}`;
  }
  if (input.assistantSelections.length > 0) {
    return formatAssistantSelectionQueuePreview(input.assistantSelections.length);
  }
  const firstTerminalContext = input.terminalContexts[0];
  if (firstTerminalContext) {
    return formatTerminalContextLabel(firstTerminalContext);
  }
  const firstFileComment = input.fileComments[0];
  if (firstFileComment) {
    return formatFileCommentLabel(firstFileComment);
  }
  const pastedTitle = formatPastedTextTitleSeed(input.pastedTexts);
  if (pastedTitle) {
    return pastedTitle;
  }
  return "Queued follow-up";
}

function formatPastedTextTitleSeed(pastedTexts: ReadonlyArray<PastedTextDraft>): string | null {
  const firstPastedText = pastedTexts[0];
  if (!firstPastedText) {
    return null;
  }
  return pastedTexts.length === 1
    ? pastedTextTitle(firstPastedText.text)
    : `${pastedTexts.length} pasted texts`;
}

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const VOICE_RECORDER_ACTION_ARM_DELAY_MS = 250;

function warnVoiceGuard(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }
  if (details) {
    console.warn(`[voice] ${event}`, details);
    return;
  }
  console.warn(`[voice] ${event}`);
}

function ComposerControlSkeleton(props: { widthClassName: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md border border-border/50 px-2",
        props.widthClassName,
      )}
    >
      <Skeleton className="h-3.5 w-full rounded-full" />
    </div>
  );
}

function ComposerModelLoadingControl(props: { widthClassName: string }) {
  return (
    <div
      aria-label="Loading models"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md border border-border/50 px-2 text-muted-foreground",
        props.widthClassName,
      )}
    >
      <RefreshCwIcon aria-hidden="true" className="size-3.5 animate-spin" />
      <span className="truncate text-[length:var(--app-font-size-ui-xs,11px)]">Loading models</span>
    </div>
  );
}

interface ChatViewProps {
  threadId: ThreadId;
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  presentationMode?: "default" | "editor";
  isFocusedPane?: boolean;
  panelState?: SplitViewPanePanelState;
  onToggleDiffPanel?: () => void;
  onToggleBrowserPanel?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenTurnDiffPanel?: (turnId: TurnId, filePath?: string) => void;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
  viewModeAction?: {
    label: string;
    active: boolean;
    onClick: () => void;
  } | null;
  onChangeThreadInSplitPane?: () => void;
  onCloseThreadPane?: () => void;
}

function normalizeRestoredQueuedPrompt(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function composerPromptStillMatchesRestoredQueuedDraft(
  restoredPrompt: string,
  nextPrompt: string,
): boolean {
  const restored = normalizeRestoredQueuedPrompt(restoredPrompt);
  const next = normalizeRestoredQueuedPrompt(nextPrompt);
  if (next.length === 0) {
    return false;
  }
  if (restored.length === 0) {
    return true;
  }
  if (next.includes(restored)) {
    return true;
  }
  if (next.length >= Math.min(16, restored.length) && restored.includes(next)) {
    return true;
  }
  const probe = restored.slice(0, Math.min(48, restored.length));
  return probe.length >= 16 && next.includes(probe);
}

// Builds an ephemeral transcript bubble for the conversational automation-setup
// exchange. These never reach a provider and are not persisted; they render the
// back-and-forth (user request, Synara's clarifying questions) inline like Codex.
function makeAutomationSetupBubble(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: newMessageId(),
    role,
    text,
    createdAt: new Date().toISOString(),
    streaming: false,
    source: "native",
  };
}

export default function ChatView({
  threadId,
  paneScopeId = SINGLE_CHAT_PANE_SCOPE_ID,
  surfaceMode = "single",
  presentationMode = "default",
  isFocusedPane = true,
  panelState,
  onToggleDiffPanel,
  onToggleBrowserPanel,
  onOpenBrowserUrl,
  onOpenTurnDiffPanel,
  onSplitSurface,
  onMaximizeSurface,
  viewModeAction = null,
  onChangeThreadInSplitPane,
  onCloseThreadPane,
}: ChatViewProps) {
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const { settings, updateSettings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const setComposerDraftModelSelectionAndSticky = useComposerDraftStore(
    (store) => store.setModelSelectionAndSticky,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { createThreadHandoff } = useThreadHandoff();
  const rawSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(rawSearch.splitViewId ?? null), [rawSearch.splitViewId]),
  );
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(
    gitCreateDetachedWorktreeMutationOptions({ queryClient }),
  );
  const isEditorRail = presentationMode === "editor";
  const isInactiveSplitPane = surfaceMode === "split" && !isFocusedPane;
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerPromptHistorySavedDraft = composerDraft.promptHistorySavedDraft;
  const composerPromptHistorySavedDraftImages = composerPromptHistorySavedDraft?.images ?? null;
  const composerImages = composerDraft.images;
  const composerFiles = composerDraft.files;
  const composerAssistantSelections = composerDraft.assistantSelections;
  const composerFileComments = composerDraft.fileComments;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPastedTexts = composerDraft.pastedTexts;
  const composerSkills = composerDraft.skills;
  const composerMentions = composerDraft.mentions;
  const queuedComposerTurns = composerDraft.queuedTurns;
  const restoredSourceProposedPlan = composerDraft.restoredSourceProposedPlan;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        fileCount: composerFiles.length,
        assistantSelectionCount: composerAssistantSelections.length,
        fileCommentCount: composerFileComments.length,
        terminalContexts: composerTerminalContexts,
        pastedTexts: composerPastedTexts,
      }),
    [
      composerAssistantSelections.length,
      composerFileComments.length,
      composerFiles.length,
      composerImages.length,
      composerTerminalContexts,
      composerPastedTexts,
      prompt,
    ],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const durablyPersistedComposerImageIds = composerDraft.persistedAttachments;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftPromptHistorySavedDraft = useComposerDraftStore(
    (store) => store.setPromptHistorySavedDraft,
  );
  const restoreComposerDraftPromptHistorySavedDraft = useComposerDraftStore(
    (store) => store.restorePromptHistorySavedDraft,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftProviderModelOptions = useComposerDraftStore(
    (store) => store.setProviderModelOptions,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const enqueueQueuedComposerTurn = useComposerDraftStore((store) => store.enqueueQueuedTurn);
  const insertQueuedComposerTurn = useComposerDraftStore((store) => store.insertQueuedTurn);
  const removeQueuedComposerTurnFromDraft = useComposerDraftStore(
    (store) => store.removeQueuedTurn,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const addComposerDraftAssistantSelection = useComposerDraftStore(
    (store) => store.addAssistantSelection,
  );
  const clearComposerDraftAssistantSelections = useComposerDraftStore(
    (store) => store.clearAssistantSelections,
  );
  const addComposerDraftFileComment = useComposerDraftStore((store) => store.addFileComment);
  const clearComposerDraftFileComments = useComposerDraftStore((store) => store.clearFileComments);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const addComposerDraftPastedTexts = useComposerDraftStore((store) => store.addPastedTexts);
  const removeComposerDraftPastedText = useComposerDraftStore((store) => store.removePastedText);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftSkills = useComposerDraftStore((store) => store.setSkills);
  const setComposerDraftMentions = useComposerDraftStore((store) => store.setMentions);
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const syncComposerDraftPromptHistorySavedDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPromptHistorySavedDraftPersistedAttachments,
  );
  const setComposerDraftRestoredSourceProposedPlan = useComposerDraftStore(
    (store) => store.setRestoredSourceProposedPlan,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const moveDraftThreadToProject = useComposerDraftStore((store) => store.moveDraftThreadToProject);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const hasTemporaryThreadMarker = useTemporaryThreadStore((store) =>
    threadId ? store.temporaryThreadIds[threadId] === true : false,
  );
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const markWorkflowRunPaused = useWorkflowRunUiStore((store) => store.markPaused);
  const markWorkflowRunDismissed = useWorkflowRunUiStore((store) => store.markDismissed);
  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const composerThreadSummaries = useStore(
    useMemo(() => createComposerThreadMentionSourcesSelector(), []),
  );
  const composerThreadProjects = useStore((state) => state.projects);
  const crossTaskSourceThreadId =
    serverThread?.creationSource && serverThread.sourceThreadId
      ? serverThread.sourceThreadId
      : null;
  const crossTaskSourceThread = useStore(
    useMemo(() => createThreadSelector(crossTaskSourceThreadId), [crossTaskSourceThreadId]),
  );
  const crossTaskOrigin = useMemo(
    () =>
      crossTaskSourceThreadId
        ? {
            sourceThreadId: crossTaskSourceThreadId,
            sourceProvider: crossTaskSourceThread?.modelSelection.provider ?? null,
          }
        : null,
    [crossTaskSourceThread?.modelSelection.provider, crossTaskSourceThreadId],
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  // Mirror during the commit, before events or async continuations can observe
  // the new UI with the previous render's preview URLs.
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);
  const composerAssistantSelectionsRef = useRef<ComposerAssistantSelectionAttachment[]>(
    composerAssistantSelections,
  );
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const composerFileCommentsRef = useRef<FileCommentDraft[]>(composerFileComments);
  const composerPastedTextsRef = useRef<PastedTextDraft[]>(composerPastedTexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const failedWorktreeSetupDispatchStartedAtRef = useRef<string | null>(null);
  const [isLocalConnecting, _setIsLocalConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [pendingFileUndo, setPendingFileUndo] = useState<PendingFileUndo | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [respondingRequestKeys, setRespondingRequestKeys] = useState<string[]>([]);
  const [respondingUserInputRequestKeys, setRespondingUserInputRequestKeys] = useState<string[]>(
    [],
  );
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const pendingUserInputAnswersByRequestIdRef = useRef(pendingUserInputAnswersByRequestId);
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [activeTaskListCompact, setActiveTaskListCompact] = useState(false);
  const [subagentStripCompact, setSubagentStripCompact] = useState(false);
  const [workflowRunCardCompact, setWorkflowRunCardCompact] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Width-aware visibility for the footer picker cluster (context meter,
  // model name, traits label). Inputs live in a ref so the resize observer
  // can re-plan without re-subscribing; the sync function is exposed via ref
  // so label changes can re-plan without a resize.
  const [composerFooterTier, setComposerFooterTier] = useState(0);
  const composerFooterTierRef = useRef(0);
  const composerFooterDemotionWidthsRef = useRef<ReadonlyArray<number | undefined>>([]);
  const composerFooterLayoutSyncRef = useRef<(() => void) | null>(null);
  const [confirmedCustomBinaryPathsByProvider, setConfirmedCustomBinaryPathsByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >(loadConfirmedCustomBinaryPaths);
  const confirmedCustomBinarySessionKeysRef = useRef<Set<string>>(new Set());
  const pendingCustomBinaryPathsByThreadProviderRef = useRef<Map<string, string>>(new Map());
  const [composerCommandPicker, setComposerCommandPicker] = useState<
    null | "fork-target" | "review-target"
  >(null);
  const [secondaryChromePlaceholderHeight, setSecondaryChromePlaceholderHeight] = useState(88);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [selectedComposerSkills, setSelectedComposerSkills] = useState<ProviderSkillReference[]>(
    () => composerSkills,
  );
  const [selectedComposerMentions, setSelectedComposerMentions] = useState<
    ProviderMentionReference[]
  >(() => composerMentions);
  const selectedComposerSkillsRef = useRef<ProviderSkillReference[]>(selectedComposerSkills);
  const selectedComposerMentionsRef = useRef<ProviderMentionReference[]>(selectedComposerMentions);
  // The setters below stamp these refs synchronously; layout effects backstop
  // external state changes before another browser event can read stale values.
  useLayoutEffect(() => {
    selectedComposerSkillsRef.current = selectedComposerSkills;
  }, [selectedComposerSkills]);
  useLayoutEffect(() => {
    selectedComposerMentionsRef.current = selectedComposerMentions;
  }, [selectedComposerMentions]);
  const updateSelectedComposerSkills = useCallback(
    (
      next:
        | ProviderSkillReference[]
        | ((existing: ProviderSkillReference[]) => ProviderSkillReference[]),
    ) => {
      const existing = selectedComposerSkillsRef.current;
      const resolved = typeof next === "function" ? next(existing) : next;
      selectedComposerSkillsRef.current = resolved;
      setSelectedComposerSkills(resolved);
      setComposerDraftSkills(threadId, resolved);
    },
    [setComposerDraftSkills, threadId],
  );
  const updateSelectedComposerMentions = useCallback(
    (
      next:
        | ProviderMentionReference[]
        | ((existing: ProviderMentionReference[]) => ProviderMentionReference[]),
    ) => {
      const existing = selectedComposerMentionsRef.current;
      const resolved = typeof next === "function" ? next(existing) : next;
      selectedComposerMentionsRef.current = resolved;
      setSelectedComposerMentions(resolved);
      setComposerDraftMentions(threadId, resolved);
    },
    [setComposerDraftMentions, threadId],
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    EMPTY_LAST_INVOKED_SCRIPT_BY_PROJECT,
    LastInvokedScriptByProjectSchema,
  );
  const [dismissedProviderHealthBannerKeys, setDismissedProviderHealthBannerKeys] = useLocalStorage(
    DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
    EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS,
    DismissedProviderHealthBannersSchema,
  );
  const [dismissedRateLimitBannerKey, setDismissedRateLimitBannerKey] = useState<string | null>(
    null,
  );
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const legendListRef = useRef<LegendListRef | null>(null);
  const timelineControllerRef = useRef<MessagesTimelineController | null>(null);
  const isAtEndRef = useRef(true);
  const autoFollowThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade; the pickers already closed post-commit.
    const settle = window.setTimeout(() => {
      setComposerCommandPicker(null);
      setIsModelPickerOpen(false);
      setIsTraitsPickerOpen(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [threadId]);
  useEffect(() => {
    const scrollDebouncer = showScrollDebouncer.current;
    return () => {
      scrollDebouncer.cancel();
      const pendingFrame = pendingInteractionAnchorFrameRef.current;
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, []);
  useEffect(() => {
    // Thread-bound handoff dialog state is reset by the dedicated hook.
  }, [threadId]);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  // Set by whichever mounted GitActionsControl instance (header quick-action or the
  // Environment panel row) last registered — either performs the identical commit &
  // push mutation for this thread's repo, so it doesn't matter which one is "current".
  const commitAndPushTriggerRef = useRef<(() => void) | null>(null);
  const onRegisterCommitAndPushTrigger = useCallback((trigger: (() => void) | null) => {
    commitAndPushTriggerRef.current = trigger;
  }, []);
  const pendingComposerFocusRef = useRef(false);
  const promptHistoryNavigationRef = useRef<PromptHistoryNavigationState | null>(null);
  const applyingPromptHistoryNavigationRef = useRef(false);
  const expectedPromptHistoryPromptRef = useRef<string | null>(null);
  const promptHistoryAppliedPromptRef = useRef<string | null>(null);
  const composerFormHeightRef = useRef(0);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const queuedComposerTurnsRef = useRef<QueuedComposerTurn[]>([]);
  const restoredQueuedSourceProposedPlanRef = useRef<RestoredComposerSourceProposedPlan | null>(
    restoredSourceProposedPlan ?? null,
  );
  const autoDispatchingQueuedTurnRef = useRef(false);
  // Holds queued-composer auto-dispatch through a non-Codex steer's
  // interrupt→re-dispatch gap; see resolveQueuedSteerGateTransition.
  const [queuedSteerGate, setQueuedSteerGate] = useState<QueuedSteerGate | null>(null);
  // Bumped to re-evaluate auto-dispatch when only non-reactive guards (refs)
  // blocked it; nothing else re-triggers the effect once they reset.
  const [queuedAutoDispatchTick, setQueuedAutoDispatchTick] = useState(0);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const sendPreflightInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const activatedThreadIdRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    promptHistoryNavigationRef.current = null;
    applyingPromptHistoryNavigationRef.current = false;
    expectedPromptHistoryPromptRef.current = null;
    promptHistoryAppliedPromptRef.current = null;
  }, [threadId]);
  // While a history browse is active the persisted draft prompt holds a
  // recalled entry and the user's real draft snapshot sits in promptHistorySavedDraft.
  // A non-null saved draft with no live navigation state means the browse was
  // interrupted (thread switch, reload, unmount) — put the real draft back.
  useEffect(() => {
    if (promptHistoryNavigationRef.current !== null || composerPromptHistorySavedDraft === null) {
      return;
    }
    restoreComposerDraftPromptHistorySavedDraft(threadId);
    setComposerCursor(
      collapseExpandedComposerCursor(
        composerPromptHistorySavedDraft.prompt,
        composerPromptHistorySavedDraft.prompt.length,
      ),
    );
  }, [composerPromptHistorySavedDraft, restoreComposerDraftPromptHistorySavedDraft, threadId]);
  const setRestoredQueuedSourceProposedPlan = useCallback(
    (targetThreadId: ThreadId, source: RestoredComposerSourceProposedPlan | null) => {
      restoredQueuedSourceProposedPlanRef.current = source;
      setComposerDraftRestoredSourceProposedPlan(targetThreadId, source);
    },
    [setComposerDraftRestoredSourceProposedPlan],
  );
  useEffect(() => {
    restoredQueuedSourceProposedPlanRef.current = restoredSourceProposedPlan ?? null;
  }, [restoredSourceProposedPlan]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const discardPromptHistoryNavigationForComposerMutation = useCallback(() => {
    if (promptHistoryNavigationRef.current === null) {
      return;
    }
    // Attachment edits mean the recalled prompt is now the user's draft; do not restore the old one.
    promptHistoryNavigationRef.current = null;
    applyingPromptHistoryNavigationRef.current = false;
    expectedPromptHistoryPromptRef.current = null;
    promptHistoryAppliedPromptRef.current = null;
    setComposerDraftPromptHistorySavedDraft(threadId, null);
  }, [setComposerDraftPromptHistorySavedDraft, threadId]);
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerFilesToDraft = useCallback(
    (files: ComposerFileAttachment[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftFiles(threadId, files);
    },
    [addComposerDraftFiles, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerAssistantSelectionToDraft = useCallback(
    (selection: ComposerAssistantSelectionAttachment) => {
      discardPromptHistoryNavigationForComposerMutation();
      return addComposerDraftAssistantSelection(threadId, selection);
    },
    [
      addComposerDraftAssistantSelection,
      discardPromptHistoryNavigationForComposerMutation,
      threadId,
    ],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerPastedTextsToDraft = useCallback(
    (pastedTexts: PastedTextDraft[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(threadId, pastedTexts);
    },
    [addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerFileCommentToDraft = useCallback(
    (comment: FileCommentDraft) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftFileComment(threadId, comment);
    },
    [addComposerDraftFileComment, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftImage(threadId, imageId);
    },
    [discardPromptHistoryNavigationForComposerMutation, removeComposerDraftImage, threadId],
  );
  const clearComposerAssistantSelectionsFromDraft = useCallback(() => {
    discardPromptHistoryNavigationForComposerMutation();
    clearComposerDraftAssistantSelections(threadId);
  }, [
    clearComposerDraftAssistantSelections,
    discardPromptHistoryNavigationForComposerMutation,
    threadId,
  ]);
  const clearComposerFileCommentsFromDraft = useCallback(() => {
    discardPromptHistoryNavigationForComposerMutation();
    clearComposerDraftFileComments(threadId);
  }, [clearComposerDraftFileComments, discardPromptHistoryNavigationForComposerMutation, threadId]);
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftTerminalContext,
      setPrompt,
      threadId,
    ],
  );
  const removeComposerPastedTextFromDraft = useCallback(
    (pastedTextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftPastedText(threadId, pastedTextId);
    },
    [discardPromptHistoryNavigationForComposerMutation, removeComposerDraftPastedText, threadId],
  );
  // "Show in text field": drop the full pasted text back into the editor (appended
  // to the current prompt) and discard the card so it can be edited as normal text.
  const showComposerPastedTextInField = useCallback(
    (pastedTextId: string) => {
      const pasted = composerPastedTexts.find((entry) => entry.id === pastedTextId);
      if (!pasted) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const current = promptRef.current;
      const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      const nextPrompt = `${current}${separator}${pasted.text}`;
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      removeComposerDraftPastedText(threadId, pastedTextId);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
    },
    [
      composerPastedTexts,
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftPastedText,
      setPrompt,
      threadId,
    ],
  );

  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  useEffect(() => {
    if (
      !pendingFileUndo ||
      !hasFileUndoSettled({ pending: pendingFileUndo, thread: activeThread ?? null })
    ) {
      return;
    }
    // Async setState (post-paint) keeps this settled-undo cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setPendingFileUndo(null);
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread, pendingFileUndo]);
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.panel === "diff";
  const browserOpen = rawSearch.panel === "browser";
  const resolvedDiffOpen = panelState ? panelState.panel === "diff" : diffOpen;
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const hasLiveTurnTail = hasLiveTurnTailWork({
    latestTurn: activeLatestTurn,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    activities: threadActivities,
    session: activeThread?.session ?? null,
  });
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
  const activeCumulativeCostUsd = useMemo(
    () => deriveCumulativeCostUsd(threadActivities),
    [threadActivities],
  );
  const activeRateLimitStatus = useMemo(
    () => deriveLatestRateLimitStatus(threadActivities),
    [threadActivities],
  );
  const activeRateLimitBannerDismissalKey = useMemo(
    () => getRateLimitBannerDismissalKey(activeRateLimitStatus, activeThread?.id ?? null),
    [activeRateLimitStatus, activeThread?.id],
  );
  const visibleActiveRateLimitStatus =
    activeRateLimitBannerDismissalKey === dismissedRateLimitBannerKey
      ? null
      : activeRateLimitStatus;
  const latestTurnSettledByProvider = isLatestTurnSettled(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  const latestTurnSettled = latestTurnSettledByProvider && !hasLiveTurnTail;
  // `latestTurnSettled` is also false when there is NO started turn (a brand-new
  // chat), because `isLatestTurnSettled` treats a non-existent turn as unsettled.
  // Gate live-turn UI on an actually-started turn so composer chrome cannot
  // appear on a fresh chat just because the repo already has local edits.
  const latestTurnLive = Boolean(activeLatestTurn?.startedAt) && !latestTurnSettled;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const deletePlaceholderTerminalThread = useCallback(
    async (terminalThreadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: terminalThreadId,
        });
        void reconcileDeletedThreadFromClient({
          threadId: terminalThreadId,
          removeDeletedThreadFromClientState:
            useStore.getState().removeDeletedThreadFromClientState,
        });
        useComposerDraftStore.getState().clearDraftThread(terminalThreadId);
        useTerminalStateStore.getState().clearTerminalState(terminalThreadId);
        removeThreadFromSplitViews(terminalThreadId);
        if (activeSplitView) {
          const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
          const nextThreadId = nextSplitView
            ? resolveSplitViewFocusedThreadId(nextSplitView)
            : null;
          if (nextSplitView && nextThreadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
              replace: true,
              search: () => ({ splitViewId: nextSplitView.id }),
            });
            return;
          }
        }
        await handleNewChat({ fresh: true });
      } catch (error) {
        console.error("Failed to delete empty terminal thread after closing its last terminal", {
          threadId: terminalThreadId,
          error,
        });
      }
    },
    [activeSplitView, handleNewChat, navigate, removeThreadFromSplitViews],
  );
  const {
    terminalState,
    terminalFocusRequestId,
    requestTerminalFocus,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    setTerminalOpen,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
    setTerminalHeight,
    setTerminalMetadataInStore: storeSetTerminalMetadata,
    setTerminalActivityInStore: storeSetTerminalActivity,
    openChatThreadPageInStore: storeOpenChatThreadPage,
    openTerminalThreadPageInStore: storeOpenTerminalThreadPage,
    newTerminalInStore: storeNewTerminal,
    setActiveTerminalInStore: storeSetActiveTerminal,
    closeTerminalGroupInStore: storeCloseTerminalGroup,
    resizeTerminalSplitInStore: storeResizeTerminalSplit,
    toggleTerminalVisibility,
    expandTerminalWorkspace,
    collapseTerminalWorkspace,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalDown,
    splitTerminalUp,
    createNewTerminal,
    createNewTerminalTab,
    createTerminalFromShortcut,
    moveTerminalToNewGroup,
    openNewFullWidthTerminal,
    activateTerminal,
    closeTerminal,
    closeActiveWorkspaceView,
  } = useChatTerminalController({
    threadId,
    activeThreadId,
    activeThread,
    activeProjectPresent: activeProject !== undefined,
    isFocusedPane,
    isServerThread,
    confirmTerminalClose: settings.confirmTerminalTabClose,
    onDeletePlaceholderThread: deletePlaceholderTerminalThread,
  });
  const projectInstructions = useProjectInstructionsStore((state) =>
    activeProjectId ? (state.instructionsByProjectId[activeProjectId] ?? "") : "",
  );
  const setProjectInstructions = useProjectInstructionsStore((state) => state.setInstructions);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const isHomeChatContainer = isHomeChatContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
  });
  const isStudioContainer = isStudioContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  const isContainerLandingProject = isHomeChatContainer || isStudioContainer;
  const activeProjectDisplayName = isHomeChatContainer
    ? activeProject?.folderName
    : activeProject?.name;
  const isChatProject = isContainerLandingProject;
  const activeProjectScripts =
    activeProject?.kind === "project" ? activeProject.scripts : undefined;
  const threadLineageThreads = useStore(
    useMemo(() => createThreadLineageSelector(activeThread?.id ?? null), [activeThread?.id]),
  );
  const threadBreadcrumbs = useMemo(
    () => buildThreadBreadcrumbs(threadLineageThreads, activeThread),
    [activeThread, threadLineageThreads],
  );
  const resolvedThreadEnvMode = isServerThread
    ? (activeThread?.envMode ?? null)
    : (draftThread?.envMode ?? null);
  const resolvedThreadWorktreePath = isServerThread
    ? (activeThread?.worktreePath ?? null)
    : (draftThread?.worktreePath ?? null);
  const diffEnvironmentState = resolveDiffEnvironmentState({
    projectCwd: activeProject?.cwd ?? null,
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const diffEnvironmentPending = diffEnvironmentState.pending;
  const diffDisabledReason = diffEnvironmentState.disabledReason;
  const repoDiffBadgeRefreshIntervalMs =
    isFocusedPane && latestTurnLive && !diffEnvironmentPending && !resolvedDiffOpen
      ? GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS
      : false;
  const activeThreadAssociatedWorktree = useMemo(
    () =>
      deriveAssociatedWorktreeMetadata({
        branch: activeThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? null,
        ...(activeThread?.associatedWorktreePath !== undefined
          ? { associatedWorktreePath: activeThread.associatedWorktreePath }
          : {}),
        ...(activeThread?.associatedWorktreeBranch !== undefined
          ? { associatedWorktreeBranch: activeThread.associatedWorktreeBranch }
          : {}),
        ...(activeThread?.associatedWorktreeRef !== undefined
          ? { associatedWorktreeRef: activeThread.associatedWorktreeRef }
          : {}),
      }),
    [activeThread],
  );

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      envMode: DraftThreadEnvMode;
      lastKnownPr?: Thread["lastKnownPr"];
    }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const draftThreadContext = {
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.envMode,
        ...(input.lastKnownPr !== undefined ? { lastKnownPr: input.lastKnownPr } : {}),
      };
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, draftThreadContext);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, draftThreadContext);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (
        !isServerThread &&
        activeDraftThread?.projectId === activeProject.id &&
        activeDraftThread.entryPoint === "chat"
      ) {
        setDraftThreadContext(threadId, draftThreadContext);
        setProjectDraftThreadId(activeProject.id, threadId, draftThreadContext);
        return;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        ...draftThreadContext,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      pullRequest: NonNullable<Thread["lastKnownPr"]>;
    }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
        lastKnownPr: input.pullRequest,
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(activeThread.id);
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    markThreadVisited,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const selectedProvider: ProviderKind =
    lockedProvider ?? selectedProviderByThreadId ?? threadProvider ?? settings.defaultProvider;
  const previousSelectedProviderRef = useRef<{
    threadId: ThreadId;
    provider: ProviderKind;
  } | null>(null);
  const featureFlags = useFeatureFlags();
  const showDebugTaskBanner = import.meta.env.DEV && featureFlags["show-debug-task-banner"];
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const composerModelHintByProvider = useMemo<Record<ProviderKind, string | null>>(() => {
    const threadModelSelection = activeThread?.modelSelection ?? null;
    const projectModelSelection = activeProject?.defaultModelSelection ?? null;
    const draftSelections = composerDraft.modelSelectionByProvider;

    const resolveHint = (provider: ProviderKind): string | null =>
      draftSelections[provider]?.model ??
      (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
      (projectModelSelection?.provider === provider ? projectModelSelection.model : null);

    return {
      codex: resolveHint("codex"),
      claudeAgent: resolveHint("claudeAgent"),
      cursor: resolveHint("cursor"),
      antigravity: resolveHint("antigravity"),
      grok: resolveHint("grok"),
      droid: resolveHint("droid"),
      kilo: resolveHint("kilo"),
      opencode: resolveHint("opencode"),
      pi: resolveHint("pi"),
    };
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    composerDraft.modelSelectionByProvider,
  ]);
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: resolvedThreadWorktreePath,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const {
    customModelsByProvider,
    modelOptionsByProvider,
    loadingModelProviders,
    runtimeModelsByProvider,
    selectedRuntimeAgents: dynamicAgents,
    selectedProviderModelsLoading,
    selectedProviderRuntimeModelDiscoveryPending,
  } = useProviderModelCatalog({
    selectedProvider,
    discoveryEnabled: isModelPickerOpen,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider: composerModelHintByProvider,
    agentDiscoveryPolicy: "eager-core",
  });
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    threadModelSelection: activeThread?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    customModelsByProvider,
    availableModelOptionsByProvider: modelOptionsByProvider,
  });
  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [runtimeModelsByProvider, selectedModel, selectedProvider],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModel: selectedRuntimeModel,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedRuntimeModel],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const draftModelSelectionForSelectedProvider =
    composerDraft.modelSelectionByProvider[selectedProvider] ?? null;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    if (selectedProvider === "pi" && draftModelSelectionForSelectedProvider?.provider === "pi") {
      return buildModelSelection(
        selectedProvider,
        draftModelSelectionForSelectedProvider.model,
        selectedModelOptionsForDispatch ?? draftModelSelectionForSelectedProvider.options,
      );
    }
    return buildModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch);
  }, [
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
  ]);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const selectedModelForPicker =
    selectedModelSelection.provider === selectedProvider
      ? selectedModelSelection.model
      : selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const persistedComposerModelSelection =
    sessionProvider && activeThread?.modelSelection.provider !== sessionProvider
      ? activeProject?.defaultModelSelection?.provider === selectedProvider
        ? activeProject.defaultModelSelection
        : null
      : (activeThread?.modelSelection ?? activeProject?.defaultModelSelection ?? null);
  const providerModelsLoading = selectedProviderModelsLoading;
  const selectedProviderRequiresRuntimeModels =
    selectedProvider === "cursor" ||
    selectedProvider === "antigravity" ||
    selectedProvider === "droid" ||
    selectedProvider === "kilo" ||
    selectedProvider === "opencode" ||
    selectedProvider === "pi";
  const showComposerModelBootstrapSkeleton = shouldShowComposerModelBootstrapSkeleton({
    selectedProvider,
    selectedModel,
    persistedModelSelection: persistedComposerModelSelection,
    draftModelSelection: draftModelSelectionForSelectedProvider,
    providerModelsLoading,
    requiresDiscoveredModels: selectedProviderRequiresRuntimeModels,
  });
  const searchableModelOptions = useMemo(
    () =>
      buildSearchableModelOptions({
        providerOptions: AVAILABLE_PROVIDER_OPTIONS,
        modelOptionsByProvider,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
        protectedProviders: [selectedProvider],
        lockedProvider,
      }),
    [
      lockedProvider,
      modelOptionsByProvider,
      selectedProvider,
      settings.hiddenProviders,
      settings.providerOrder,
    ],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isConnecting = isLocalConnecting || phase === "connecting";
  // User messages intentionally have no turn id; assistant messages are the stable
  // bridge for deciding which historical work can fold into visible replies.
  // Memoized on purpose: ChatView does not compile under React Compiler yet
  // (hoisting blockers), so an inline Set would change identity every render
  // and cascade through the memoized work-log/timeline chain into the
  // virtualized list, which resets in a loop on unstable data.
  const workLogVisibleTurnIds = useMemo(() => {
    const turnIds = new Set<TurnId>();
    for (const message of activeThread?.messages ?? []) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (activeLatestTurn?.turnId) {
      turnIds.add(activeLatestTurn.turnId);
    }
    return turnIds;
  }, [activeLatestTurn?.turnId, activeThread?.messages]);
  const rawWorkLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined, {
        visibleTurnIds: workLogVisibleTurnIds,
      }),
    [activeLatestTurn?.turnId, threadActivities, workLogVisibleTurnIds],
  );
  const hasWorkLogSubagents = useMemo(
    () => rawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [rawWorkLogEntries],
  );
  const relevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: rawWorkLogEntries,
          parentThreadId: activeThread?.id ?? null,
          enabled: hasWorkLogSubagents,
        }),
      [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries],
    ),
  );
  const workLogEntries = useMemo(
    () =>
      hasWorkLogSubagents
        ? enrichSubagentWorkEntries(
            rawWorkLogEntries,
            relevantWorkLogThreads,
            activeThread?.id ?? null,
          )
        : rawWorkLogEntries,
    [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries, relevantWorkLogThreads],
  );
  // Native-CLI-style nested trace: transcript subagent rows show the child thread's
  // recent tool calls. Retain child detail subscriptions only while a subagent runs
  // so its activities stream in live; settled traces stay frozen from whatever the
  // store already holds.
  const liveSubagentThreadIdsKey = useMemo(() => {
    if (!hasWorkLogSubagents) {
      return "";
    }
    const threadIds = new Set<string>();
    for (const entry of workLogEntries) {
      for (const subagent of entry.subagents ?? []) {
        if (subagent.isActive && subagent.resolvedThreadId) {
          threadIds.add(subagent.resolvedThreadId);
        }
      }
    }
    return [...threadIds].toSorted().join("\n");
  }, [hasWorkLogSubagents, workLogEntries]);
  useEffect(() => {
    if (!liveSubagentThreadIdsKey) {
      return;
    }
    const releases = liveSubagentThreadIdsKey
      .split("\n")
      .map((threadId) => retainThreadDetailSubscription(ThreadId.makeUnsafe(threadId)));
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [liveSubagentThreadIdsKey]);
  const subagentToolTraceByThreadId = useMemo(
    () =>
      hasWorkLogSubagents
        ? deriveSubagentToolTraceByThreadId({
            workEntries: workLogEntries,
            threads: relevantWorkLogThreads,
          })
        : EMPTY_SUBAGENT_TOOL_TRACES,
    [hasWorkLogSubagents, relevantWorkLogThreads, workLogEntries],
  );
  // Native-CLI parity: while a subagent thread is open, the strip derives from the
  // PARENT thread's activities so all sibling subagents (plus a way back to the
  // main thread) stay visible, with the open subagent marked as viewed.
  const stripParentThreadId = activeThread?.parentThreadId ?? null;
  const stripParentThread = useStore(
    useMemo(() => createThreadSelector(stripParentThreadId), [stripParentThreadId]),
  );
  // Deep links can land on a subagent thread before the parent has a detail
  // subscription; retain one so the parent's activities hydrate for the strip.
  useEffect(() => {
    if (!stripParentThreadId) {
      return;
    }
    return retainThreadDetailSubscription(stripParentThreadId);
  }, [stripParentThreadId]);
  const stripSourceThreadId = stripParentThread?.id ?? activeThread?.id ?? null;
  const stripSourceActivities = stripParentThread?.activities ?? threadActivities;
  const stripSourceLatestTurnId = stripParentThread
    ? (stripParentThread.latestTurn?.turnId ?? null)
    : (activeLatestTurn?.turnId ?? null);
  const stripVisibleTurnIds = useMemo(() => {
    if (!stripParentThread) {
      return workLogVisibleTurnIds;
    }
    const turnIds = new Set<TurnId>();
    for (const message of stripParentThread.messages) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (stripParentThread.latestTurn?.turnId) {
      turnIds.add(stripParentThread.latestTurn.turnId);
    }
    return turnIds;
  }, [stripParentThread, workLogVisibleTurnIds]);
  const stripLiveTurnId = stripParentThread
    ? isLatestTurnSettled(stripParentThread.latestTurn, stripParentThread.session ?? null)
      ? null
      : (stripParentThread.latestTurn?.turnId ?? null)
    : latestTurnSettled
      ? null
      : (activeLatestTurn?.turnId ?? null);
  // Composer-strip source: routed subagent activities are omitted from the timeline
  // entries above (they render as nested threads), so the strip derives from an
  // unfiltered pass or it would structurally never see routed subagents.
  const stripRawWorkLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(stripSourceActivities, stripSourceLatestTurnId ?? undefined, {
        visibleTurnIds: stripVisibleTurnIds,
        includeRoutedSubagentActivities: true,
      }),
    [stripSourceActivities, stripSourceLatestTurnId, stripVisibleTurnIds],
  );
  const hasStripWorkLogSubagents = useMemo(
    () => stripRawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [stripRawWorkLogEntries],
  );
  const stripRelevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: stripRawWorkLogEntries,
          parentThreadId: stripSourceThreadId,
          enabled: hasStripWorkLogSubagents,
        }),
      [stripSourceThreadId, hasStripWorkLogSubagents, stripRawWorkLogEntries],
    ),
  );
  const stripWorkLogEntries = useMemo(
    () =>
      hasStripWorkLogSubagents
        ? enrichSubagentWorkEntries(
            stripRawWorkLogEntries,
            stripRelevantWorkLogThreads,
            stripSourceThreadId,
          )
        : stripRawWorkLogEntries,
    [
      stripSourceThreadId,
      hasStripWorkLogSubagents,
      stripRawWorkLogEntries,
      stripRelevantWorkLogThreads,
    ],
  );
  const [openAgentActivityId, setOpenAgentActivityId] = useState<string | null>(null);
  const agentActivityTimelineState = useMemo(
    () => deriveAgentActivityTimelineState(workLogEntries),
    [workLogEntries],
  );
  const openAgentActivityDetail = openAgentActivityId
    ? (agentActivityTimelineState.detailById.get(openAgentActivityId) ?? null)
    : null;
  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread?.id]);
  useEffect(() => {
    if (!openAgentActivityId || agentActivityTimelineState.detailById.has(openAgentActivityId)) {
      return;
    }
    // Async setState (post-paint) keeps this stale-detail cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [agentActivityTimelineState.detailById, openAgentActivityId]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities, activeThread?.pendingInteractions),
    [activeThread?.pendingInteractions, threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities, activeThread?.pendingInteractions),
    [activeThread?.pendingInteractions, threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingUserInputKey = activePendingUserInput
    ? pendingRequestInstanceKey(
        activePendingUserInput.requestId,
        activePendingUserInput.lifecycleGeneration,
      )
    : null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInputKey
        ? (pendingUserInputAnswersByRequestId[activePendingUserInputKey] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInputKey, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInputKey
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInputKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInputKey
    ? respondingUserInputRequestKeys.includes(activePendingUserInputKey)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarPlanSourceThreadId = !latestTurnSettled
    ? (activeLatestTurn?.sourceProposedPlan?.threadId ?? null)
    : null;
  const sidebarPlanSourceThread = useStore(
    useMemo(() => createThreadSelector(sidebarPlanSourceThreadId), [sidebarPlanSourceThreadId]),
  );
  const activeThreadPlanThreadId = activeThread?.id ?? null;
  const activeThreadPlanProposedPlans = activeThread?.proposedPlans;
  const sidebarPlanSourceThreadPlanId = sidebarPlanSourceThread?.id ?? null;
  const sidebarPlanSourceThreadProposedPlans = sidebarPlanSourceThread?.proposedPlans;
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: [
          ...(activeThreadPlanThreadId
            ? [
                {
                  id: activeThreadPlanThreadId,
                  proposedPlans: activeThreadPlanProposedPlans ?? [],
                },
              ]
            : []),
          ...(sidebarPlanSourceThreadPlanId &&
          sidebarPlanSourceThreadPlanId !== activeThreadPlanThreadId
            ? [
                {
                  id: sidebarPlanSourceThreadPlanId,
                  proposedPlans: sidebarPlanSourceThreadProposedPlans ?? [],
                },
              ]
            : []),
        ],
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThreadPlanThreadId,
      }),
    [
      activeLatestTurn,
      activeThreadPlanProposedPlans,
      activeThreadPlanThreadId,
      latestTurnSettled,
      sidebarPlanSourceThreadPlanId,
      sidebarPlanSourceThreadProposedPlans,
    ],
  );
  const planSidebarLabel = sidebarProposedPlan ? "Plan details" : "Tasks";
  const planSidebarToggleLabel = planSidebarOpen ? `Hide ${planSidebarLabel}` : planSidebarLabel;
  const planSidebarToggleTitle = `${planSidebarOpen ? "Hide" : "Show"} ${planSidebarLabel.toLowerCase()} sidebar`;
  const activeTaskList = useMemo((): ActiveTaskListState | null => {
    if (showDebugTaskBanner) {
      return {
        createdAt: new Date().toISOString(),
        turnId: activeLatestTurn?.turnId ?? null,
        tasks: [
          {
            task: "Inspect banner layout without overlapping transcript text",
            status: "inProgress",
          },
          {
            task: "Confirm compact task banner width",
            status: "pending",
          },
          {
            task: "Verify sidebar task controls",
            status: "completed",
          },
        ],
      };
    }

    // Only while a turn is live: deriveActiveTaskListState falls back to the latest
    // unfinished prior-turn list (follow-up turns, reloads mid-turn), but once the
    // thread is idle the card must clear — providers routinely end a turn without
    // marking every task completed, and an unfinished list must not linger forever.
    return latestTurnSettled
      ? null
      : deriveActiveTaskListState(threadActivities, activeLatestTurn?.turnId);
  }, [activeLatestTurn?.turnId, latestTurnSettled, showDebugTaskBanner, threadActivities]);
  const activeBackgroundTasks = useMemo(
    () =>
      latestTurnSettled
        ? null
        : deriveActiveBackgroundTasksState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, latestTurnSettled, threadActivities],
  );
  // Task tool_use_ids the provider confirmed as backgrounded via task_updated
  // patches (last patch wins, so re-foregrounded tasks drop back out).
  const backgroundedSubagentToolUseIds = useMemo(() => {
    const toolUseIds = new Set<string>();
    for (const activity of stripSourceActivities) {
      if (activity.kind !== "task.updated") {
        continue;
      }
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const toolUseId = typeof payload?.toolUseId === "string" ? payload.toolUseId : null;
      if (!toolUseId || typeof payload?.isBackgrounded !== "boolean") {
        continue;
      }
      if (payload.isBackgrounded) {
        toolUseIds.add(toolUseId);
      } else {
        toolUseIds.delete(toolUseId);
      }
    }
    return toolUseIds;
  }, [stripSourceActivities]);
  const composerSubagentStripItems = useMemo(
    () =>
      deriveComposerSubagentStripItems({
        workEntries: stripWorkLogEntries,
        liveTurnId: stripLiveTurnId,
        backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
        viewedThreadId: stripParentThread ? (activeThread?.id ?? null) : null,
        parentRow: stripParentThread
          ? { threadId: stripParentThread.id, label: stripParentThread.title ?? null }
          : null,
      }),
    [
      activeThread?.id,
      backgroundedSubagentToolUseIds,
      stripLiveTurnId,
      stripParentThread,
      stripWorkLogEntries,
    ],
  );
  // Links workflow agent rows to their subagent child threads (and models) when the
  // Task tool_use_id produced one; agents spawned without a tool call stay unlinked.
  const workflowSubagentThreadsByToolUseId = useMemo(() => {
    const refs = new Map<string, WorkflowSubagentThreadRef>();
    for (const entry of workLogEntries) {
      for (const subagent of entry.subagents ?? []) {
        if (!subagent.providerThreadId) {
          continue;
        }
        refs.set(subagent.providerThreadId, {
          threadId: subagent.resolvedThreadId ?? subagent.threadId,
          model: subagent.model,
          effort: subagent.effort,
        });
      }
    }
    return refs;
  }, [workLogEntries]);
  // Persisted (per-thread) workflow run flags: pausedByUser tells the settled
  // card apart from a plain stop; dismissed retires a settled card the run's
  // activities would otherwise keep visible. Survive reloads via
  // workflowRunUiStore instead of living in component state.
  const workflowRunUiThreadState = useWorkflowRunUiThreadState(activeThreadId);
  const pausedWorkflowTaskIds = useMemo(
    () => new Set(workflowRunUiThreadState.pausedByUser),
    [workflowRunUiThreadState.pausedByUser],
  );
  const dismissedWorkflowTaskIds = useMemo(
    () => new Set(workflowRunUiThreadState.dismissed),
    [workflowRunUiThreadState.dismissed],
  );
  const workflowRunState = useMemo(
    () =>
      deriveWorkflowRunState({
        activities: threadActivities,
        subagentThreadsByToolUseId: workflowSubagentThreadsByToolUseId,
        pausedByUserTaskIds: pausedWorkflowTaskIds,
        dismissedTaskIds: dismissedWorkflowTaskIds,
      }),
    [
      threadActivities,
      workflowSubagentThreadsByToolUseId,
      pausedWorkflowTaskIds,
      dismissedWorkflowTaskIds,
    ],
  );
  const workflowNowMs = useNowMs(workflowRunState !== null && !workflowRunState.settled);
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingUserInput: activePendingUserInput !== null,
        threadError: activeThread?.error,
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.session,
      localDispatch,
      phase,
    ],
  );
  const isSendBusy = localDispatch !== null && !serverAcknowledgedLocalDispatch;
  const activeWorktreeSetup = localDispatch?.worktreeSetup ?? null;
  const isPreparingWorktree = activeWorktreeSetup !== null;
  const hasLiveTurn = phase === "running";
  const {
    automationProjects,
    automationThreads,
    automationData,
    automationUpdateMutation,
    automationDraftForm,
    setAutomationDraftForm,
    automationEditingDefinition,
    setAutomationEditingDefinition,
    automationDraftWarnings,
    setAutomationDraftWarnings,
    setAutomationDraftWarningContext,
    acknowledgedAutomationWarnings,
    setAcknowledgedAutomationWarnings,
    automationDraftOpen,
    setAutomationDraftOpen,
    setAutomationDraftDialogOpen,
    isAutomationDraftSubmitting,
    setIsAutomationDraftSubmitting,
    automationDraftSubmittingRef,
    pendingAutomationConversation,
    setPendingAutomationConversation,
    activeThreadIdRef,
    pendingAutomationConversationRef,
    hasLiveTurnRef,
    isPendingSetupBubbleId,
    cancelAutomationConversation,
    toggleAutomationWarning,
    updateAutomationDraftForm,
    resetAutomationDraftState,
    openAutomationEditDialog,
  } = useChatAutomationSetup({
    threadId,
    activeProjectId,
    hasLiveTurn,
    promptRef,
    setComposerDraftPrompt,
  });
  const isWorking = hasLiveTurn || isSendBusy || isConnecting || isRevertingCheckpoint;
  const hasStreamingAssistantText =
    activeThread?.messages.some((message) => message.role === "assistant" && message.streaming) ??
    false;
  const activeTurnLayoutLive = isWorking || !latestTurnSettled;
  const [keepSettledActiveTurnLayout, setKeepSettledActiveTurnLayout] = useState(false);
  const previousActiveTurnLayoutLiveRef = useRef(activeTurnLayoutLive);
  const previousActiveTurnLayoutKeyRef = useRef<string | null>(null);
  const activeWorkStartedAt = hasLiveTurnTail
    ? (activeLatestTurn?.startedAt ?? null)
    : hasLiveTurn
      ? deriveActiveWorkStartedAt(activeLatestTurn, activeThread?.session ?? null, null)
      : null;
  const activeTurnLayoutKey =
    activeThreadId === null ? null : `${activeThreadId}:${activeLatestTurn?.turnId ?? "idle"}`;
  const activeTurnInProgress = activeTurnLayoutLive || keepSettledActiveTurnLayout;
  const isComposerApprovalState = activePendingApproval !== null;
  const isComposerEditorDisabled = isConnecting || isComposerApprovalState;
  const canCollapsePastedTextToDraft = shouldEnableComposerPastedTextCollapse({
    isComposerApprovalState,
    hasPendingUserInput: pendingUserInputs.length > 0,
    showPlanFollowUpPrompt,
  });
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const handoffDisabled = !(
    activeThread &&
    activeProject &&
    isServerThread &&
    canCreateThreadHandoff({
      thread: activeThread,
      isBusy: isWorking,
      hasPendingApprovals: pendingApprovals.length > 0,
      hasPendingUserInput: pendingUserInputs.length > 0,
    })
  );
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (previousActiveTurnLayoutKeyRef.current !== activeTurnLayoutKey) {
      previousActiveTurnLayoutKeyRef.current = activeTurnLayoutKey;
      previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    const shouldStartGrace = shouldStartActiveTurnLayoutGrace({
      previousTurnLayoutLive: previousActiveTurnLayoutLiveRef.current,
      currentTurnLayoutLive: activeTurnLayoutLive,
      latestTurnStartedAt: activeLatestTurn?.startedAt ?? null,
    });
    previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;

    if (activeTurnLayoutLive) {
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    if (!shouldStartGrace) {
      return;
    }

    setKeepSettledActiveTurnLayout(true);
    const timeoutId = window.setTimeout(() => {
      setKeepSettledActiveTurnLayout(false);
    }, ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeLatestTurn?.startedAt, activeTurnLayoutKey, activeTurnLayoutLive]);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useLayoutEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const replacedPreviewUrls = previousPreviewUrls.filter(
      (previewUrl) => !previewUrls.includes(previewUrl),
    );
    revokeBlobPreviewUrlsAfterPaint(replacedPreviewUrls);
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      // Let React swap the transcript back to persisted /attachments URLs before
      // invalidating blob previews that may still be mounted in the old row.
      if (currentPreviewUrls) {
        revokeBlobPreviewUrlsAfterPaint(currentPreviewUrls);
      }
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = filterSidechatTranscriptMessages(
      serverMessages ?? [],
      Boolean(activeThread?.sidechatSourceThreadId),
    );
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    // Ephemeral automation-setup bubbles render after everything else, at the tail.
    // Gated on the originating thread so a same-pane switch never leaks the previous
    // thread's setup into the newly rendered conversation (the reset effect runs after
    // the first render, so the guard must be here too).
    const setupBubbles =
      pendingAutomationConversation && pendingAutomationConversation.threadId === threadId
        ? pendingAutomationConversation.bubbles
        : [];
    // Optimistic messages exist only briefly after a send; skip the full-transcript
    // id Set on the common (streaming-flush) path where there is nothing to reconcile.
    let pendingMessages = optimisticUserMessages;
    if (optimisticUserMessages.length > 0) {
      const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
      pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    }
    const withPending =
      pendingMessages.length === 0
        ? serverMessagesWithPreviewHandoff
        : [...serverMessagesWithPreviewHandoff, ...pendingMessages];
    return setupBubbles.length === 0 ? withPending : [...withPending, ...setupBubbles];
  }, [
    activeThread?.sidechatSourceThreadId,
    serverMessages,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
    pendingAutomationConversation,
    threadId,
  ]);
  const promptHistory = useMemo(() => {
    const activeMessages = activeThread?.messages ?? EMPTY_MESSAGES;
    // Optimistic messages exist only briefly after a send; skip the full-transcript
    // id Set on the common (streaming-flush) path where there is nothing to reconcile.
    if (optimisticUserMessages.length === 0) {
      return derivePromptHistoryFromMessages(activeMessages);
    }
    const activeMessageIds = new Set(activeMessages.map((message) => message.id));
    const pendingOptimisticMessages = optimisticUserMessages.filter(
      (message) => !activeMessageIds.has(message.id),
    );
    return derivePromptHistoryFromMessages([...activeMessages, ...pendingOptimisticMessages]);
  }, [activeThread?.messages, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        agentActivityTimelineState.timelineWorkEntries,
      ),
    [activeThread?.proposedPlans, agentActivityTimelineState.timelineWorkEntries, timelineMessages],
  );
  const enteringUserMessageIds = useMemo<ReadonlySet<MessageId>>(
    () => new Set(optimisticUserMessages.map((message) => message.id)),
    [optimisticUserMessages],
  );
  // --- Pinned messages & notes (per-thread, server-synced through sidepanel commands) ---
  const pinnedMessages = activeThread?.pinnedMessages ?? EMPTY_PINNED_MESSAGES;
  const threadMarkers = activeThread?.threadMarkers ?? EMPTY_THREAD_MARKERS;
  const threadNotes = activeThread?.notes ?? "";
  const pinnedMessageIds = useMemo(
    () => new Set(pinnedMessages.map((pin) => pin.messageId)),
    [pinnedMessages],
  );
  const markerMessageIds = useMemo(
    () => new Set(threadMarkers.map((marker) => marker.messageId)),
    [threadMarkers],
  );
  // Resolve live text for the Environment panel in one transcript pass.
  const { markerMessageTextById, pinnedMessageTextById } = useMemo(() => {
    const needsPinnedText = pinnedMessageIds.size > 0;
    const needsMarkerText = markerMessageIds.size > 0;
    if (!needsPinnedText && !needsMarkerText) {
      return {
        pinnedMessageTextById: EMPTY_PINNED_TEXT,
        markerMessageTextById: EMPTY_PINNED_TEXT,
      };
    }
    const pinnedTextById = new Map<MessageId, string>();
    const markerTextById = new Map<MessageId, string>();
    for (const message of timelineMessages) {
      if (needsPinnedText && pinnedMessageIds.has(message.id)) {
        pinnedTextById.set(message.id, message.text);
      }
      if (needsMarkerText && markerMessageIds.has(message.id)) {
        markerTextById.set(message.id, message.text);
      }
    }
    return {
      pinnedMessageTextById: needsPinnedText ? pinnedTextById : EMPTY_PINNED_TEXT,
      markerMessageTextById: needsMarkerText ? markerTextById : EMPTY_PINNED_TEXT,
    };
  }, [markerMessageIds, pinnedMessageIds, timelineMessages]);
  const {
    handleTogglePinMessage,
    handleTogglePinnedMessageDone,
    handleUnpinMessage,
    handleRenamePinnedMessage,
    handleNotesChange,
  } = usePinnedMessageActions({ activeThreadId, pinnedMessages });
  const handleTogglePinMessageGuarded = useCallback(
    (messageId: MessageId) => {
      // Never pin an ephemeral automation-setup bubble; its id vanishes when setup ends.
      if (isPendingSetupBubbleId(messageId)) {
        return;
      }
      handleTogglePinMessage(messageId);
    },
    [handleTogglePinMessage, isPendingSetupBubbleId],
  );
  const handleCopyProjectInstructionsToNotes = useCallback(() => {
    if (!activeThreadId) {
      return;
    }
    const nextNotes = mergeProjectInstructionsIntoThreadNotes({
      threadNotes,
      projectInstructions,
    });
    if (nextNotes === threadNotes) {
      return;
    }
    void handleNotesChange(activeThreadId, nextNotes)
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Project instructions added to notepad.",
        });
      })
      .catch(() => {
        // `handleNotesChange` already surfaces the save failure through the shared notes toast.
      });
  }, [activeThreadId, handleNotesChange, projectInstructions, threadNotes]);
  const handleJumpToPinnedMessage = useCallback((messageId: MessageId) => {
    timelineControllerRef.current?.scrollToMessage(messageId);
  }, []);
  const handleJumpToThreadMarker = useCallback((marker: ThreadMarker) => {
    timelineControllerRef.current?.scrollToMarker(marker);
  }, []);
  const handleRemoveThreadMarker = useCallback(
    (markerId: ThreadMarkerId) => {
      if (!activeThreadId) {
        return;
      }
      void dispatchThreadMarkerRemove(activeThreadId, markerId).catch((error) => {
        console.error("Failed to remove thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not remove marker.",
        });
      });
    },
    [activeThreadId],
  );
  const handleToggleThreadMarkerDone = useCallback(
    (markerId: ThreadMarkerId) => {
      if (!activeThreadId) {
        return;
      }
      const marker = threadMarkers.find((candidate) => candidate.id === markerId);
      if (!marker) {
        return;
      }
      void dispatchThreadMarkerDoneSet(activeThreadId, markerId, !marker.done).catch((error) => {
        console.error("Failed to update thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not update marker.",
        });
      });
    },
    [activeThreadId, threadMarkers],
  );
  const handleRenameThreadMarker = useCallback(
    (markerId: ThreadMarkerId, label: string | null) => {
      if (!activeThreadId) {
        return;
      }
      void dispatchThreadMarkerLabelSet(activeThreadId, markerId, label).catch((error) => {
        console.error("Failed to rename thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not rename marker.",
        });
      });
    },
    [activeThreadId],
  );
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Home-scoped chats get the global "What should we work on?" copy plus the project picker,
  // while project-scoped drafts reuse the same centered layout with folder-specific copy.
  const isCenteredEmptyLanding =
    timelineEntries.length === 0 && !activeThread?.parentThreadId && !isEditorRail;
  const isEmptyChatLanding =
    isCenteredEmptyLanding && Boolean(homeDir) && isContainerLandingProject;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const messagesForDiffAnchoring: {
      id: MessageId;
      role: "user" | "assistant" | "system";
      turnId: TurnId | null;
    }[] = [];
    for (const message of timelineMessages) {
      messagesForDiffAnchoring.push({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
      });
    }
    return buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: turnDiffSummaries.map((summary) => ({
        ...summary,
        checkpointTurnCount:
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      })),
      messages: messagesForDiffAnchoring,
    });
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries, timelineMessages]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const threadWorkspaceCwd = activeProject
    ? resolveSharedThreadWorkspaceCwd({
        projectCwd: activeProject.cwd,
        envMode: resolvedThreadEnvMode,
        worktreePath: resolvedThreadWorktreePath,
      })
    : null;
  const gitCwd = threadWorkspaceCwd;
  const gitBranchSourceCwd = activeProject
    ? resolveThreadBranchSourceCwd({
        projectCwd: activeProject.cwd,
        worktreePath: resolvedThreadWorktreePath,
      })
    : null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitBranchSourceCwd));
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacPlatform(platform),
  );
  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = providerModelDiscoveryCwd;
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.serverUrl
            : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir: selectedProvider === "pi" ? settings.piAgentDir || null : null,
      enabled:
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" || supportsSkillDiscovery(providerComposerCapabilitiesQuery.data);
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      agentDir: selectedProvider === "pi" ? settings.piAgentDir || null : null,
      enabled:
        (isSkillTrigger || composerTriggerKind === "slash-command" || selectedProvider === "pi") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      enabled:
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const activeRootBranch = useMemo(
    () =>
      resolveComposerSlashRootBranch({
        branches: branchesQuery.data?.branches,
        activeProjectCwd: activeProject?.cwd,
        activeThreadBranch: activeThread?.branch,
      }),
    [activeProject?.cwd, activeThread?.branch, branchesQuery.data?.branches],
  );
  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS,
    [providerPluginsQuery.data],
  );
  const providerNativeCommands =
    providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const effectiveComposerTrigger = useMemo(() => {
    if (
      composerTrigger?.kind === "slash-model" &&
      hasProviderNativeSlashCommand(selectedProvider, providerNativeCommandNames, "model")
    ) {
      return {
        ...composerTrigger,
        kind: "slash-command" as const,
        query: "model",
      };
    }
    return composerTrigger;
  }, [composerTrigger, providerNativeCommandNames, selectedProvider]);
  const effectiveComposerTriggerKind = effectiveComposerTrigger?.kind ?? null;
  const supportsTextNativeReviewCommand = useMemo(
    () => providerSupportsTextNativeReviewCommand(selectedProvider, providerNativeCommands),
    [providerNativeCommands, selectedProvider],
  );
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;
  const selectedModelCaps = useMemo(
    () => getModelCapabilities(selectedProvider, selectedModel),
    [selectedModel, selectedProvider],
  );
  const supportsFastSlashCommand = selectedModelCaps.supportsFastMode;
  const currentProviderModelOptions = composerModelOptions?.[selectedProvider];
  const fastModeEnabled =
    supportsFastSlashCommand &&
    (currentProviderModelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const composerPromptWithoutActiveSlashTrigger =
    composerTrigger?.kind === "slash-command"
      ? stripComposerTriggerText(prompt, composerTrigger)
      : prompt;
  const canOfferReviewCommand =
    (branchesQuery.data?.isRepo ?? true) &&
    canOfferReviewSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
    });
  const canOfferForkCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferForkSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
      interactionMode,
    });
  const canOfferSideCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferSideSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
      interactionMode,
      isSidechat: Boolean(activeThread.sidechatSourceThreadId),
    });
  // Export is hidden while the thread is running so archives cannot capture a
  // partial assistant response. Same shared predicate as the server's 409
  // guard, so the composer and the export route cannot drift.
  const canOfferExportCommand =
    isServerThread &&
    activeThread !== undefined &&
    threadExportBlockedReason(activeThread) === null;
  const normalComposerMenuItems = useComposerCommandMenuItems({
    composerTrigger: effectiveComposerTrigger,
    provider: selectedProvider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      supportsThreadCompaction(providerComposerCapabilitiesQuery.data) &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferSideCommand,
    canOfferExportCommand,
    dynamicAgents,
    threadMentionSources: {
      threads: composerThreadSummaries,
      projects: composerThreadProjects,
      currentThreadId: threadId,
    },
  });
  const composerMenuItems = useMemo(() => {
    if (composerCommandPicker === "fork-target") {
      return [
        {
          id: "fork-target:worktree",
          type: "fork-target" as const,
          target: "worktree" as const,
          label: "Fork Into New Worktree",
          description: "Continue in a new worktree",
        },
        {
          id: "fork-target:local",
          type: "fork-target" as const,
          target: "local" as const,
          label: "Fork Into Local",
          description:
            activeThread?.worktreePath || activeThread?.envMode === "worktree"
              ? "Continue in this local worktree"
              : "Continue in the current local thread",
        },
      ];
    }
    if (composerCommandPicker === "review-target") {
      return [
        {
          id: "review-target:changes",
          type: "review-target" as const,
          target: "changes" as const,
          label: "Review Uncommitted Changes",
          description: "Review local uncommitted changes",
        },
        {
          id: "review-target:base-branch",
          type: "review-target" as const,
          target: "base-branch" as const,
          label: "Review Against Base Branch",
          description: "Review the current branch diff against its base",
        },
      ];
    }

    return normalComposerMenuItems;
  }, [
    activeThread?.envMode,
    activeThread?.worktreePath,
    composerCommandPicker,
    normalComposerMenuItems,
  ]);
  const composerMenuOpen = Boolean(composerTrigger || composerCommandPicker);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  // Keydown can fire as soon as the updated menu commits, before passive effects.
  useLayoutEffect(() => {
    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;
  }, [composerMenuOpen, composerMenuItems, activeComposerMenuItem]);
  const nonPersistedComposerImageIdSet = useMemo(() => {
    const durableBlobIds = new Set(
      durablyPersistedComposerImageIds
        .filter((attachment) => Boolean(attachment.blobKey))
        .map((attachment) => attachment.id),
    );
    return new Set(nonPersistedComposerImageIds.filter((id) => !durableBlobIds.has(id)));
  }, [durablyPersistedComposerImageIds, nonPersistedComposerImageIds]);
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const rememberCustomBinaryPathForDispatch = useCallback(
    (input: {
      threadId: Thread["id"];
      provider: ProviderKind;
      providerOptions: ProviderStartOptions | undefined;
    }) => {
      const pendingKey = getThreadProviderCustomBinaryPathKey(input.threadId, input.provider);
      const customBinaryPath = getProviderStartOptionsCustomBinaryPath(
        input.providerOptions,
        input.provider,
      );
      if (!customBinaryPath) {
        pendingCustomBinaryPathsByThreadProviderRef.current.delete(pendingKey);
        return;
      }
      pendingCustomBinaryPathsByThreadProviderRef.current.set(pendingKey, customBinaryPath);
    },
    [],
  );
  useEffect(() => {
    const provider = activeThread?.session?.provider;
    if (!activeThread || !provider) {
      return;
    }

    const sessionKey = getConfirmedCustomBinarySessionKey(activeThread, provider);
    if (!sessionKey) {
      confirmedCustomBinarySessionKeysRef.current.delete(
        getThreadProviderCustomBinaryPathKey(activeThread.id, provider),
      );
      return;
    }
    const customBinaryPath =
      pendingCustomBinaryPathsByThreadProviderRef.current.get(sessionKey) ?? null;
    if (
      !shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: confirmedCustomBinarySessionKeysRef.current.has(sessionKey),
        pendingCustomBinaryPath: customBinaryPath,
      })
    ) {
      return;
    }
    confirmedCustomBinarySessionKeysRef.current.add(sessionKey);

    pendingCustomBinaryPathsByThreadProviderRef.current.delete(sessionKey);
    if (!customBinaryPath) {
      return;
    }

    setConfirmedCustomBinaryPathsByProvider((existing) =>
      existing[provider] === customBinaryPath
        ? existing
        : {
            ...existing,
            [provider]: customBinaryPath,
          },
    );
  }, [
    activeThread,
    activeThread?.id,
    activeThread?.session?.provider,
    activeThread?.session?.status,
  ]);
  // Persist confirmations so a custom binary path that already started a session
  // stays trusted across restarts, instead of re-showing the availability warning.
  useEffect(() => {
    saveConfirmedCustomBinaryPaths(confirmedCustomBinaryPathsByProvider);
  }, [confirmedCustomBinaryPathsByProvider]);
  const providerStatuses = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
        .map((status) => {
          const customBinaryPath = getCustomBinaryPathForProvider(settings, status.provider);
          return normalizeProviderStatusForLocalConfig({
            provider: status.provider,
            status,
            customBinaryPath,
            confirmedCustomBinaryPath: confirmedCustomBinaryPathsByProvider[status.provider],
          });
        })
        .flatMap((status) => (status ? [status] : [])),
    [confirmedCustomBinaryPathsByProvider, serverConfigQuery.data?.providers, settings],
  );
  const handoffBadgeLabel = useMemo(
    () => (activeThread ? resolveThreadHandoffBadgeLabel(activeThread) : null),
    [activeThread],
  );
  const handoffBadgeSourceProvider = activeThread?.handoff?.sourceProvider ?? null;
  const handoffBadgeTargetProvider = activeThread?.handoff
    ? activeThread.modelSelection.provider
    : null;
  const handoffTargetProviders = useMemo(
    () =>
      activeThread
        ? resolveAvailableHandoffTargetProviders(activeThread.modelSelection.provider).filter(
            (provider) => isProviderUsable(findProviderStatus(providerStatuses, provider)),
          )
        : [],
    [activeThread, providerStatuses],
  );
  const handoffActionLabel = activeThread ? "Hand off thread" : "Create handoff thread";
  const activeProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, selectedProvider),
    [selectedProvider, providerStatuses],
  );
  const activeProviderHealthBannerDismissalKey = useMemo(
    () => getProviderHealthBannerDismissalKey(activeProviderStatus),
    [activeProviderStatus],
  );
  const visibleActiveProviderStatus =
    activeProviderHealthBannerDismissalKey &&
    dismissedProviderHealthBannerKeys.includes(activeProviderHealthBannerDismissalKey)
      ? null
      : activeProviderStatus;
  const voiceProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, "codex"),
    [providerStatuses],
  );
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const hasNativeUserMessages = useMemo(
    () =>
      activeThread?.messages.some(
        (message) => message.role === "user" && message.source === "native",
      ) ?? false,
    [activeThread?.messages],
  );
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  const isGitRepo = resolveGitRepoUiState({
    isStudioContainer,
    queriedIsRepo: branchesQuery.data?.isRepo,
  });
  // Studio never offers "Initialize Git": a folder picked via "Use a folder" is casual
  // context, not a repo-to-be, so git actions appear there only when it already is one.
  const showGitActions = isStudioContainer
    ? Boolean(resolvedThreadWorktreePath) && isGitRepo
    : !isContainerLandingProject || Boolean(resolvedThreadWorktreePath);
  const repoDiffTotals = useRepoDiffTotals({
    gitCwd: threadWorkspaceCwd,
    isGitRepo,
    refetchInterval: repoDiffBadgeRefreshIntervalMs,
  });
  // The composer live strip is turn-scoped; repoDiffTotals can include unrelated
  // local edits that existed before the active agent turn started.
  const activeTurnLiveDiffState = useMemo(
    () =>
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeLatestTurn?.turnId ?? null,
        turnDiffSummaries,
        workLogEntries: rawWorkLogEntries,
      }),
    [activeLatestTurn?.turnId, rawWorkLogEntries, turnDiffSummaries],
  );
  const splitTerminalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitRight") ??
      shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const splitTerminalDownShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.splitDown"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const closeWorkspaceShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.workspace.closeActive"),
    [keybindings],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const chatSplitShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.split"),
    [keybindings],
  );
  const modelPickerShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "modelPicker.toggle") ??
      formatShortcutLabel({
        key: "m",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    [keybindings],
  );
  const traitsPickerShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "traitsPicker.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    if (diffEnvironmentPending && !diffOpen) {
      return;
    }
    if (onToggleDiffPanel) {
      onToggleDiffPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen
          ? { ...rest, panel: undefined, diff: undefined }
          : { ...rest, panel: "diff", diff: "1" };
      },
    });
  }, [diffEnvironmentPending, diffOpen, navigate, onToggleDiffPanel, threadId]);
  const onToggleBrowser = useCallback(() => {
    if (onToggleBrowserPanel) {
      onToggleBrowserPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return browserOpen ? { ...rest, panel: undefined } : { ...rest, panel: "browser" };
      },
    });
  }, [browserOpen, navigate, onToggleBrowserPanel, threadId]);
  const openBrowserUrl = useCallback(
    (url: string) => {
      const api = readNativeApi();
      void api?.browser.open({ threadId, initialUrl: url }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not open repository",
          description:
            error instanceof Error ? error.message : "The in-app browser could not open GitHub.",
        });
      });
      if (onOpenBrowserUrl) {
        onOpenBrowserUrl(url);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          panel: "browser",
        }),
      });
    },
    [navigate, onOpenBrowserUrl, threadId],
  );

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const isTerminalPrimarySurface = terminalState.entryPoint === "terminal";
  const isTerminalEnvironmentContext =
    isTerminalPrimarySurface || terminalWorkspaceTerminalTabActive;
  const shouldShowProviderHealthBanner = shouldRenderProviderHealthBanner({
    threadEntryPoint: terminalState.entryPoint,
    terminalWorkspaceTerminalTabActive,
  });
  // Terminal-only threads should not pay to mount the hidden chat/composer pane.
  const shouldRenderChatPaneContent = !(
    terminalWorkspaceTerminalTabActive && terminalState.workspaceLayout === "terminal-only"
  );
  const secondaryChromeThreadId = activeThread?.id ?? threadId;
  const shouldDeferSecondaryChrome =
    activeThread !== undefined && !isCenteredEmptyLanding && !terminalWorkspaceTerminalTabActive;
  const [secondaryChromeState, setSecondaryChromeState] = useState(() => ({
    threadId: secondaryChromeThreadId,
    ready: true,
  }));
  const secondaryChromeReady =
    !shouldDeferSecondaryChrome ||
    (secondaryChromeState.threadId === secondaryChromeThreadId && secondaryChromeState.ready);

  useEffect(() => {
    if (!shouldDeferSecondaryChrome) {
      setSecondaryChromeState((current) =>
        current.threadId === secondaryChromeThreadId && current.ready
          ? current
          : { threadId: secondaryChromeThreadId, ready: true },
      );
      return;
    }

    setSecondaryChromeState({
      threadId: secondaryChromeThreadId,
      ready: false,
    });
    const frame = window.requestAnimationFrame(() => {
      setSecondaryChromeState({
        threadId: secondaryChromeThreadId,
        ready: true,
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [secondaryChromeThreadId, shouldDeferSecondaryChrome]);
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (getThreadFromState(useStore.getState(), targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    // Secondary chrome is deferred during thread switches; replay focus once it
    // mounts. A disabled editor (dispatch connecting, pending approval) cannot
    // take focus either, so keep the request pending until it re-enables.
    const editor = composerEditorRef.current;
    if (!secondaryChromeReady || !editor || isComposerEditorDisabled) {
      pendingComposerFocusRef.current = true;
      return;
    }
    pendingComposerFocusRef.current = false;
    editor.focusAtEnd();
  }, [secondaryChromeReady, isComposerEditorDisabled]);
  const toggleComposerFocus = useCallback(() => {
    const editor = composerEditorRef.current;
    if (secondaryChromeReady && editor?.isFocused()) {
      pendingComposerFocusRef.current = false;
      editor.blur();
      return;
    }
    focusComposer();
  }, [focusComposer, secondaryChromeReady]);
  const scheduleComposerFocus = useCallback(() => {
    pendingComposerFocusRef.current = true;
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  // External panels (diff headers, file explorer, preview) bump this nonce after
  // inserting a reference so the composer visibly receives the text.
  const composerFocusRequestNonce = useComposerFocusRequestStore(
    (store) => store.requestsByThreadId[threadId] ?? 0,
  );
  useEffect(() => {
    if (composerFocusRequestNonce > 0) {
      scheduleComposerFocus();
    }
  }, [composerFocusRequestNonce, scheduleComposerFocus]);
  useEffect(() => {
    if (!secondaryChromeReady || !pendingComposerFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusComposer, secondaryChromeReady, secondaryChromeThreadId]);
  // Keep the two composer picker menus mutually exclusive so shortcuts always open one surface.
  const handleModelPickerOpenChange = useCallback((open: boolean) => {
    setIsModelPickerOpen(open);
    if (open) {
      setIsTraitsPickerOpen(false);
    }
  }, []);
  const handleTraitsPickerOpenChange = useCallback((open: boolean) => {
    setIsTraitsPickerOpen(open);
    if (open) {
      setIsModelPickerOpen(false);
    }
  }, []);
  const appendVoiceTranscriptToComposer = useCallback(
    (transcript: string) => {
      const nextPrompt = appendVoiceTranscriptToPrompt(promptRef.current, transcript);
      if (!nextPrompt) {
        return;
      }

      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  const {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  } = useComposerVoiceController({
    activeProject,
    activeThreadId: activeThread?.id ?? null,
    threadId,
    selectedProvider,
    activeProviderStatus: voiceProviderStatus,
    pendingUserInputCount: pendingUserInputs.length,
    onTranscriptReady: appendVoiceTranscriptToComposer,
    refreshVoiceStatus: refreshProviderStatuses,
    actionArmDelayMs: VOICE_RECORDER_ACTION_ARM_DELAY_MS,
    failureCopy: {
      transcriptionFailedTitle: "Couldn't transcribe voice note",
    },
    onGuardWarning: warnVoiceGuard,
  });
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThread) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        selectionCollapsed: true,
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [
      activeThread,
      composerCursor,
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      insertComposerDraftTerminalContext,
    ],
  );
  // Collapse an oversized paste into an attachment card above the composer instead
  // of flooding the editor with raw text. The card holds the full content until the
  // user sends or clicks "Show in text field".
  const addPastedTextToDraft = useCallback(
    (text: string) => {
      if (!activeThread) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(activeThread.id, [
        createPastedTextDraft({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          text,
        }),
      ]);
    },
    [activeThread, addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation],
  );
  // The terminal's panel toggle mirrors the right dock's collapse control: it shows
  // or hides the side panel only when this thread already has a pane to show.
  const rightDockOpen = useRightDockStore((store) => selectRightDockState(threadId)(store).open);
  const isMobileViewport = useIsMobile();
  // Temporary threads are visually identical to regular chats — they use the same
  // Environment panel + header controls. "Temporary" is purely a sidebar badge +
  // auto-delete-on-leave concern, never a stripped-down chat UI.
  const environmentEnabled = !isEditorRail;
  const environmentUsesFloatingOverlay =
    isTerminalEnvironmentContext || isMobileViewport || rightDockOpen || surfaceMode === "split";
  const environmentDefaultOpen = resolveDefaultEnvironmentPanelOpen({
    environmentEnabled,
    isCenteredEmptyLanding,
    isTerminalPrimarySurface,
    isConstrainedChatLayout: environmentUsesFloatingOverlay,
    settingsDefaultOpen: settings.environmentPanelDefaultOpen,
  });
  // Every close (header toggle or panel action click) stores the cross-chat preference,
  // so a dismissed panel stays closed when switching threads until it is toggled back on.
  // The same toggle also persists to settings so the preference survives reloads.
  const [environmentPanelPreferenceOpen, setEnvironmentPanelPreferenceOpen] = useState<
    boolean | null
  >(null);
  const updateEnvironmentPanelPreference = useCallback(
    (open: boolean, persist: boolean) => {
      const update = resolveEnvironmentPanelPreferenceUpdate({ open, persist });
      setEnvironmentPanelPreferenceOpen(update.userPreferenceOpen);
      if (update.settingsDefaultOpen !== null) {
        updateSettings({ environmentPanelDefaultOpen: update.settingsDefaultOpen });
      }
    },
    [updateSettings],
  );
  const setEnvironmentPanelOpenPreference = useCallback(
    (open: boolean) => updateEnvironmentPanelPreference(open, true),
    [updateEnvironmentPanelPreference],
  );
  const closeEnvironmentPanelAfterAction = useCallback(
    () => updateEnvironmentPanelPreference(false, false),
    [updateEnvironmentPanelPreference],
  );
  const environmentPanelOpen = resolveEnvironmentPanelOpen({
    defaultOpen: environmentDefaultOpen,
    userPreferenceOpen: environmentPanelPreferenceOpen,
  });
  const environmentPanelVisible = resolveEnvironmentPanelVisible({
    environmentEnabled,
    environmentPanelOpen,
  });
  const githubRepositoryQuery = useQuery(
    gitGithubRepositoryQueryOptions(gitBranchSourceCwd, environmentPanelVisible),
  );
  const threadRecap = useThreadRecap({
    thread: activeThread,
    cwd: threadWorkspaceCwd,
    enabled: environmentPanelVisible,
    latestTurnSettled,
    codexHomePath: settings.codexHomePath || null,
    providerOptions: providerOptionsForDispatch ?? null,
  });
  const hasRightDockPanes = useRightDockStore(
    (store) => selectRightDockState(threadId)(store).panes.length > 0,
  );
  const setRightDockOpen = useRightDockStore((store) => store.setDockOpen);
  const toggleRightDock = useCallback(() => {
    setRightDockOpen(threadId, !rightDockOpen);
  }, [rightDockOpen, setRightDockOpen, threadId]);
  const terminalDrawerProps = useMemo(
    () => ({
      threadId,
      onTogglePanel: hasRightDockPanes ? toggleRightDock : undefined,
      isPanelOpen: hasRightDockPanes ? rightDockOpen : undefined,
      cwd: gitCwd ?? activeProject?.cwd ?? "",
      runtimeEnv: threadTerminalRuntimeEnv,
      height: terminalState.terminalHeight,
      terminalIds: terminalState.terminalIds,
      terminalLabelsById: terminalState.terminalLabelsById,
      terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
      terminalCliKindsById: terminalState.terminalCliKindsById,
      terminalAttentionStatesById: terminalState.terminalAttentionStatesById ?? {},
      runningTerminalIds: terminalState.runningTerminalIds,
      activeTerminalId: terminalState.activeTerminalId,
      terminalGroups: terminalState.terminalGroups,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      focusRequestId: terminalFocusRequestId,
      onSplitTerminal: splitTerminalRight,
      onSplitTerminalDown: splitTerminalDown,
      onNewTerminal: createNewTerminal,
      onNewTerminalTab: createNewTerminalTab,
      onMoveTerminalToGroup: moveTerminalToNewGroup,
      splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
      splitDownShortcutLabel: splitTerminalDownShortcutLabel ?? undefined,
      newShortcutLabel: newTerminalShortcutLabel ?? undefined,
      closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
      workspaceCloseShortcutLabel: closeWorkspaceShortcutLabel ?? undefined,
      onActiveTerminalChange: activateTerminal,
      onCloseTerminal: closeTerminal,
      onCloseTerminalGroup: (groupId: string) => {
        if (!activeThreadId) return;
        storeCloseTerminalGroup(activeThreadId, groupId);
      },
      onHeightChange: setTerminalHeight,
      onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => {
        if (!activeThreadId) return;
        storeResizeTerminalSplit(activeThreadId, groupId, splitId, weights);
      },
      onTerminalMetadataChange: (
        terminalId: string,
        metadata: { cliKind: "codex" | "claude" | "antigravity" | null; label: string },
      ) => {
        if (!activeThreadId) return;
        storeSetTerminalMetadata(activeThreadId, terminalId, metadata);
      },
      onTerminalActivityChange: (
        terminalId: string,
        activity: {
          hasRunningSubprocess: boolean;
          agentState: "running" | "attention" | "review" | null;
        },
      ) => {
        if (!activeThreadId) return;
        storeSetTerminalActivity(activeThreadId, terminalId, activity);
      },
      onAddTerminalContext: addTerminalContextToDraft,
    }),
    [
      activeProject?.cwd,
      activateTerminal,
      addTerminalContextToDraft,
      closeTerminal,
      closeTerminalShortcutLabel,
      closeWorkspaceShortcutLabel,
      createNewTerminal,
      createNewTerminalTab,
      moveTerminalToNewGroup,
      gitCwd,
      activeThreadId,
      newTerminalShortcutLabel,
      setTerminalHeight,
      splitTerminalRight,
      splitTerminalDown,
      splitTerminalShortcutLabel,
      splitTerminalDownShortcutLabel,
      storeCloseTerminalGroup,
      storeResizeTerminalSplit,
      storeSetTerminalActivity,
      storeSetTerminalMetadata,
      terminalFocusRequestId,
      terminalState.activeTerminalGroupId,
      terminalState.activeTerminalId,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalCliKindsById,
      terminalState.terminalGroups,
      terminalState.terminalHeight,
      terminalState.terminalIds,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
      terminalState.runningTerminalIds,
      threadId,
      threadTerminalRuntimeEnv,
      toggleRightDock,
      rightDockOpen,
      hasRightDockPanes,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: ProjectScriptRunOptions,
    ): Promise<ProjectScriptRunResult | null> => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return null;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const { shouldCreateNewTerminal, terminalId: targetTerminalId } =
        resolveProjectScriptTerminalTarget({
          baseTerminalId,
          createTerminalId: randomTerminalId,
          hasRunningTerminal: terminalState.runningTerminalIds.length > 0,
          preferNewTerminal: options?.preferNewTerminal,
          terminalOpen: terminalState.terminalOpen,
        });

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      requestTerminalFocus();

      try {
        const { metadata } = await runProjectCommandInTerminal({
          api,
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          project: {
            cwd: activeProject.cwd,
          },
          cwd: targetCwd,
          command: script.command,
          worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
          ...(options?.env ? { env: options.env } : {}),
        });
        if (metadata) {
          storeSetTerminalMetadata(activeThreadId, targetTerminalId, {
            cliKind: metadata.cliKind,
            label: metadata.label,
          });
        }
        return { terminalId: targetTerminalId };
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
        if (options?.throwOnError) {
          throw error instanceof Error
            ? error
            : new Error(`Failed to run script "${script.name}".`);
        }
        return null;
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      requestTerminalFocus,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      storeSetTerminalMetadata,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.terminalOpen,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const stopActiveThreadSession = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !isServerThread ||
      !activeThread ||
      activeThread.session === null ||
      activeThread.session.status === "closed"
    ) {
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, isServerThread]);
  const {
    handoffBusy,
    worktreeHandoffDialogOpen,
    setWorktreeHandoffDialogOpen,
    worktreeHandoffName,
    setWorktreeHandoffName,
    onHandoffToWorktree,
    onHandoffToLocal,
    confirmWorktreeHandoff,
  } = useThreadWorkspaceHandoff({
    activeProject,
    activeThread,
    activeRootBranch,
    activeThreadAssociatedWorktree,
    isServerThread,
    stopActiveThreadSession,
    runProjectScript,
  });
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      if (serverThread) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.runtime-mode.set",
              commandId: newCommandId(),
              threadId,
              runtimeMode: mode,
              createdAt: new Date().toISOString(),
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not update access mode",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              });
            });
        }
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      serverThread,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      if (serverThread) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.interaction-mode.set",
              commandId: newCommandId(),
              threadId,
              interactionMode: mode,
              createdAt: new Date().toISOString(),
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not update plan mode",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              });
            });
        }
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      serverThread,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        planSidebarDismissedForTurnRef.current =
          activeTaskList?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activeTaskList?.turnId, sidebarProposedPlan?.turnId]);
  const setPlanMode = useCallback(
    (enabled: boolean) => {
      handleInteractionModeChange(enabled ? "plan" : "default");
    },
    [handleInteractionModeChange],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThread.modelSelection.model ||
          input.modelSelection.provider !== serverThread.modelSelection.provider ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThread.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );

  // Scroll helpers stay list-owned so transcript updates stop bouncing through
  // a separate measurement/controller loop during streaming.
  // Guards isAtEndRef from flipping during reflow-induced scroll events that
  // fire immediately after an explicit scrollToEnd.
  const programmaticScrollUntilRef = useRef(0);
  // Smooth only the first auto-follow after a send; live stream re-sticks stay cheap.
  const animateNextAutoFollowScrollRef = useRef(false);
  const scrollToEnd = useCallback((animated = false) => {
    programmaticScrollUntilRef.current = performance.now() + 200;
    legendListRef.current?.scrollToEnd?.({ animated });
  }, []);
  const armTranscriptAutoFollow = useCallback((targetThreadId: ThreadId, animated = false) => {
    autoFollowThreadIdRef.current = targetThreadId;
    animateNextAutoFollowScrollRef.current = animated;
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, []);
  const clearTranscriptAutoFollow = useCallback(() => {
    autoFollowThreadIdRef.current = null;
    animateNextAutoFollowScrollRef.current = false;
  }, []);
  const transcriptMessageCount = useMemo(
    () => timelineEntries.filter((entry) => entry.kind === "message").length,
    [timelineEntries],
  );
  const latestTranscriptMessage = useMemo(() => {
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (entry?.kind === "message") {
        return entry.message;
      }
    }
    return null;
  }, [timelineEntries]);
  const transcriptTailKey = latestTranscriptMessage
    ? [
        latestTranscriptMessage.id,
        latestTranscriptMessage.role,
        latestTranscriptMessage.streaming ? "streaming" : "settled",
        latestTranscriptMessage.text.length > 0 ? "content" : "empty",
        latestTranscriptMessage.completedAt ?? "",
      ].join(":")
    : "empty";
  const transcriptAutoFollowSignal = buildTranscriptAutoFollowSignal({
    messageCount: transcriptMessageCount,
    tailKey: transcriptTailKey,
  });
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    if (!isAtEnd && performance.now() < programmaticScrollUntilRef.current) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const onMessagesClickCaptureBase = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollContainer = legendListRef.current?.getScrollableNode?.();
      if (!(scrollContainer instanceof HTMLElement) || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = legendListRef.current?.getScrollableNode?.();
        if (!(activeScrollContainer instanceof HTMLElement) || !anchor) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const onMessagesPointerCancelBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesPointerDownBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesPointerUpBase = useCallback(() => {}, []);
  const onMessagesScrollBase = useCallback(() => {}, []);
  const onMessagesTouchEndBase = useCallback(() => {}, []);
  const onMessagesTouchMoveBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesTouchStartBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesWheelBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  useLayoutEffect(() => {
    const shouldFollowPendingTurn =
      activeThread?.id !== undefined && autoFollowThreadIdRef.current === activeThread.id;
    if (!isAtEndRef.current && !shouldFollowPendingTurn) {
      return;
    }
    // Re-apply the bottom stick only for real transcript messages; tool/work
    // rows can arrive quickly and should not churn scroll/layout work.
    const frameId = window.requestAnimationFrame(() => {
      const shouldAnimate = animateNextAutoFollowScrollRef.current;
      animateNextAutoFollowScrollRef.current = false;
      scrollToEnd(shouldAnimate);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThread?.id, scrollToEnd, transcriptAutoFollowSignal]);
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
    dismissTranscriptSelectionAction,
    onMessagesClickCapture,
    onMessagesMouseUp,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  } = useTranscriptAssistantSelectionAction({
    threadId,
    enabled:
      Boolean(activeThread) &&
      !isInactiveSplitPane &&
      pendingUserInputs.length === 0 &&
      !isComposerApprovalState,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
    canReferenceAssistantSelection: (selection) =>
      !isPendingSetupBubbleId(MessageId.makeUnsafe(selection.assistantMessageId)),
    scheduleComposerFocus,
    onMessagesClickCaptureBase,
    onMessagesPointerCancelBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  });
  const createMarkerFromPendingSelection = useCallback(
    (style: ThreadMarkerStyle, color: ThreadMarkerColor) => {
      const pendingSelection = pendingTranscriptSelectionAction;
      if (!pendingSelection || !activeThreadId) {
        return;
      }
      const messageId = MessageId.makeUnsafe(pendingSelection.selection.assistantMessageId);
      if (isPendingSetupBubbleId(messageId)) {
        // Don't mark an ephemeral automation-setup bubble; it disappears when setup ends.
        dismissTranscriptSelectionAction();
        window.getSelection()?.removeAllRanges();
        return;
      }
      const message = timelineMessages.find((candidate) => candidate.id === messageId);
      if (!message) {
        toastManager.add({
          type: "warning",
          title: "Could not find the selected message.",
        });
        return;
      }
      const range = resolveTranscriptMarkerRange({
        messageText: message.text,
        selectedText: pendingSelection.selection.text,
      });
      if (!range) {
        toastManager.add({
          type: "warning",
          title: "Select a unique phrase to mark it.",
          description: "Try including a few more words so Synara can find the exact place.",
        });
        return;
      }
      dismissTranscriptSelectionAction();
      window.getSelection()?.removeAllRanges();
      const sameStyleOverlappingMarkers = threadMarkers.filter(
        (marker) =>
          marker.messageId === messageId &&
          marker.style === style &&
          marker.startOffset < range.endOffset &&
          range.startOffset < marker.endOffset,
      );
      if (sameStyleOverlappingMarkers.length > 0) {
        for (const marker of sameStyleOverlappingMarkers) {
          void dispatchThreadMarkerRemove(activeThreadId, marker.id).catch((error) => {
            console.error("Failed to remove thread marker", error);
            toastManager.add({
              type: "error",
              title: "Could not remove marker.",
            });
          });
        }
        return;
      }
      void dispatchThreadMarkerAdd({
        threadId: activeThreadId,
        markerId: ThreadMarkerId.makeUnsafe(crypto.randomUUID()),
        messageId,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        selectedText: message.text.slice(range.startOffset, range.endOffset),
        style,
        color,
      }).catch((error) => {
        console.error("Failed to create thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not create marker.",
        });
      });
    },
    [
      activeThreadId,
      dismissTranscriptSelectionAction,
      isPendingSetupBubbleId,
      pendingTranscriptSelectionAction,
      threadMarkers,
      timelineMessages,
    ],
  );
  const createHighlightFromPendingSelection = useCallback(() => {
    createMarkerFromPendingSelection("highlight", "yellow");
  }, [createMarkerFromPendingSelection]);
  const createUnderlineFromPendingSelection = useCallback(() => {
    createMarkerFromPendingSelection("underline", "blue");
  }, [createMarkerFromPendingSelection]);

  useLayoutEffect(() => {
    if (isInactiveSplitPane) return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const syncComposerFooterLayout = () => {
      const composerFormWidth = measureComposerFormWidth();
      const nextCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));
      // Tier the footer controls by MEASURED overflow: demote one step while
      // the footer row's content is wider than the row, promote back (with
      // hysteresis) when the recorded overflow width is comfortably exceeded.
      const footerRow = composerForm.querySelector<HTMLElement>("[data-chat-composer-footer]");
      if (footerRow) {
        const rowOverflows = footerRow.scrollWidth > footerRow.clientWidth + 1;
        // The leading cluster clips (overflow-hidden) in compact mode instead
        // of growing the row's scrollWidth, so check it directly — a clipped
        // "+"/access-rules cluster must also demote the tier.
        const leadingCluster = footerRow.querySelector<HTMLElement>("[data-chat-composer-leading]");
        const leadingClips =
          nextCompact &&
          leadingCluster !== null &&
          leadingCluster.scrollWidth > leadingCluster.clientWidth + 1;
        const nextStep = resolveNextComposerFooterTier({
          currentTier: composerFooterTierRef.current,
          clientWidth: footerRow.clientWidth,
          isOverflowing: rowOverflows || leadingClips,
          demotionWidths: composerFooterDemotionWidthsRef.current,
        });
        composerFooterDemotionWidthsRef.current = nextStep.demotionWidths;
        if (nextStep.tier !== composerFooterTierRef.current) {
          composerFooterTierRef.current = nextStep.tier;
          setComposerFooterTier(nextStep.tier);
        }
      }
    };
    composerFooterLayoutSyncRef.current = syncComposerFooterLayout;

    const measuredHeight = Math.ceil(composerForm.getBoundingClientRect().height);
    composerFormHeightRef.current = measuredHeight;
    if (measuredHeight > 0) {
      setSecondaryChromePlaceholderHeight((current) =>
        current === measuredHeight ? current : measuredHeight,
      );
    }
    syncComposerFooterLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      syncComposerFooterLayout();

      const nextHeight = entry.contentRect.height;
      composerFormHeightRef.current = nextHeight;
      const roundedNextHeight = Math.ceil(nextHeight);
      if (roundedNextHeight > 0) {
        setSecondaryChromePlaceholderHeight((current) =>
          current === roundedNextHeight ? current : roundedNextHeight,
        );
      }
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions, isInactiveSplitPane]);

  useLayoutEffect(() => {
    if (isInactiveSplitPane || typeof ResizeObserver === "undefined") return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;

    let previousHeight = composerForm.getBoundingClientRect().height;
    let pendingScrollTimeout: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextHeight = entry.contentRect.height;
      const heightDelta = nextHeight - previousHeight;
      previousHeight = nextHeight;
      if (Math.abs(heightDelta) < 0.5) return;

      const scrollContainer = legendListRef.current?.getScrollableNode?.();
      // A composer resize can make LegendList report `isAtEnd: false` after the viewport
      // has already changed. Reconstruct the pre-resize viewport so only an existing
      // tail stick is preserved; a user who was already scrolled away stays there.
      const wasNearEndBeforeResize =
        scrollContainer instanceof HTMLElement &&
        isScrollContainerNearBottom({
          scrollTop: scrollContainer.scrollTop,
          clientHeight: scrollContainer.clientHeight + heightDelta,
          scrollHeight: scrollContainer.scrollHeight,
        });
      if (!wasNearEndBeforeResize) return;

      if (pendingScrollTimeout !== null) {
        window.clearTimeout(pendingScrollTimeout);
      }
      pendingScrollTimeout = window.setTimeout(() => {
        pendingScrollTimeout = null;
        scrollToEnd(false);
      }, 0);
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
      if (pendingScrollTimeout !== null) {
        window.clearTimeout(pendingScrollTimeout);
      }
    };
  }, [
    activeThread?.id,
    isInactiveSplitPane,
    scrollToEnd,
    secondaryChromeReady,
    shouldRenderChatPaneContent,
  ]);

  useEffect(() => {
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    // Capture the carried sidebar-open intent synchronously (ref reads/writes stay
    // in render->commit order); defer only the setState so this thread-change reset
    // stays out of the render->effect->render cascade.
    const openPlanSidebar = planSidebarOpenOnNextThreadRef.current;
    planSidebarOpenOnNextThreadRef.current = false;
    planSidebarDismissedForTurnRef.current = null;
    const settle = window.setTimeout(() => {
      setPullRequestDialogState(null);
      setRenameDialogOpen(false);
      setShowScrollToBottom(false);
      setPlanSidebarOpen(openPlanSidebar);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen || isInactiveSplitPane) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isInactiveSplitPane, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles]);

  useEffect(() => {
    composerAssistantSelectionsRef.current = composerAssistantSelections;
  }, [composerAssistantSelections]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    composerFileCommentsRef.current = composerFileComments;
  }, [composerFileComments]);

  useEffect(() => {
    composerPastedTextsRef.current = composerPastedTexts;
  }, [composerPastedTexts]);

  useEffect(() => {
    queuedComposerTurnsRef.current = queuedComposerTurns;
  }, [queuedComposerTurns]);

  useEffect(() => {
    autoDispatchingQueuedTurnRef.current = false;
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setQueuedSteerGate(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [threadId]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    // No optimistic messages → nothing to reconcile; skip the full-transcript id Set
    // this effect would otherwise rebuild on every streaming flush.
    if (optimisticUserMessages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    promptRef.current = prompt;
    if (
      promptHistoryNavigationRef.current !== null &&
      prompt !== promptHistoryAppliedPromptRef.current
    ) {
      // Another writer (queued-turn restore, automation restore, insertion)
      // replaced the prompt while a history browse was active. The new prompt
      // is authoritative: end the browse and drop the saved pre-browse draft
      // so it cannot clobber this prompt later.
      promptHistoryNavigationRef.current = null;
      expectedPromptHistoryPromptRef.current = null;
      setComposerDraftPromptHistorySavedDraft(threadId, null);
    }
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, setComposerDraftPromptHistorySavedDraft, threadId]);

  useLayoutEffect(() => {
    updateSelectedComposerSkills(composerSkills);
    updateSelectedComposerMentions(composerMentions);
  }, [
    composerMentions,
    composerSkills,
    threadId,
    updateSelectedComposerMentions,
    updateSelectedComposerSkills,
  ]);

  useEffect(() => {
    updateSelectedComposerSkills((existing) => {
      const nextSkills = filterPromptSkillReferences(prompt, existing, selectedProvider);
      return providerSkillReferencesEqual(existing, nextSkills) ? existing : nextSkills;
    });
  }, [prompt, selectedProvider, updateSelectedComposerSkills]);

  useEffect(() => {
    updateSelectedComposerMentions((existing) => {
      const nextMentions = filterPromptProviderMentionReferences(prompt, existing);
      return providerMentionReferencesEqual(existing, nextMentions) ? existing : nextMentions;
    });
  }, [prompt, updateSelectedComposerMentions]);

  // Provider references are provider-specific; keep draft restores from looking like manual switches.
  useEffect(() => {
    const previous = previousSelectedProviderRef.current;
    previousSelectedProviderRef.current = {
      threadId,
      provider: selectedProvider,
    };
    if (!previous || previous.threadId !== threadId || previous.provider === selectedProvider) {
      return;
    }
    updateSelectedComposerSkills([]);
    updateSelectedComposerMentions([]);
  }, [selectedProvider, threadId, updateSelectedComposerMentions, updateSelectedComposerSkills]);

  useLayoutEffect(() => {
    // ChatView stays mounted across thread switches, so clear thread-local overlays before paint.
    setOptimisticUserMessages((existing) => {
      if (existing.length === 0) return existing;
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setExpandedImage(null);
  }, [threadId]);

  useEffect(() => {
    dragDepthRef.current = 0;
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade. The pre-paint overlay clear (optimistic
    // messages, expanded image) lives in the layout effect above, so deferring
    // these residual resets by a tick is imperceptible.
    const settle = window.setTimeout(() => {
      setOptimisticUserMessages((existing) => {
        if (existing.length === 0) return existing;
        for (const message of existing) {
          revokeUserMessagePreviewUrls(message);
        }
        return [];
      });
      setLocalDispatch(null);
      setComposerHighlightedItemId(null);
      setComposerCursor(
        collapseExpandedComposerCursor(promptRef.current, promptRef.current.length),
      );
      setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
      setIsDragOverComposer(false);
      setExpandedImage(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        const hasDeferredBlobAttachment =
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.persistedAttachments.some(
              (attachment) => attachment.blobKey,
            ) ?? false;
        if (hasDeferredBlobAttachment) {
          return;
        }
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const staged = await stagePersistedComposerImageAttachments({
        threadId,
        images: composerImages,
        getPersistedAttachments: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [],
      });
      if (cancelled) {
        return;
      }
      // Stage attachments in persisted draft state first so persist middleware can write them.
      void syncComposerDraftPersistedAttachments(threadId, staged);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  useEffect(() => {
    if (
      !composerPromptHistorySavedDraftImages ||
      composerPromptHistorySavedDraftImages.length === 0
    ) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const staged = await stagePersistedComposerImageAttachments({
        threadId,
        images: composerPromptHistorySavedDraftImages,
        getPersistedAttachments: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
            ?.persistedAttachments ?? [],
      });
      if (cancelled) {
        return;
      }
      void syncComposerDraftPromptHistorySavedDraftPersistedAttachments(threadId, staged);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerPromptHistorySavedDraftImages,
    syncComposerDraftPromptHistorySavedDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  useEffect(() => {
    if (!composerMenuOpen) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setComposerCommandPicker(null);
      setComposerHighlightedItemId(null);
      setComposerTrigger(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composerMenuOpen]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = isServerThread
    ? resolveThreadEnvironmentMode({
        envMode: activeThread?.envMode,
        worktreePath: activeWorktreePath ?? null,
      })
    : (draftThread?.envMode ?? "local");
  const envState = resolveThreadWorkspaceState({
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });

  const beginLocalDispatch = useCallback(
    (options?: WorktreeSetupDispatchOptions) => {
      setLocalDispatch((current) => {
        const next = resolveNextLocalDispatchSnapshot(
          options ? { current, activeThread, options } : { current, activeThread },
        );
        if (next !== current) {
          failedWorktreeSetupDispatchStartedAtRef.current = null;
        }
        return next;
      });
    },
    [activeThread],
  );

  const failLocalDispatchWorktreeSetup = useCallback(() => {
    setLocalDispatch((current) => {
      if (!current?.worktreeSetup) {
        return current;
      }
      const failed = failWorktreeSetupSnapshot(current.worktreeSetup);
      failedWorktreeSetupDispatchStartedAtRef.current = current.startedAt;
      return failed === current.worktreeSetup ? current : { ...current, worktreeSetup: failed };
    });
  }, []);

  const resetLocalDispatch = useCallback(() => {
    failedWorktreeSetupDispatchStartedAtRef.current = null;
    setLocalDispatch(null);
  }, []);

  // Fallback cleanup for a failed worktree setup: clears the dispatch after the
  // error hold unless a newer dispatch already replaced it.
  const scheduleFailedWorktreeSetupDispatchReset = useCallback(() => {
    const failedDispatchStartedAt = failedWorktreeSetupDispatchStartedAtRef.current;
    window.setTimeout(() => {
      setLocalDispatch((current) => {
        if (
          !failedDispatchStartedAt ||
          !current ||
          current.startedAt !== failedDispatchStartedAt ||
          !worktreeSetupHasError(current.worktreeSetup)
        ) {
          return current;
        }
        failedWorktreeSetupDispatchStartedAtRef.current = null;
        return null;
      });
    }, WORKTREE_SETUP_ERROR_HOLD_MS);
  }, []);

  const localDispatchWorktreeSetupFailed = worktreeSetupHasError(activeWorktreeSetup);
  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    // A failed worktree setup would otherwise reset in the same commit that
    // painted the error (thread errors count as acknowledgement), so hold the
    // row briefly before letting it animate out.
    if (localDispatchWorktreeSetupFailed) {
      const failedDispatchStartedAt = localDispatch?.startedAt;
      if (!failedDispatchStartedAt) {
        return;
      }
      const holdTimeout = window.setTimeout(() => {
        setLocalDispatch((current) => {
          if (
            !current ||
            current.startedAt !== failedDispatchStartedAt ||
            !worktreeSetupHasError(current.worktreeSetup)
          ) {
            return current;
          }
          failedWorktreeSetupDispatchStartedAtRef.current = null;
          return null;
        });
      }, WORKTREE_SETUP_ERROR_HOLD_MS);
      return () => window.clearTimeout(holdTimeout);
    }
    resetLocalDispatch();
  }, [
    localDispatch?.startedAt,
    localDispatchWorktreeSetupFailed,
    resetLocalDispatch,
    serverAcknowledgedLocalDispatch,
  ]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      requestTerminalFocus();
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, requestTerminalFocus, terminalState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadId) {
      activatedThreadIdRef.current = null;
      return;
    }
    if (activatedThreadIdRef.current === activeThreadId) {
      return;
    }
    activatedThreadIdRef.current = activeThreadId;
    if (terminalState.entryPoint !== "terminal") {
      return;
    }
    storeOpenTerminalThreadPage(activeThreadId);
  }, [activeThreadId, storeOpenTerminalThreadPage, terminalState.entryPoint]);

  useEffect(() => {
    if (!terminalWorkspaceOpen) {
      return;
    }

    if (terminalState.workspaceActiveTab === "terminal") {
      requestTerminalFocus();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    focusComposer,
    requestTerminalFocus,
    terminalState.workspaceActiveTab,
    terminalWorkspaceOpen,
  ]);

  const onInterrupt = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread]);

  const onStopWorkflowRun = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || !workflowRunState) return;
    await api.orchestration.dispatchCommand({
      type: "thread.task.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      taskId: workflowRunState.workflowTaskId,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, workflowRunState]);

  const onBackgroundSubagentStripItem = useCallback(
    async (item: ComposerSubagentStripItem) => {
      const api = readNativeApi();
      // The Task tool_use lives on the strip source thread (the parent while a
      // subagent thread is open), so route the command there.
      if (!api || !stripSourceThreadId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.task.background",
        commandId: newCommandId(),
        threadId: stripSourceThreadId,
        toolUseId: item.providerThreadId,
        createdAt: new Date().toISOString(),
      });
    },
    [stripSourceThreadId],
  );

  // Stop goes through the interrupt seam: on a subagent thread the reactor
  // resolves the tool_use_id and stops that task instead of the whole turn.
  // Target the canonical child id derived from the strip source thread —
  // item.threadId can still be the raw tool_use_id while client-side thread
  // resolution lags, which the server would reject as an unknown thread.
  const onStopSubagentStripItem = useCallback(
    async (item: ComposerSubagentStripItem) => {
      const api = readNativeApi();
      if (!api || !stripSourceThreadId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: localSubagentThreadId(stripSourceThreadId, item.providerThreadId),
        createdAt: new Date().toISOString(),
      });
    },
    [stripSourceThreadId],
  );

  // Stop-all fans out through the same per-row stop so both paths share one seam.
  const onStopAllSubagentStripItems = useCallback(async () => {
    const running = collectRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(running.map((item) => onStopSubagentStripItem(item)));
  }, [composerSubagentStripItems, onStopSubagentStripItem]);

  // Ctrl+B parity with the native CLI: send every foreground running subagent to
  // the background at once, fanning through the same per-row background dispatch.
  const onBackgroundAllForegroundSubagentStripItems = useCallback(async () => {
    const foreground = collectForegroundRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(foreground.map((item) => onBackgroundSubagentStripItem(item)));
  }, [composerSubagentStripItems, onBackgroundSubagentStripItem]);

  // Pause is the same stop command; the persisted flag makes the settled card
  // read as paused (with a resume affordance) instead of plain stopped, across
  // reloads too.
  const onPauseWorkflowRun = useCallback(async () => {
    if (!workflowRunState || !activeThreadId) return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunPaused(activeThreadId, workflowTaskId);
    await onStopWorkflowRun();
  }, [activeThreadId, markWorkflowRunPaused, onStopWorkflowRun, workflowRunState]);

  const onDismissWorkflowRun = useCallback(() => {
    if (!workflowRunState || !activeThreadId) return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunDismissed(activeThreadId, workflowTaskId);
  }, [activeThreadId, markWorkflowRunDismissed, workflowRunState]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedModel = resolveCommittedProviderModel({
        selectedModel: model,
        availableOptions: modelOptionsByProvider[provider],
        fallback: () => resolveAppModelSelection(provider, customModelsByProvider, model),
      });
      const nextModelSelection: ModelSelection = {
        provider,
        model: resolvedModel,
      };
      setComposerDraftModelSelectionAndSticky(activeThread.id, nextModelSelection);
      if (provider === "cursor") {
        setComposerDraftProviderModelOptions(activeThread.id, provider, undefined, {
          persistSticky: true,
          model: resolvedModel,
        });
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelectionAndSticky,
      setComposerDraftProviderModelOptions,
      customModelsByProvider,
      modelOptionsByProvider,
    ],
  );

  useEffect(() => {
    if (surfaceMode === "split" && !isFocusedPane) {
      return;
    }

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      // Mirror terminal interrupt semantics without stealing regular copy shortcuts.
      if (
        hasLiveTurn &&
        isMacPlatform(navigator.platform) &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        eventTargetsComposer(event, composerFormRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void onInterrupt();
        return;
      }
      // Ctrl+B mirrors the native CLI: background all foreground running
      // subagents. Literal Ctrl on every platform, but stays out of the
      // terminal, where Ctrl+B is real shell input (readline cursor-back,
      // tmux prefix), and out of text-editing surfaces, where Ctrl+B is the
      // native macOS "move cursor back" binding. Silent no-op (event
      // untouched) when nothing qualifies.
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b" &&
        !isTerminalFocused() &&
        !isEditableEventTarget(event) &&
        collectForegroundRunningSubagentStripItems(composerSubagentStripItems).length > 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        void onBackgroundAllForegroundSubagentStripItems();
        return;
      }
      const composerPickerShortcutActive =
        !isTerminalFocused() &&
        !isVoiceRecording &&
        !isVoiceTranscribing &&
        !isComposerApprovalState &&
        canHandleComposerPickerShortcut(event, composerFormRef.current);
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        terminalWorkspaceOpen,
        terminalWorkspaceTerminalOnly: terminalState.workspaceLayout === "terminal-only",
        terminalWorkspaceTerminalTabActive,
        terminalWorkspaceChatTabActive,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "composer.focus.toggle") {
        if (isComposerApprovalState || isVoiceRecording || isVoiceTranscribing) return;
        event.preventDefault();
        event.stopPropagation();
        toggleComposerFocus();
        return;
      }

      if (command === "modelPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleModelPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "model.next" || command === "model.previous") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = command === "model.next" ? "next" : "previous";
        const providerOptions = modelOptionsByProvider[selectedProvider] ?? [];
        const nextSlug = resolveCycledModelSlug({
          currentModel: selectedModel,
          options: providerOptions,
          favoriteSlugs: readFavoriteModelSlugs(selectedProvider),
          direction,
        });
        if (!nextSlug) return;
        onProviderModelSelect(selectedProvider, nextSlug as ModelSlug);
        return;
      }

      if (command === "traitsPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleTraitsPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split" || command === "terminal.splitRight") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalRight();
        return;
      }

      if (command === "terminal.splitLeft") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalLeft();
        return;
      }

      if (command === "terminal.splitDown") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalDown();
        return;
      }

      if (command === "terminal.splitUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalUp();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        createTerminalFromShortcut();
        return;
      }

      if (command === "terminal.workspace.newFullWidth") {
        event.preventDefault();
        event.stopPropagation();
        openNewFullWidthTerminal();
        return;
      }

      if (command === "terminal.workspace.closeActive") {
        event.preventDefault();
        event.stopPropagation();
        closeActiveWorkspaceView();
        return;
      }

      if (command === "terminal.workspace.terminal") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalWorkspaceOpen) return;
        setTerminalWorkspaceTab("terminal");
        return;
      }

      if (command === "terminal.workspace.chat") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalWorkspaceOpen) return;
        setTerminalWorkspaceTab("chat");
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "git.commitAndPush") {
        if (commitAndPushTriggerRef.current) {
          event.preventDefault();
          event.stopPropagation();
          commitAndPushTriggerRef.current();
          return;
        }
        // No registered trigger inside a git-enabled thread means the action just
        // isn't runnable right now (clean tree, behind upstream, action in flight)
        // — tell the user instead of eating the chord silently. Outside git threads
        // the chord falls through untouched.
        if (showGitActions && isGitRepo) {
          event.preventDefault();
          event.stopPropagation();
          toastManager.add({
            type: "info",
            title: "Nothing to commit or push.",
          });
        }
        return;
      }

      if (command === "browser.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!isElectron) return;
        onToggleBrowser();
        return;
      }

      if (command === "chat.split") {
        event.preventDefault();
        event.stopPropagation();
        if (surfaceMode === "single" && onSplitSurface) {
          onSplitSurface();
        }
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    terminalState.workspaceLayout,
    activeThreadId,
    closeTerminal,
    closeActiveWorkspaceView,
    createTerminalFromShortcut,
    setTerminalOpen,
    openNewFullWidthTerminal,
    runProjectScript,
    keybindings,
    splitTerminalDown,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalUp,
    terminalWorkspaceChatTabActive,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    onToggleBrowser,
    onToggleDiff,
    onInterrupt,
    onSplitSurface,
    showGitActions,
    isGitRepo,
    composerSubagentStripItems,
    onBackgroundAllForegroundSubagentStripItems,
    isFocusedPane,
    hasLiveTurn,
    handleModelPickerOpenChange,
    handleTraitsPickerOpenChange,
    isComposerApprovalState,
    isVoiceRecording,
    isVoiceTranscribing,
    setTerminalWorkspaceTab,
    surfaceMode,
    scheduleComposerFocus,
    toggleComposerFocus,
    toggleTerminalVisibility,
    activeThread,
    selectedProvider,
    selectedModel,
    modelOptionsByProvider,
    onProviderModelSelect,
  ]);

  // Preserve the original "single mic button" contract:
  // first click starts recording, the next click submits/transcribes.
  const toggleComposerVoiceRecording = useCallback(() => {
    if (isVoiceTranscribing) {
      return;
    }
    if (isVoiceRecording) {
      void submitComposerVoiceRecording();
      return;
    }
    void startComposerVoiceRecording();
  }, [
    isVoiceRecording,
    isVoiceTranscribing,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
  ]);

  // --- Composer attachment entry points -------------------------------------
  const addComposerImages = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach images after answering plan questions.",
        });
        return;
      }

      const { images: nextImages, error } = buildComposerImageAttachmentsFromFiles({
        files,
        existingAttachmentCount: effectiveComposerAttachmentCount(
          useComposerDraftStore.getState().draftsByThreadId[activeThreadId],
        ),
      });

      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      setThreadError(activeThreadId, error);
    },
    [
      activeThreadId,
      addComposerImage,
      addComposerImagesToDraft,
      pendingUserInputs.length,
      setThreadError,
    ],
  );

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const addComposerFiles = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach files after answering plan questions.",
        });
        return;
      }

      const { files: nextFiles, error } = buildComposerFileAttachmentsFromFiles({
        files,
        existingAttachmentCount: effectiveComposerAttachmentCount(
          useComposerDraftStore.getState().draftsByThreadId[activeThreadId],
        ),
      });

      if (nextFiles.length > 0) {
        addComposerFilesToDraft(nextFiles);
      }
      setThreadError(activeThreadId, error);
    },
    [activeThreadId, addComposerFilesToDraft, pendingUserInputs.length, setThreadError],
  );

  const removeComposerFile = (fileId: string) => {
    discardPromptHistoryNavigationForComposerMutation();
    removeComposerDraftFile(threadId, fileId);
  };

  const {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = useComposerDropzone({
    addImages: addComposerImages,
    fileSupport: {
      genericFiles: "accept",
      addFiles: addComposerFiles,
    },
    appendReferenceText: (referenceText) => appendComposerPromptText(threadId, referenceText),
    appendPathMentions: (paths) => {
      for (const absolutePath of paths) {
        appendComposerPromptText(threadId, formatComposerMentionToken(absolutePath));
      }
    },
    dragDepthRef,
    focusComposer,
    setIsDragOverComposer,
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          scope: "thread",
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeThread, hasLiveTurn, isConnecting, isRevertingCheckpoint, isSendBusy, setThreadError],
  );

  const onUndoTurnFiles = useCallback(
    async (turnCounts: readonly number[]) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint || turnCounts.length === 0) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before undoing file changes.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          "Undo the latest file changes shown in this card?",
          "Earlier file changes will remain available to undo.",
          "Messages and provider conversation history will be kept.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) return;

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const turnCount = Math.max(...turnCounts);
      const requestedAt = new Date().toISOString();
      setPendingFileUndo({
        threadId: activeThread.id,
        turnCount,
        existingFailureActivityIds: activeThread.activities
          .filter((activity) => activity.kind === "checkpoint.revert.failed")
          .map((activity) => activity.id),
      });
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          scope: "files",
          createdAt: requestedAt,
        });
      } catch (err) {
        setPendingFileUndo(null);
        setIsRevertingCheckpoint(false);
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to undo file changes.",
        );
      }
    },
    [activeThread, hasLiveTurn, isConnecting, isRevertingCheckpoint, isSendBusy, setThreadError],
  );

  const onCreateHandoffThread = useCallback(
    async (targetProvider: ProviderKind) => {
      if (!activeThread || handoffDisabled) {
        return;
      }

      try {
        await createThreadHandoff(activeThread, targetProvider);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not create handoff thread",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the handoff thread.",
        });
      }
    },
    [activeThread, createThreadHandoff, handoffDisabled],
  );

  const clearComposerInput = useCallback(
    (threadId: ThreadId) => {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      setRestoredQueuedSourceProposedPlan(threadId, null);
      clearComposerDraftContent(threadId);
      updateSelectedComposerSkills([]);
      updateSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [
      clearComposerDraftContent,
      setRestoredQueuedSourceProposedPlan,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const createAutomationFromForm = useCallback(
    async (input: {
      readonly form: AutomationFormState;
      readonly warnings: readonly AutomationDraftWarning[];
      readonly acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>;
      readonly providerOptions?: ProviderStartOptions;
      readonly activityThreadId?: ThreadId | null;
    }): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeProject) {
        return false;
      }
      if (automationDraftSubmittingRef.current) {
        return false;
      }
      if (!isFormSubmittable(input.form)) {
        return false;
      }
      if (hasBlockingAutomationDraftWarnings(input.warnings, input.acknowledgedWarningIds)) {
        return false;
      }
      const acknowledgedRisks = acknowledgedRiskIdsForDraft(
        input.warnings,
        input.acknowledgedWarningIds,
      );
      const activityThreadId =
        input.activityThreadId ?? (isServerThread ? (activeThread?.id ?? null) : null);
      const createdAt = new Date().toISOString();
      const automationInput = createInputFromForm(
        input.form,
        input.providerOptions ?? providerOptionsForDispatch,
        acknowledgedRisks,
        activityThreadId,
      );
      automationDraftSubmittingRef.current = true;
      setIsAutomationDraftSubmitting(true);
      return await (async () => {
        const definition = await api.automation.create(automationInput);
        if (activityThreadId) {
          void (async () => {
            try {
              await api.orchestration.dispatchCommand({
                type: "thread.activity.append",
                commandId: newCommandId(),
                threadId: activityThreadId,
                activity: {
                  id: EventId.makeUnsafe(randomUUID()),
                  tone: "info",
                  kind: "automation.created",
                  summary: `Created automation: ${definition.name} - ${formatCadence(definition.schedule)}`,
                  payload: {
                    source: "chat-composer",
                    automationId: definition.id,
                    automationName: definition.name,
                    mode: definition.mode,
                    cadenceLabel: formatCadence(definition.schedule),
                    schedule: automationScheduleActivityPayload(definition.schedule),
                  },
                  turnId: null,
                  createdAt,
                },
                createdAt,
              });
            } catch {
              toastManager.add({
                type: "warning",
                title: "Thread note not added",
                description:
                  "The automation was created, but Synara could not add the activity note.",
              });
            }
          })();
        }
        void queryClient.invalidateQueries({ queryKey: automationQueryKey });
        clearComposerInput(activeThread?.id ?? threadId);
        resetAutomationDraftState();
        toastManager.add({
          type: "success",
          title: "Automation created",
          description: `${definition.name} - ${formatCadence(definition.schedule)}`,
        });
        return true;
      })()
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not create automation",
            description:
              error instanceof Error ? error.message : "Synara could not save the automation.",
          });
          return false;
        })
        .finally(() => {
          automationDraftSubmittingRef.current = false;
          setIsAutomationDraftSubmitting(false);
        });
    },
    [
      activeProject,
      activeThread,
      automationDraftSubmittingRef,
      clearComposerInput,
      isServerThread,
      providerOptionsForDispatch,
      queryClient,
      resetAutomationDraftState,
      setIsAutomationDraftSubmitting,
      threadId,
    ],
  );

  const ensureAutomationTargetThread = useCallback(
    async (input: {
      readonly titleSeed: string;
      readonly threadModelSelection: ModelSelection;
      readonly threadRuntimeMode: RuntimeMode;
      readonly threadInteractionMode: ProviderInteractionMode;
    }): Promise<ThreadId | null> => {
      const api = readNativeApi();
      if (!api || !activeProject || !activeThread) {
        toastManager.add({
          type: "warning",
          title: "Chat required",
          description: "Open a chat before creating a chat-bound automation.",
        });
        return null;
      }
      if (isServerThread) {
        return activeThread.id;
      }

      const title = buildPromptThreadTitleFallback(input.titleSeed || GENERIC_CHAT_THREAD_TITLE);
      try {
        const result = await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId: activeThread.id,
            projectId: activeProject.id,
            title,
            modelSelection: input.threadModelSelection,
            runtimeMode: input.threadRuntimeMode,
            interactionMode: input.threadInteractionMode,
            envMode: activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local"),
            branch: activeThread.branch ?? null,
            worktreePath: activeThread.worktreePath ?? null,
            associatedWorktreePath: activeThreadAssociatedWorktree.associatedWorktreePath,
            associatedWorktreeBranch: activeThreadAssociatedWorktree.associatedWorktreeBranch,
            associatedWorktreeRef: activeThreadAssociatedWorktree.associatedWorktreeRef,
            lastKnownPr: activeThread.lastKnownPr ?? null,
            createdAt: activeThread.createdAt,
          },
          api,
          { force: true },
        );
        if (result === "unavailable") {
          toastManager.add({
            type: "error",
            title: "Could not create chat",
            description: "Synara could not promote this draft before saving the automation.",
          });
          return null;
        }

        const inheritedProjectInstructions =
          useProjectInstructionsStore.getState().instructionsByProjectId[activeProject.id] ?? "";
        const inheritedThreadNotes = mergeProjectInstructionsIntoThreadNotes({
          threadNotes,
          projectInstructions: inheritedProjectInstructions,
        });
        if (inheritedThreadNotes !== threadNotes && inheritedThreadNotes.trim().length > 0) {
          void dispatchThreadNotes(activeThread.id, inheritedThreadNotes).catch(() => undefined);
        }

        return activeThread.id;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not create chat",
          description:
            error instanceof Error
              ? error.message
              : "Synara could not promote this draft before saving the automation.",
        });
        return null;
      }
    },
    [activeProject, activeThread, activeThreadAssociatedWorktree, isServerThread, threadNotes],
  );

  const prepareAutomationFormForCreate = useCallback(
    async (
      form: AutomationFormState,
    ): Promise<{
      readonly form: AutomationFormState;
      readonly activityThreadId: ThreadId | null;
    } | null> => {
      const activityThreadId = isServerThread ? (activeThread?.id ?? null) : null;
      if (form.mode !== "heartbeat" || !activeThread) {
        return { form, activityThreadId };
      }
      if (isServerThread || form.targetThreadId !== activeThread.id) {
        return { form, activityThreadId };
      }

      // Draft review can keep the local draft ID in the form; promote it only when
      // the automation is actually submitted so cancelling review leaves no empty thread.
      const targetThreadId = await ensureAutomationTargetThread({
        titleSeed: form.prompt || form.name,
        threadModelSelection: selectedModelSelection,
        threadRuntimeMode: runtimeMode,
        threadInteractionMode: interactionMode,
      });
      if (!targetThreadId) {
        return null;
      }
      return {
        form: { ...form, targetThreadId },
        activityThreadId: targetThreadId,
      };
    },
    [
      activeThread,
      ensureAutomationTargetThread,
      interactionMode,
      isServerThread,
      runtimeMode,
      selectedModelSelection,
    ],
  );

  const updateAutomationFromForm = useCallback(
    async (input: {
      readonly definition: AutomationDefinition;
      readonly form: AutomationFormState;
      readonly warnings: readonly AutomationDraftWarning[];
      readonly acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>;
      readonly providerOptions?: ProviderStartOptions;
    }): Promise<boolean> => {
      if (automationDraftSubmittingRef.current) {
        return false;
      }
      if (!isFormSubmittable(input.form)) {
        return false;
      }
      if (hasBlockingAutomationDraftWarnings(input.warnings, input.acknowledgedWarningIds)) {
        return false;
      }
      const acknowledgedRisks = acknowledgedRiskIdsForFormWarnings(
        input.warnings,
        input.acknowledgedWarningIds,
      );
      automationDraftSubmittingRef.current = true;
      setIsAutomationDraftSubmitting(true);
      return await (async () => {
        const providerOptions =
          input.providerOptions ??
          providerOptionsForAutomationEdit(
            input.definition,
            input.form,
            providerOptionsForDispatch,
          );
        const updated = await automationUpdateMutation.mutateAsync(
          updateInputFromForm(input.definition, input.form, providerOptions, acknowledgedRisks),
        );
        resetAutomationDraftState();
        toastManager.add({
          type: "success",
          title: "Automation updated",
          description: `${updated.name} - ${formatCadence(updated.schedule)}`,
        });
        return true;
      })()
        .catch(() => false)
        .finally(() => {
          automationDraftSubmittingRef.current = false;
          setIsAutomationDraftSubmitting(false);
        });
    },
    [
      automationDraftSubmittingRef,
      automationUpdateMutation,
      providerOptionsForDispatch,
      resetAutomationDraftState,
      setIsAutomationDraftSubmitting,
    ],
  );

  const submitAutomationDraft = useCallback(async () => {
    if (!automationDraftForm) {
      return;
    }
    if (automationEditingDefinition) {
      await updateAutomationFromForm({
        definition: automationEditingDefinition,
        form: automationDraftForm,
        warnings: automationDraftWarnings,
        acknowledgedWarningIds: acknowledgedAutomationWarnings,
      });
      return;
    }
    if (
      !isFormSubmittable(automationDraftForm) ||
      hasBlockingAutomationDraftWarnings(automationDraftWarnings, acknowledgedAutomationWarnings)
    ) {
      return;
    }
    const preparedCreate = await prepareAutomationFormForCreate(automationDraftForm);
    if (!preparedCreate) {
      return;
    }
    await createAutomationFromForm({
      form: preparedCreate.form,
      warnings: automationDraftWarnings,
      acknowledgedWarningIds: acknowledgedAutomationWarnings,
      activityThreadId: preparedCreate.activityThreadId,
    });
  }, [
    acknowledgedAutomationWarnings,
    automationEditingDefinition,
    automationDraftForm,
    automationDraftWarnings,
    createAutomationFromForm,
    prepareAutomationFormForCreate,
    updateAutomationFromForm,
  ]);

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt = queuedTurn.kind === "chat" ? queuedTurn.prompt : queuedTurn.text;
      const restoredImages =
        queuedTurn.kind === "chat" ? queuedTurn.images.map(cloneComposerImageAttachment) : [];
      const restoredFiles = queuedTurn.kind === "chat" ? queuedTurn.files : [];
      const restoredAssistantSelections =
        queuedTurn.kind === "chat" ? queuedTurn.assistantSelections : [];
      const restoredFileComments = queuedTurn.kind === "chat" ? queuedTurn.fileComments : [];
      promptRef.current = nextPrompt;
      clearComposerDraftContent(activeThread.id);
      setComposerDraftPrompt(activeThread.id, nextPrompt);
      // Editing a queued turn should recreate the same draft state the user queued.
      setDraftThreadContext(activeThread.id, {
        runtimeMode: queuedTurn.runtimeMode,
        interactionMode: queuedTurn.interactionMode,
        ...(queuedTurn.kind === "chat" ? { envMode: queuedTurn.envMode } : {}),
      });
      if (queuedTurn.kind === "chat") {
        if (restoredImages.length > 0) {
          addComposerImagesToDraft(restoredImages);
        }
        if (restoredFiles.length > 0) {
          addComposerFilesToDraft(restoredFiles);
        }
        for (const selection of restoredAssistantSelections) {
          addComposerAssistantSelectionToDraft(selection);
        }
        for (const comment of restoredFileComments) {
          addComposerFileCommentToDraft(comment);
        }
        if (queuedTurn.terminalContexts.length > 0) {
          addComposerTerminalContextsToDraft(queuedTurn.terminalContexts);
        }
        if (queuedTurn.pastedTexts.length > 0) {
          addComposerPastedTextsToDraft(queuedTurn.pastedTexts);
        }
        updateSelectedComposerSkills(queuedTurn.skills);
        updateSelectedComposerMentions(queuedTurn.mentions);
      } else {
        updateSelectedComposerSkills([]);
        updateSelectedComposerMentions([]);
      }
      setRestoredQueuedSourceProposedPlan(
        activeThread.id,
        queuedTurn.kind === "chat" && queuedTurn.sourceProposedPlan
          ? {
              threadId: activeThread.id,
              restoredPrompt: nextPrompt,
              sourceProposedPlan: queuedTurn.sourceProposedPlan,
            }
          : null,
      );
      setComposerDraftModelSelection(activeThread.id, queuedTurn.modelSelection);
      setComposerDraftRuntimeMode(activeThread.id, queuedTurn.runtimeMode);
      setComposerDraftInteractionMode(activeThread.id, queuedTurn.interactionMode);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [
      activeThread,
      addComposerAssistantSelectionToDraft,
      addComposerFileCommentToDraft,
      addComposerFilesToDraft,
      addComposerImagesToDraft,
      addComposerTerminalContextsToDraft,
      addComposerPastedTextsToDraft,
      clearComposerDraftContent,
      scheduleComposerFocus,
      setDraftThreadContext,
      setRestoredQueuedSourceProposedPlan,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      setComposerDraftRuntimeMode,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const removeQueuedComposerTurn = useCallback(
    (queuedTurnId: string) => {
      removeQueuedComposerTurnFromDraft(threadId, queuedTurnId);
    },
    [removeQueuedComposerTurnFromDraft, threadId],
  );

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: "queue" | "steer" = "queue",
    queuedTurn?: QueuedComposerChatTurn,
  ): Promise<boolean> => {
    e?.preventDefault();
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      isVoiceTranscribing ||
      sendPreflightInFlightRef.current ||
      sendInFlightRef.current
    ) {
      return false;
    }
    if (activePendingProgress) {
      const activeQuestion = activePendingProgress.activeQuestion;
      const liveComposerSnapshot = composerEditorRef.current?.readSnapshot() ?? null;
      const livePendingAnswerText = liveComposerSnapshot?.value ?? promptRef.current;
      const currentDraftAnswer =
        activePendingUserInputKey && activeQuestion
          ? pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
              activeQuestion.id
            ]
          : undefined;
      const answerOverrides =
        activeQuestion && livePendingAnswerText.trim().length > 0
          ? {
              [activeQuestion.id]: setPendingUserInputCustomAnswer(
                currentDraftAnswer,
                livePendingAnswerText,
              ),
            }
          : undefined;
      if (activePendingUserInputKey && answerOverrides) {
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
          ...answerOverrides,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: nextRequestAnswers,
        }));
      }
      return onAdvanceActivePendingUserInput(answerOverrides);
    }
    const queuedChatTurn = queuedTurn ?? null;
    const liveComposerSnapshot =
      queuedChatTurn === null ? (composerEditorRef.current?.readSnapshot() ?? null) : null;
    let promptForSend = queuedChatTurn?.prompt ?? liveComposerSnapshot?.value ?? promptRef.current;
    let composerImagesForSend = queuedChatTurn?.images ?? composerImages;
    // AppSnap captures persist as IndexedDB blobs and hydrate into `images`
    // asynchronously (see AppSnapCoordinator). Right after a reload the user can
    // hit send before that hydration finishes; without this, the not-yet-hydrated
    // capture would be silently dropped from the message and then have its blob
    // deleted when the composer clears after send. Live sends only: a queued turn
    // already captured a fully-resolved image snapshot when it was queued.
    if (queuedChatTurn === null) {
      const pendingBlobAttachments = findPendingBlobComposerAttachments({
        persistedAttachments:
          useComposerDraftStore.getState().draftsByThreadId[activeThread.id]
            ?.persistedAttachments ?? [],
        images: composerImagesForSend,
      });
      if (pendingBlobAttachments.length > 0) {
        const hydratedPendingImages =
          await hydratePendingBlobComposerAttachments(pendingBlobAttachments);
        if (hydratedPendingImages.length > 0) {
          composerImagesForSend = [...composerImagesForSend, ...hydratedPendingImages];
        }
      }
    }
    const composerFilesForSend = queuedChatTurn?.files ?? composerFiles;
    const composerAssistantSelectionsForSend =
      queuedChatTurn?.assistantSelections ?? composerAssistantSelections;
    const composerFileCommentsForSend = queuedChatTurn?.fileComments ?? composerFileComments;
    const composerTerminalContextsForSend =
      queuedChatTurn?.terminalContexts ?? composerTerminalContexts;
    const composerPastedTextsForSend = queuedChatTurn?.pastedTexts ?? composerPastedTexts;
    const selectedComposerSkillsForSend =
      queuedChatTurn?.skills ?? selectedComposerSkillsRef.current;
    const selectedComposerMentionsForSend =
      queuedChatTurn?.mentions ?? selectedComposerMentionsRef.current;
    const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
    const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
    const selectedPromptEffortForSend =
      queuedChatTurn?.selectedPromptEffort ?? selectedPromptEffort;
    const selectedModelSelectionForSend = queuedChatTurn?.modelSelection ?? selectedModelSelection;
    const providerOptionsForDispatchForSend =
      queuedChatTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch;
    const runtimeModeForSend = queuedChatTurn?.runtimeMode ?? runtimeMode;
    let interactionModeForSend = queuedChatTurn?.interactionMode ?? interactionMode;
    const envModeForSend = queuedChatTurn?.envMode ?? envMode;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      sendablePastedTexts: sendableComposerPastedTexts,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImagesForSend.length,
      fileCount: composerFilesForSend.length,
      assistantSelectionCount: composerAssistantSelectionsForSend.length,
      fileCommentCount: composerFileCommentsForSend.length,
      terminalContexts: composerTerminalContextsForSend,
      pastedTexts: composerPastedTextsForSend,
    });
    let trimmedPromptForSend = trimmed;
    const restoredQueuedPlanDraftSource =
      queuedChatTurn === null &&
      restoredQueuedSourceProposedPlanRef.current?.threadId === activeThread.id &&
      composerPromptStillMatchesRestoredQueuedDraft(
        restoredQueuedSourceProposedPlanRef.current.restoredPrompt,
        promptForSend,
      )
        ? restoredQueuedSourceProposedPlanRef.current
        : null;
    const isLivePlanFollowUpSubmission =
      queuedChatTurn === null &&
      restoredQueuedPlanDraftSource === null &&
      showPlanFollowUpPrompt &&
      activeProposedPlan !== null;
    const hasStructuredPlanFollowUpContent =
      composerImagesForSend.length > 0 ||
      composerFilesForSend.length > 0 ||
      composerAssistantSelectionsForSend.length > 0 ||
      composerFileCommentsForSend.length > 0 ||
      sendableComposerTerminalContexts.length > 0 ||
      sendableComposerPastedTexts.length > 0;
    // Queued chat turns already captured their intended mode. Live plan follow-ups
    // with attachments must use the normal send path so references are preserved.
    if (isLivePlanFollowUpSubmission) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      if (hasStructuredPlanFollowUpContent) {
        promptForSend = followUp.text;
        interactionModeForSend = followUp.interactionMode;
        trimmedPromptForSend = followUp.text.trim();
      } else {
        if (hasLiveTurn && dispatchMode === "queue") {
          clearComposerInput(activeThread.id);
          scheduleComposerFocus();
          enqueueQueuedComposerTurn(activeThread.id, {
            id: randomUUID(),
            kind: "plan-follow-up",
            createdAt: new Date().toISOString(),
            previewText: followUp.text.trim(),
            text: followUp.text,
            interactionMode: followUp.interactionMode,
            selectedProvider,
            selectedModel,
            selectedPromptEffort,
            modelSelection: selectedModelSelection,
            ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
            runtimeMode,
          });
          return true;
        }
        clearComposerInput(activeThread.id);
        scheduleComposerFocus();
        return onSubmitPlanFollowUp({
          text: followUp.text,
          interactionMode: followUp.interactionMode,
          dispatchMode,
        });
      }
    }
    const hasNoStructuredComposerContext =
      composerImagesForSend.length === 0 &&
      composerFilesForSend.length === 0 &&
      composerAssistantSelectionsForSend.length === 0 &&
      composerFileCommentsForSend.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      sendableComposerPastedTexts.length === 0 &&
      // Provider mentions are structured turn metadata, and automation definitions persist text only.
      selectedComposerMentionsForSend.length === 0;
    const hasPromptOnlySendableContent = hasNoStructuredComposerContext;
    if (hasPromptOnlySendableContent) {
      const handledSlashCommand = await handleStandaloneSlashCommand(trimmedPromptForSend);
      if (handledSlashCommand) {
        // A slash command (e.g. /clear) consumes the composer, so abandon any in-progress
        // automation setup rather than leaving a stale banner/request behind.
        pendingAutomationConversationRef.current = null;
        setPendingAutomationConversation(null);
        return true;
      }
    }
    const sourceProposedPlanForSend =
      queuedChatTurn?.sourceProposedPlan ??
      restoredQueuedPlanDraftSource?.sourceProposedPlan ??
      (isLivePlanFollowUpSubmission && activeProposedPlan && interactionModeForSend === "default"
        ? buildSourceProposedPlanReference({
            threadId: activeThread.id,
            proposedPlan: activeProposedPlan,
          })
        : undefined);
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return false;
    }
    if (!activeProject) return false;
    if (queuedChatTurn === null && !isLivePlanFollowUpSubmission) {
      const conversation = pendingAutomationConversation;
      // While gathering missing details, fold the reply into the cleaned request so it
      // re-resolves as a whole rather than parsing the bare answer (and never re-parses
      // "could you create an automation" scaffolding as the task).
      const messageForAutomation = conversation
        ? `${conversation.accumulatedMessage}\n${trimmedPromptForSend}`
        : trimmedPromptForSend;
      const automationRequest = await resolveComposerAutomationRequest({
        message: messageForAutomation,
        cwd: activeProject.cwd,
        generateIntent: (request) => api.server.generateAutomationIntent(request),
      });
      // Drop a stale resolve: bail if the user switched threads, or cancelled/changed the
      // setup, while generateAutomationIntent was awaiting.
      if (
        activeThreadIdRef.current !== threadId ||
        pendingAutomationConversationRef.current !== conversation ||
        (!hasLiveTurn && hasLiveTurnRef.current)
      ) {
        return true;
      }
      if (automationRequest.type !== "normal-chat") {
        if (automationRequest.type === "needs-clarification") {
          // Conversational setup only runs for prompt-only sends while no turn is live:
          // clearing the composer would drop attachments/mentions Cancel can't restore,
          // and ephemeral setup bubbles must not anchor a running turn's work rows.
          if (!hasPromptOnlySendableContent || hasLiveTurn) {
            toastManager.add({
              type: "warning",
              title: "Automation needs a bit more detail",
              description:
                automationRequest.reason ??
                'Add what it should do and how often, e.g. "every weekday at 9am, summarize my PRs".',
            });
            return true;
          }
          // Render the exchange in-thread: echo the user's words as a bubble and ask for
          // what's missing as an assistant bubble. Nothing reaches a provider; the cleaned
          // automationMessage accumulates for the next re-resolve and for Cancel's restore.
          const question = automationClarificationPrompt(automationRequest.missingFields);
          const priorBubbles = conversation?.bubbles ?? [];
          // Drop the submitted request from the composer (it is captured in
          // accumulatedMessage, so re-folding it would duplicate the scaffold) while
          // preserving anything typed *after* it during the async resolve.
          const liveDraft = promptRef.current.trimStart();
          const leftover = liveDraft.startsWith(trimmedPromptForSend)
            ? liveDraft.slice(trimmedPromptForSend.length).trimStart()
            : liveDraft;
          promptRef.current = leftover;
          setComposerDraftPrompt(activeThread.id, leftover);
          setComposerTrigger(null);
          // Bring the new question into view even if the user had scrolled up.
          armTranscriptAutoFollow(activeThread.id, true);
          setPendingAutomationConversation({
            threadId: activeThread.id,
            accumulatedMessage: automationRequest.automationMessage,
            bubbles: [
              ...priorBubbles,
              makeAutomationSetupBubble("user", trimmedPromptForSend),
              makeAutomationSetupBubble("assistant", question),
            ],
          });
          return true;
        }

        pendingAutomationConversationRef.current = null;
        setPendingAutomationConversation(null);
        const automationIntent = automationRequest.resolution.intent;
        const automationTargetThreadId =
          automationIntent.executionScope === "thread" ? activeThread.id : null;
        const automationDraft = buildComposerAutomationDraft({
          resolution: automationRequest.resolution,
          projectId: activeProject.id,
          projectModelSelection: automationProjectModelSelection(
            automationProjects,
            activeProject.id,
          ),
          selectedModelSelection: selectedModelSelectionForSend,
          targetThreadId: automationTargetThreadId,
          hasEphemeralContext: !hasPromptOnlySendableContent,
        });
        // A multi-turn setup always confirms before creating, so the user reviews the
        // parsed task/schedule (and any scaffolding the parser kept) rather than it
        // silently auto-creating a recurring job.
        if (automationDraft.needsDraftReview || conversation !== null) {
          if (conversation !== null) {
            // Keep the full multi-turn request in the composer so dismissing the review
            // dialog doesn't lose it (the single-turn path likewise leaves its text).
            // Restore only the text; any attachments/mentions on the final reply stay.
            const liveDraft = promptRef.current.trimStart();
            const leftover = liveDraft.startsWith(trimmedPromptForSend)
              ? liveDraft.slice(trimmedPromptForSend.length).trimStart()
              : liveDraft;
            const restoredPrompt = leftover
              ? `${messageForAutomation}\n${leftover}`
              : messageForAutomation;
            promptRef.current = restoredPrompt;
            setComposerDraftPrompt(activeThread.id, restoredPrompt);
          }
          setAutomationEditingDefinition(null);
          setAutomationDraftWarningContext(automationDraft.warningContext);
          setAutomationDraftForm(automationDraft.form);
          setAutomationDraftWarnings(automationDraft.warnings);
          setAcknowledgedAutomationWarnings(automationDraft.acknowledgedWarningIds);
          setAutomationDraftOpen(true);
          return true;
        }
        const preparedAutomation = await prepareAutomationFormForCreate(automationDraft.form);
        if (!preparedAutomation) {
          return true;
        }
        await createAutomationFromForm({
          form: preparedAutomation.form,
          warnings: automationDraft.warnings,
          acknowledgedWarningIds: automationDraft.acknowledgedWarningIds,
          activityThreadId: preparedAutomation.activityThreadId,
          ...(providerOptionsForDispatchForSend
            ? { providerOptions: providerOptionsForDispatchForSend }
            : {}),
        });
        return true;
      }
      if (conversation) {
        // The combined text no longer reads as an automation; abandon setup and let
        // this message send as a normal chat turn instead of looping on the question.
        pendingAutomationConversationRef.current = null;
        setPendingAutomationConversation(null);
      }
    }
    sendPreflightInFlightRef.current = true;
    const sendProviderAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: selectedModelSelectionForSend.provider,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    }).finally(() => {
      sendPreflightInFlightRef.current = false;
    });
    if (!sendProviderAvailability.usable) {
      toastManager.add({
        type: "error",
        title: sendProviderAvailability.unavailableReason,
      });
      return false;
    }

    const browserPromptAttachment: BrowserPromptAttachmentResolution =
      await maybeResolveBrowserPromptAttachment({
        api,
        threadId: activeThread.id,
        prompt: promptForSend,
      }).catch(
        (): BrowserPromptAttachmentResolution => ({
          requested: false,
          image: null,
        }),
      );
    if (browserPromptAttachment.image) {
      const nextAttachmentCount =
        composerImagesForSend.length +
        composerFilesForSend.length +
        composerAssistantSelectionsForSend.length +
        (browserPromptAttachment.image ? 1 : 0);
      if (nextAttachmentCount <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        composerImagesForSend = [...composerImagesForSend, browserPromptAttachment.image];
      } else {
        toastManager.add({
          type: "warning",
          title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
          description:
            "The current browser screenshot was skipped because this message is already at the attachment limit.",
        });
      }
    } else if (browserPromptAttachment.requested) {
      const description =
        browserPromptAttachment.reason === "no-open-browser"
          ? "Open the in-app browser first, then try again."
          : browserPromptAttachment.reason === "no-active-tab"
            ? "The in-app browser has no active tab to capture yet."
            : browserPromptAttachment.reason === "attachment-too-large"
              ? `The browser screenshot exceeded the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`
              : "The current browser context could not be attached.";
      toastManager.add({
        type: "warning",
        title: "Couldn’t attach the in-app browser context",
        description,
      });
    }

    if (hasLiveTurn && dispatchMode === "queue" && queuedChatTurn === null) {
      clearComposerInput(activeThread.id);
      scheduleComposerFocus();
      const queuedImagesForPersistence = await Promise.all(
        composerImagesForSend.map(async (image) => {
          try {
            return {
              ...image,
              previewUrl: await readFileAsDataUrl(image.file),
            };
          } catch {
            return image;
          }
        }),
      );
      enqueueQueuedComposerTurn(activeThread.id, {
        id: randomUUID(),
        kind: "chat",
        createdAt: new Date().toISOString(),
        previewText: buildQueuedComposerPreviewText({
          trimmedPrompt: trimmed,
          images: queuedImagesForPersistence,
          files: composerFilesForSend,
          assistantSelections: composerAssistantSelectionsForSend,
          terminalContexts: sendableComposerTerminalContexts,
          fileComments: composerFileCommentsForSend,
          pastedTexts: sendableComposerPastedTexts,
        }),
        prompt: promptForSend,
        images: queuedImagesForPersistence,
        files: composerFilesForSend,
        assistantSelections: composerAssistantSelectionsForSend,
        fileComments: composerFileCommentsForSend,
        terminalContexts: sendableComposerTerminalContexts,
        pastedTexts: sendableComposerPastedTexts,
        skills: selectedComposerSkillsForSend,
        mentions: selectedComposerMentionsForSend,
        selectedProvider: selectedProviderForSend,
        selectedModel: selectedModelForSend,
        selectedPromptEffort: selectedPromptEffortForSend,
        modelSelection: selectedModelSelectionForSend,
        ...(providerOptionsForDispatchForSend
          ? { providerOptionsForDispatch: providerOptionsForDispatchForSend }
          : {}),
        ...(sourceProposedPlanForSend ? { sourceProposedPlan: sourceProposedPlanForSend } : {}),
        runtimeMode: runtimeModeForSend,
        interactionMode: interactionModeForSend,
        envMode: envModeForSend,
      });
      return true;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || !hasNativeUserMessages;
    const firstSendCreatedAt = new Date();
    let firstComposerImageNameForTitle: string | null = null;
    if (composerImagesForSend.length > 0) {
      firstComposerImageNameForTitle = composerImagesForSend[0]?.name ?? null;
    }
    let titleSeed = trimmedPromptForSend;
    if (!titleSeed) {
      if (firstComposerImageNameForTitle) {
        titleSeed = `Image: ${firstComposerImageNameForTitle}`;
      } else if (composerFilesForSend.length > 0) {
        titleSeed = `File: ${composerFilesForSend[0]?.name ?? "attachment"}`;
      } else if (composerAssistantSelectionsForSend.length > 0) {
        titleSeed = formatAssistantSelectionTitleSeed(composerAssistantSelectionsForSend.length);
      } else if (sendableComposerTerminalContexts.length > 0) {
        titleSeed = formatTerminalContextLabel(sendableComposerTerminalContexts[0]!);
      } else if (composerFileCommentsForSend.length > 0) {
        titleSeed = formatFileCommentTitleSeed(composerFileCommentsForSend.length);
      } else if (sendableComposerPastedTexts.length > 0) {
        titleSeed =
          formatPastedTextTitleSeed(sendableComposerPastedTexts) ?? GENERIC_CHAT_THREAD_TITLE;
      } else {
        titleSeed = GENERIC_CHAT_THREAD_TITLE;
      }
    }
    // Keep the optimistic label short while the server asks Codex for a better summary.
    const title = buildPromptThreadTitleFallback(titleSeed);
    const currentStoreState = useStore.getState();
    // Keep an optimistically selected Space across the command/snapshot race. The server
    // validates this best-effort target and degrades genuinely stale/deleted ids to Void.
    const activeSpaceIdForSend = readActiveSpaceId();
    const firstSendTarget = resolveFirstSendTarget({
      activeProject,
      chatWorkspaceRoot,
      createdAt: firstSendCreatedAt,
      isFirstMessage,
      isHomeChatContainer,
      isStudioContainer,
      projects: currentStoreState.projects,
      selectedWorkspaceRoot: isContainerLandingProject
        ? (resolvedThreadWorktreePath ?? null)
        : null,
      title,
      titleSeed,
    });
    let {
      targetProjectId: targetProjectIdForSend,
      targetProjectKind: targetProjectKindForSend,
      targetProjectCwd: targetProjectCwdForSend,
      targetProjectScripts: targetProjectScriptsForSend,
      targetProjectDefaultModelSelection: targetProjectDefaultModelSelectionForSend,
    } = firstSendTarget.kind === "create-project"
      ? {
          targetProjectId: activeProject.id,
          targetProjectKind: activeProject.kind,
          targetProjectCwd: activeProject.cwd,
          targetProjectScripts: activeProject.kind === "project" ? activeProject.scripts : [],
          targetProjectDefaultModelSelection: activeProject.defaultModelSelection ?? null,
        }
      : firstSendTarget.target;
    let nextRuntimeModeForSend = runtimeModeForSend;
    let nextThreadEnvMode = envModeForSend;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;
    let nextAssociatedWorktreePath = activeThread.associatedWorktreePath ?? null;
    let nextAssociatedWorktreeBranch = activeThread.associatedWorktreeBranch ?? null;
    let nextAssociatedWorktreeRef = activeThread.associatedWorktreeRef ?? null;

    if (isFirstMessage && isContainerLandingProject && firstSendTarget.kind !== "current") {
      if (firstSendTarget.kind === "create-project") {
        const projectId = newProjectId();
        const createdAt = firstSendCreatedAt.toISOString();
        try {
          await api.orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            kind: firstSendTarget.creation.kind,
            title: firstSendTarget.creation.title,
            workspaceRoot: firstSendTarget.creation.workspaceRoot,
            createWorkspaceRootIfMissing: firstSendTarget.creation.createWorkspaceRootIfMissing,
            defaultModelSelection: firstSendTarget.creation.defaultModelSelection,
            // Managed chat rows stay global; a folder mention creates an ordinary project
            // and should inherit the Space where the first send originated.
            ...(firstSendTarget.creation.kind === "project"
              ? { spaceId: activeSpaceIdForSend }
              : {}),
            createdAt,
          });
          targetProjectIdForSend = projectId;
          targetProjectKindForSend = firstSendTarget.creation.kind;
          targetProjectCwdForSend = firstSendTarget.creation.workspaceRoot;
          targetProjectScriptsForSend = [];
          targetProjectDefaultModelSelectionForSend =
            firstSendTarget.creation.defaultModelSelection;
        } catch (error) {
          const description =
            error instanceof Error ? error.message : "Failed to create the selected project.";
          if (!isDuplicateProjectCreateError(description)) {
            throw error;
          }

          // If the server already knows this workspace root, reuse that project and continue.
          const { snapshot, project: recoveredProject } =
            await waitForRecoverableProjectForDuplicateCreate({
              message: description,
              workspaceRoot: firstSendTarget.creation.workspaceRoot,
              loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
            });
          if (!snapshot || !recoveredProject) {
            throw error;
          }

          syncServerShellSnapshot(snapshot);
          targetProjectIdForSend = recoveredProject.id;
          targetProjectKindForSend = recoveredProject.kind ?? firstSendTarget.creation.kind;
          targetProjectCwdForSend = recoveredProject.workspaceRoot;
          targetProjectScriptsForSend =
            (recoveredProject.kind ?? firstSendTarget.creation.kind) === "project"
              ? [...recoveredProject.scripts]
              : [];
          targetProjectDefaultModelSelectionForSend =
            recoveredProject.defaultModelSelection ??
            firstSendTarget.creation.defaultModelSelection;
        }
      }

      clearProjectDraftThreadId(targetProjectIdForSend);
      setDraftThreadContext(threadIdForSend, {
        projectId: targetProjectIdForSend,
        envMode: "local",
        worktreePath: null,
        branch: null,
      });
      nextThreadEnvMode = "local";
      nextThreadBranch = null;
      nextThreadWorktreePath = null;
      nextAssociatedWorktreePath = null;
      nextAssociatedWorktreeBranch = null;
      nextAssociatedWorktreeRef = null;
    }

    // The branch query can finish just after the user chooses New worktree. Use the
    // resolved active branch at send time instead of rejecting an otherwise valid fast send.
    if (
      isFirstMessage &&
      nextThreadEnvMode === "worktree" &&
      !nextThreadWorktreePath &&
      !nextThreadBranch
    ) {
      nextThreadBranch = activeRootBranch ?? null;
    }

    const baseBranchForWorktree =
      isFirstMessage && nextThreadEnvMode === "worktree" && !nextThreadWorktreePath
        ? nextThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && nextThreadEnvMode === "worktree" && !nextThreadWorktreePath;
    if (shouldCreateWorktree && !nextThreadBranch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return false;
    }

    const setupScriptForWorktree = baseBranchForWorktree
      ? setupProjectScript(targetProjectScriptsForSend)
      : null;
    const worktreeSetupScriptName = setupScriptForWorktree?.name ?? null;

    sendInFlightRef.current = true;
    beginLocalDispatch(
      baseBranchForWorktree
        ? { worktreeSetupStepId: "create-worktree", setupScriptName: worktreeSetupScriptName }
        : undefined,
    );

    const composerImagesSnapshot = [...composerImagesForSend];
    const composerFilesSnapshot = [...composerFilesForSend];
    const composerAssistantSelectionsSnapshot = [...composerAssistantSelectionsForSend];
    const composerFileCommentsSnapshot = [...composerFileCommentsForSend];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerPastedTextsSnapshot = [...sendableComposerPastedTexts];
    const composerSkillsSnapshot = [...selectedComposerSkillsForSend];
    const composerMentionsSnapshot = [...selectedComposerMentionsForSend];
    // Trailing blocks are appended innermost-to-outermost: assistant selections,
    // terminal contexts, file comments, then pasted text (outermost). The display
    // extractors unwrap them in the reverse order.
    const messageTextForSend = appendPastedTextsToPrompt(
      appendFileCommentsToPrompt(
        appendTerminalContextsToPrompt(
          appendAssistantSelectionsToPrompt(promptForSend, composerAssistantSelectionsSnapshot),
          composerTerminalContextsSnapshot,
        ),
        composerFileCommentsSnapshot,
      ),
      composerPastedTextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingTextSeed =
      messageTextForSend || (composerImagesSnapshot.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: selectedProviderForSend,
      model: selectedModelForSend,
      effort: selectedPromptEffortForSend,
      text: outgoingTextSeed,
    });
    const mentionedSkillsForSend = filterPromptSkillReferences(
      outgoingMessageText,
      selectedComposerSkillsForSend,
      selectedProviderForSend,
    );
    const mentionedPluginMentionsForSend = filterPromptProviderMentionReferences(
      outgoingMessageText,
      selectedComposerMentionsForSend,
    );
    const turnAttachmentsPromise = stageUploadComposerAttachments({
      threadId: threadIdForSend,
      images: composerImagesSnapshot,
      files: composerFilesSnapshot,
      assistantSelections: composerAssistantSelectionsSnapshot,
    });
    const optimisticAttachments = [
      ...composerAssistantSelectionsSnapshot,
      ...composerImagesSnapshot.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl,
      })),
      ...composerFilesSnapshot.map((file) => ({
        type: "file" as const,
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      })),
    ];
    // Sending the first message flips the centered empty landing into a normal
    // transcript. Clear session-only landing overrides when default-open is enabled;
    // otherwise keep the transition closed.
    if (isCenteredEmptyLanding) {
      setEnvironmentPanelPreferenceOpen(
        resolveEnvironmentPanelPreferenceAfterFirstSend({
          isCenteredEmptyLanding,
          settingsDefaultOpen: settings.environmentPanelDefaultOpen,
          currentPreferenceOpen: environmentPanelPreferenceOpen,
        }),
      );
    }
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        dispatchMode,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        ...(mentionedSkillsForSend.length > 0 ? { skills: mentionedSkillsForSend } : {}),
        ...(mentionedPluginMentionsForSend.length > 0
          ? { mentions: mentionedPluginMentionsForSend }
          : {}),
        createdAt: messageCreatedAt,
        streaming: false,
        source: "native",
      },
    ]);
    // Mark the transcript as anchored before the optimistic row lands so the
    // re-snap effect on row count change pulls us to the new tail.
    armTranscriptAutoFollow(threadIdForSend, true);

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    // Queued turns are dispatched from their captured snapshot, so this send path
    // must not clear a separate live draft the user may already be editing.
    if (queuedChatTurn === null) {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      clearComposerDraftContent(threadIdForSend, { preservePreviewUrls: true });
      if (isLivePlanFollowUpSubmission) {
        setComposerDraftInteractionMode(threadIdForSend, interactionModeForSend);
      }
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      // A clicked submit button steals focus; return it after the controlled
      // draft reset so rapid follow-up typing lands in the composer.
      scheduleComposerFocus();
    }

    let createdServerThreadForLocalDraft = false;
    let createdWorktreeForSendPath: string | null = null;
    let turnStartSucceeded = false;
    await (async () => {
      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        const result = await createWorktreeMutation.mutateAsync({
          cwd: targetProjectCwdForSend,
          ref: baseBranchForWorktree,
          ...(baseBranchForWorktree === activeRootBranch
            ? { copyChangesFrom: targetProjectCwdForSend }
            : {}),
        });
        beginLocalDispatch({
          worktreeSetupStepId: "prepare-thread",
          setupScriptName: worktreeSetupScriptName,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        createdWorktreeForSendPath = result.worktree.path;
        const nextAssociatedWorktree = {
          associatedWorktreePath: result.worktree.path,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: result.worktree.ref,
        };
        nextAssociatedWorktreePath = nextAssociatedWorktree.associatedWorktreePath;
        nextAssociatedWorktreeBranch = nextAssociatedWorktree.associatedWorktreeBranch;
        nextAssociatedWorktreeRef = nextAssociatedWorktree.associatedWorktreeRef;
        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            envMode: "worktree",
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
            associatedWorktreePath: nextAssociatedWorktree.associatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktree.associatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktree.associatedWorktreeRef,
          });
          // Keep local thread state in sync immediately so terminal drawer opens
          // with the worktree cwd/env instead of briefly using the project root.
          setStoreThreadWorkspace(threadIdForSend, {
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
            ...nextAssociatedWorktree,
          });
        }
      }

      const threadCreateModelSelection: ModelSelection = buildModelSelection(
        selectedModelSelectionForSend.provider,
        selectedModelSelectionForSend.model ||
          selectedModelForSend ||
          targetProjectDefaultModelSelectionForSend?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        selectedModelSelectionForSend.options,
      );

      if (isLocalDraftThread) {
        const inheritedProjectInstructions =
          useProjectInstructionsStore.getState().instructionsByProjectId[targetProjectIdForSend] ??
          "";
        const inheritedThreadNotes = mergeProjectInstructionsIntoThreadNotes({
          threadNotes,
          projectInstructions: inheritedProjectInstructions,
        });
        await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            projectId: targetProjectIdForSend,
            title,
            modelSelection: threadCreateModelSelection,
            runtimeMode: nextRuntimeModeForSend,
            interactionMode: interactionModeForSend,
            envMode: nextThreadEnvMode,
            branch: nextThreadBranch,
            worktreePath: nextThreadWorktreePath,
            associatedWorktreePath: nextAssociatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktreeRef,
            lastKnownPr: activeThread.lastKnownPr ?? null,
            createdAt: activeThread.createdAt,
          },
          api,
        );
        // `thread.create` does not carry notes, so seed the freshly created
        // server thread's notepad with the inherited project instructions via a
        // dedicated meta update. Best-effort: a failure here must not abort the turn.
        if (inheritedThreadNotes !== threadNotes && inheritedThreadNotes.trim().length > 0) {
          try {
            await dispatchThreadNotes(threadIdForSend, inheritedThreadNotes);
          } catch {
            // Seeding is non-critical; project instructions can still be copied
            // into the notepad manually from the Environment panel.
          }
        }
        if (targetProjectKindForSend === "chat") {
          await api.orchestration.dispatchCommand({
            type: "project.meta.update",
            commandId: newCommandId(),
            projectId: targetProjectIdForSend,
            title,
          });
        }
        createdServerThreadForLocalDraft = true;
      }

      const setupScript = setupScriptForWorktree;
      if (setupScript) {
        let shouldRunSetupScript = false;
        if (isServerThread) {
          shouldRunSetupScript = true;
        } else {
          if (createdServerThreadForLocalDraft) {
            shouldRunSetupScript = true;
          }
        }
        if (shouldRunSetupScript) {
          beginLocalDispatch({
            worktreeSetupStepId: "run-setup-action",
            setupScriptName: setupScript.name,
          });
          const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
            worktreePath: nextThreadWorktreePath,
            rememberAsLastInvoked: false,
            throwOnError: true,
          };
          if (nextThreadWorktreePath) {
            setupScriptOptions.cwd = nextThreadWorktreePath;
          }
          const setupTerminal = await runProjectScript(setupScript, setupScriptOptions);
          if (setupTerminal) {
            await waitForSetupScriptTerminalActivity({
              threadId: threadIdForSend,
              terminalId: setupTerminal.terminalId,
            });
          }
        }
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelectionForSend,
          runtimeMode: nextRuntimeModeForSend,
          interactionMode: interactionModeForSend,
        });
      }

      beginLocalDispatch(
        baseBranchForWorktree
          ? { worktreeSetupStepId: "start-session", setupScriptName: worktreeSetupScriptName }
          : undefined,
      );
      const stagedTurnAttachments = await turnAttachmentsPromise;
      rememberCustomBinaryPathForDispatch({
        threadId: threadIdForSend,
        provider: selectedModelSelectionForSend.provider,
        providerOptions: providerOptionsForDispatchForSend,
      });
      await stagedTurnAttachments.runWithDispatch((turnAttachments) =>
        api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachments,
            ...(mentionedSkillsForSend.length > 0 ? { skills: mentionedSkillsForSend } : {}),
            ...(mentionedPluginMentionsForSend.length > 0
              ? { mentions: mentionedPluginMentionsForSend }
              : {}),
          },
          modelSelection: selectedModelSelectionForSend,
          ...(providerOptionsForDispatchForSend
            ? { providerOptions: providerOptionsForDispatchForSend }
            : {}),
          assistantDeliveryMode,
          dispatchMode,
          runtimeMode: nextRuntimeModeForSend,
          interactionMode: interactionModeForSend,
          ...(sourceProposedPlanForSend ? { sourceProposedPlan: sourceProposedPlanForSend } : {}),
          createdAt: messageCreatedAt,
        }),
      );
      turnStartSucceeded = true;
      // Non-Codex steers interrupt the live turn before re-dispatching; hold
      // queued auto-dispatch through that gap so it can't race the steer. The
      // live session provider decides the interrupt path server-side, so the
      // gate keys off it rather than the requested model selection.
      const liveProviderForSteerGate =
        activeThread?.session?.provider ?? selectedModelSelectionForSend.provider;
      if (dispatchMode === "steer" && liveProviderForSteerGate !== "codex") {
        setQueuedSteerGate({
          sawInterruptGap: false,
          gapStartedAt: null,
          armedActiveTurnId: activeThread?.session?.activeTurnId ?? null,
        });
      }
      if (sourceProposedPlanForSend) {
        planSidebarDismissedForTurnRef.current = null;
        setPlanSidebarOpen(true);
      }
      if (queuedChatTurn === null) {
        setRestoredQueuedSourceProposedPlan(threadIdForSend, null);
      }
    })().catch(async (err: unknown) => {
      // Uploads start in parallel with workspace/session preparation. If any
      // earlier step fails, settle that promise and release every staged blob.
      await turnAttachmentsPromise.then(
        (staged) => staged.cleanup(),
        () => undefined,
      );
      // Surface the failure on whichever setup step was active (no-op for
      // sends without a worktree setup in flight).
      failLocalDispatchWorktreeSetup();
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        // This rollback cleans up a retryable draft promotion; do not tombstone the draft id.
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (createdWorktreeForSendPath && !turnStartSucceeded) {
        const removed = await api.git
          .removeWorktree({
            cwd: targetProjectCwdForSend,
            path: createdWorktreeForSendPath,
            force: true,
          })
          .then(
            () => true,
            () => false,
          );
        if (removed && isServerThread) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: threadIdForSend,
              envMode: "local",
              branch: null,
              worktreePath: null,
              associatedWorktreePath: null,
              associatedWorktreeBranch: null,
              associatedWorktreeRef: null,
            })
            .then(
              () =>
                setStoreThreadWorkspace(threadIdForSend, {
                  branch: null,
                  worktreePath: null,
                  associatedWorktreePath: null,
                  associatedWorktreeBranch: null,
                  associatedWorktreeRef: null,
                }),
              () => undefined,
            );
        }
      }
      if (
        queuedChatTurn === null &&
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerFilesRef.current.length === 0 &&
        composerAssistantSelectionsRef.current.length === 0 &&
        composerFileCommentsRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerPastedTextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        if (sourceProposedPlanForSend) {
          setRestoredQueuedSourceProposedPlan(threadIdForSend, {
            threadId: threadIdForSend,
            restoredPrompt: promptForSend,
            sourceProposedPlan: sourceProposedPlanForSend,
          });
        }
        setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageAttachment));
        addComposerFilesToDraft(composerFilesSnapshot);
        for (const selection of composerAssistantSelectionsSnapshot) {
          addComposerAssistantSelectionToDraft(selection);
        }
        for (const comment of composerFileCommentsSnapshot) {
          addComposerFileCommentToDraft(comment);
        }
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        addComposerPastedTextsToDraft(composerPastedTextsSnapshot);
        updateSelectedComposerSkills(composerSkillsSnapshot);
        updateSelectedComposerMentions(composerMentionsSnapshot);
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      if (baseBranchForWorktree) {
        scheduleFailedWorktreeSetupDispatchReset();
      } else {
        resetLocalDispatch();
      }
    }
    return turnStartSucceeded;
  };

  const onRespondToApproval = useCallback(
    async (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      lifecycleGeneration?: string,
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);

      setRespondingRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      // Durably persist "always allow" client-side so the next turn (after an
      // idle-stop or runtime restart) keeps full-access instead of asking again.
      // The server's session override only covers the current live turn.
      const durableRuntimeMode = resolveRuntimeModeAfterApprovalDecision(runtimeMode, decision);
      if (durableRuntimeMode) {
        setComposerDraftRuntimeMode(activeThreadId, durableRuntimeMode);
      }
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestKeys((existing) => existing.filter((key) => key !== requestKey));
    },
    [activeThreadId, runtimeMode, setComposerDraftRuntimeMode, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
      lifecycleGeneration?: string,
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);
      const dispatchAnswers = hasCompletePendingUserInputAnswers(answers)
        ? answers
        : omitNullPendingUserInputAnswers(answers);

      setRespondingUserInputRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers: dispatchAnswers,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestKeys((existing) => existing.filter((key) => key !== requestKey));
    },
    [activeThreadId, setStoreThreadError],
  );

  const onCancelActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || activePendingIsResponding) {
      return;
    }
    promptRef.current = "";
    setPrompt("");
    setComposerCursor(0);
    setComposerTrigger(null);
    void onRespondToUserInput(
      activePendingUserInput.requestId,
      {},
      activePendingUserInput.lifecycleGeneration,
    );
  }, [activePendingIsResponding, activePendingUserInput, onRespondToUserInput, setPrompt]);

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInputKey) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextQuestionIndex,
      }));
    },
    [activePendingUserInputKey],
  );

  const onToggleActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput || !activePendingUserInputKey) {
        return null;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return null;
      }
      const nextDraftAnswer = togglePendingUserInputOptionSelection(
        question,
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[questionId],
        optionLabel,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInputKey]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextRequestAnswers,
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
      return nextDraftAnswer;
    },
    [activePendingUserInput, activePendingUserInputKey],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInputKey) {
        return;
      }
      promptRef.current = value;
      const nextDraftAnswer = setPendingUserInputCustomAnswer(
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[questionId],
        value,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInputKey]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextRequestAnswers,
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInputKey],
  );

  const onAdvanceActivePendingUserInput = useCallback(
    (answerOverrides?: Record<string, PendingUserInputDraftAnswer>): boolean => {
      if (!activePendingUserInput || !activePendingUserInputKey || !activePendingProgress) {
        return false;
      }
      const pendingDraftAnswers =
        answerOverrides && Object.keys(answerOverrides).length > 0
          ? {
              ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
              ...answerOverrides,
            }
          : (pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey] ??
            activePendingDraftAnswers);
      if (answerOverrides && Object.keys(answerOverrides).length > 0) {
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: pendingDraftAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: pendingDraftAnswers,
        }));
      }
      const resolvedAnswers = buildPendingUserInputAnswers(
        activePendingUserInput.questions,
        pendingDraftAnswers,
      );
      if (activePendingProgress.isLastQuestion) {
        if (resolvedAnswers) {
          void onRespondToUserInput(
            activePendingUserInput.requestId,
            resolvedAnswers,
            activePendingUserInput.lifecycleGeneration,
          );
          return true;
        }
        return false;
      }
      const activeQuestionId = activePendingProgress.activeQuestion?.id ?? null;
      const hasActiveOverride = activeQuestionId
        ? answerOverrides?.[activeQuestionId] !== undefined
        : false;
      if (!activePendingProgress.canAdvance && !hasActiveOverride) {
        return false;
      }
      setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
      return true;
    },
    [
      activePendingDraftAnswers,
      activePendingProgress,
      activePendingUserInput,
      activePendingUserInputKey,
      onRespondToUserInput,
      setActivePendingUserInputQuestionIndex,
    ],
  );

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  async function onSubmitPlanFollowUp({
    text,
    interactionMode: nextInteractionMode,
    dispatchMode,
    queuedTurn,
  }: {
    text: string;
    interactionMode: "default" | "plan";
    dispatchMode: "queue" | "steer";
    queuedTurn?: QueuedComposerPlanFollowUp;
  }): Promise<boolean> {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: queuedTurn?.selectedProvider ?? selectedProvider,
      model: queuedTurn?.selectedModel ?? selectedModel,
      effort: queuedTurn?.selectedPromptEffort ?? selectedPromptEffort,
      text: trimmed,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch();
    setThreadError(threadIdForSend, null);
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        dispatchMode,
        createdAt: messageCreatedAt,
        streaming: false,
        source: "native",
      },
    ]);
    armTranscriptAutoFollow(threadIdForSend, true);

    try {
      await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: queuedTurn?.modelSelection ?? selectedModelSelection,
        runtimeMode: queuedTurn?.runtimeMode ?? runtimeMode,
        interactionMode: nextInteractionMode,
      });

      // Keep the mode toggle and plan-follow-up banner in sync immediately
      // while the same-thread implementation turn is starting.
      setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

      const providerOptionsForPlanDispatch =
        queuedTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch;
      const modelSelectionForPlanDispatch = queuedTurn?.modelSelection ?? selectedModelSelection;
      const sourceProposedPlan =
        nextInteractionMode === "default"
          ? buildSourceProposedPlanReference({
              threadId: activeThread.id,
              proposedPlan: activeProposedPlan,
            })
          : undefined;
      rememberCustomBinaryPathForDispatch({
        threadId: threadIdForSend,
        provider: modelSelectionForPlanDispatch.provider,
        providerOptions: providerOptionsForPlanDispatch,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: [],
        },
        modelSelection: modelSelectionForPlanDispatch,
        ...(providerOptionsForPlanDispatch
          ? {
              providerOptions: providerOptionsForPlanDispatch,
            }
          : {}),
        assistantDeliveryMode,
        dispatchMode,
        runtimeMode: queuedTurn?.runtimeMode ?? runtimeMode,
        interactionMode: nextInteractionMode,
        ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
        createdAt: messageCreatedAt,
      });
      // Non-Codex steers interrupt the live turn before re-dispatching; hold
      // queued auto-dispatch through that gap so it can't race the steer. The
      // live session provider decides the interrupt path server-side, so the
      // gate keys off it rather than the requested model selection.
      const livePlanProviderForSteerGate =
        activeThread?.session?.provider ?? modelSelectionForPlanDispatch.provider;
      if (dispatchMode === "steer" && livePlanProviderForSteerGate !== "codex") {
        setQueuedSteerGate({
          sawInterruptGap: false,
          gapStartedAt: null,
          armedActiveTurnId: activeThread?.session?.activeTurnId ?? null,
        });
      }
      // Optimistically open the plan sidebar when implementing (not refining).
      // "default" mode here means the agent is executing the plan, which produces
      // step-tracking activities that the sidebar will display.
      if (nextInteractionMode === "default") {
        planSidebarDismissedForTurnRef.current = null;
        setPlanSidebarOpen(true);
      }
      sendInFlightRef.current = false;
      return true;
    } catch (err) {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send plan follow-up.",
      );
      sendInFlightRef.current = false;
      resetLocalDispatch();
      return false;
    }
  }

  const onEditUserMessage = useCallback(
    async (messageId: MessageId, text: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeThread || !isServerThread || isRevertingCheckpoint) {
        return false;
      }
      const editTarget = resolveTailUserMessageEditTarget({
        messages: activeThread.messages,
        messageId,
        activeTurnId:
          activeThread.session?.orchestrationStatus === "running"
            ? (activeThread.session.activeTurnId ?? null)
            : null,
      });
      if (!editTarget.editable) {
        setThreadError(activeThread.id, "Only the latest rollbackable user message can be edited.");
        return false;
      }
      const originalMessage = activeThread.messages[editTarget.messageIndex];
      if (!originalMessage || originalMessage.role !== "user") {
        setThreadError(activeThread.id, "Only the latest rollbackable user message can be edited.");
        return false;
      }
      if (isSendBusy || isConnecting || sendInFlightRef.current) {
        setThreadError(activeThread.id, "Wait for the current send to start before editing.");
        return false;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const messageCreatedAt = new Date().toISOString();
      const editedTextWithOriginalContext = appendOriginalComposerPromptBlocks({
        editedPrompt: text,
        originalPrompt: originalMessage.text,
      });
      const outgoingMessageText = formatOutgoingComposerPrompt({
        provider: selectedProvider,
        model: selectedModel,
        effort: selectedPromptEffort,
        text: editedTextWithOriginalContext,
      });
      return await (async () => {
        await persistThreadSettingsForNextTurn({
          threadId: activeThread.id,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode,
        });
        await api.orchestration.dispatchCommand({
          type: "thread.message.edit-and-resend",
          commandId: newCommandId(),
          threadId: activeThread.id,
          messageId,
          text: outgoingMessageText,
          modelSelection: selectedModelSelection,
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode,
          runtimeMode,
          interactionMode,
          createdAt: messageCreatedAt,
        });
        return true;
      })()
        .catch((err: unknown) => {
          setThreadError(
            activeThread.id,
            err instanceof Error ? err.message : "Failed to edit message.",
          );
          return false;
        })
        .finally(() => {
          setIsRevertingCheckpoint(false);
        });
    },
    [
      activeThread,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      isServerThread,
      interactionMode,
      persistThreadSettingsForNextTurn,
      providerOptionsForDispatch,
      runtimeMode,
      selectedModel,
      selectedModelSelection,
      selectedPromptEffort,
      selectedProvider,
      setThreadError,
      assistantDeliveryMode,
    ],
  );

  const onSendRef = useRef(onSend);
  const onSubmitPlanFollowUpRef = useRef(onSubmitPlanFollowUp);
  // The queued dispatcher can run from the same commit's follow-up work, so do
  // not leave a passive-effect window where it sees the previous callbacks.
  useLayoutEffect(() => {
    onSendRef.current = onSend;
    onSubmitPlanFollowUpRef.current = onSubmitPlanFollowUp;
  });

  const dispatchQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn, dispatchMode: "queue" | "steer"): Promise<boolean> => {
      if (queuedTurn.kind === "chat") {
        return onSendRef.current(undefined, dispatchMode, queuedTurn);
      }
      return onSubmitPlanFollowUpRef.current({
        text: queuedTurn.text,
        interactionMode: queuedTurn.interactionMode,
        dispatchMode,
        queuedTurn,
      });
    },
    [],
  );

  // Resuming a workflow is a normal composer turn instructing the agent to
  // re-invoke the Workflow tool against the persisted script; completed agent()
  // calls replay from cache, so a paused run picks up where it stopped. Sent as
  // a pre-built chat turn so it takes the exact send path a queued turn does.
  const onResumeWorkflowRun = useCallback(async () => {
    if (!workflowRunState?.scriptPath || !workflowRunState.runId) return;
    const { workflowTaskId } = workflowRunState;
    const prompt = buildWorkflowResumePrompt(workflowRunState.scriptPath, workflowRunState.runId);
    const sent = await onSendRef.current(undefined, "queue", {
      id: randomUUID(),
      kind: "chat",
      createdAt: new Date().toISOString(),
      previewText: prompt,
      prompt,
      images: [],
      files: [],
      assistantSelections: [],
      terminalContexts: [],
      fileComments: [],
      pastedTexts: [],
      skills: [],
      mentions: [],
      selectedProvider,
      selectedModel,
      selectedPromptEffort,
      modelSelection: selectedModelSelection,
      ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
      runtimeMode,
      interactionMode,
      envMode,
    });
    if (sent && activeThreadId) {
      markWorkflowRunDismissed(activeThreadId, workflowTaskId);
    }
  }, [
    activeThreadId,
    envMode,
    interactionMode,
    markWorkflowRunDismissed,
    providerOptionsForDispatch,
    runtimeMode,
    selectedModel,
    selectedModelSelection,
    selectedPromptEffort,
    selectedProvider,
    workflowRunState,
  ]);

  const onSteerQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn) => {
      const previousQueue = queuedComposerTurnsRef.current;
      const queuedIndex = previousQueue.findIndex((entry) => entry.id === queuedTurn.id);
      if (queuedIndex < 0) {
        return;
      }
      removeQueuedComposerTurnFromDraft(threadId, queuedTurn.id);
      const succeeded = await dispatchQueuedComposerTurn(queuedTurn, "steer");
      if (succeeded) {
        return;
      }
      insertQueuedComposerTurn(threadId, queuedTurn, queuedIndex);
    },
    [
      dispatchQueuedComposerTurn,
      insertQueuedComposerTurn,
      removeQueuedComposerTurnFromDraft,
      threadId,
    ],
  );

  const onEditQueuedComposerTurn = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      removeQueuedComposerTurn(queuedTurn.id);
      restoreQueuedTurnToComposer(queuedTurn);
    },
    [removeQueuedComposerTurn, restoreQueuedTurnToComposer],
  );

  // Advance/expire the steer gate as the session moves through the
  // interrupt→steered-turn handoff (or fails out of it).
  const sessionErroredForSteerGate = activeThread?.session?.status === "error";
  const activeTurnIdForSteerGate = activeThread?.session?.activeTurnId ?? null;
  useEffect(() => {
    if (!queuedSteerGate) {
      return;
    }
    const transition = resolveQueuedSteerGateTransition({
      gate: queuedSteerGate,
      phase,
      sessionErrored: sessionErroredForSteerGate,
      activeTurnId: activeTurnIdForSteerGate,
      now: Date.now(),
    });
    if (transition.kind === "clear") {
      setQueuedSteerGate(null);
      return;
    }
    if (
      transition.gate.sawInterruptGap !== queuedSteerGate.sawInterruptGap ||
      transition.gate.gapStartedAt !== queuedSteerGate.gapStartedAt ||
      transition.gate.armedActiveTurnId !== queuedSteerGate.armedActiveTurnId
    ) {
      setQueuedSteerGate(transition.gate);
      return;
    }
    if (transition.expiresInMs === null) {
      return;
    }
    const timer = window.setTimeout(() => setQueuedSteerGate(null), transition.expiresInMs);
    return () => window.clearTimeout(timer);
  }, [activeTurnIdForSteerGate, phase, queuedSteerGate, sessionErroredForSteerGate]);

  useEffect(() => {
    if (
      hasLiveTurn ||
      phase === "disconnected" ||
      isSendBusy ||
      isConnecting ||
      queuedSteerGate !== null ||
      activePendingApproval !== null ||
      activePendingProgress !== null ||
      pendingUserInputs.length > 0 ||
      queuedComposerTurns.length === 0
    ) {
      return;
    }
    if (
      autoDispatchingQueuedTurnRef.current ||
      sendInFlightRef.current ||
      sendPreflightInFlightRef.current
    ) {
      // These guards are refs, so nothing re-triggers this effect once they
      // reset; poll until the in-flight send settles instead of leaving the
      // queue stuck at the end of a turn.
      const timer = window.setTimeout(() => setQueuedAutoDispatchTick((tick) => tick + 1), 250);
      return () => window.clearTimeout(timer);
    }
    const nextQueuedTurn = queuedComposerTurns[0];
    if (!nextQueuedTurn) {
      return;
    }
    autoDispatchingQueuedTurnRef.current = true;
    void (async () => {
      const succeeded = await dispatchQueuedComposerTurn(nextQueuedTurn, "queue");
      if (succeeded) {
        removeQueuedComposerTurnFromDraft(threadId, nextQueuedTurn.id);
      }
      autoDispatchingQueuedTurnRef.current = false;
    })();
  }, [
    activePendingApproval,
    activePendingProgress,
    dispatchQueuedComposerTurn,
    phase,
    isConnecting,
    isSendBusy,
    pendingUserInputs.length,
    hasLiveTurn,
    queuedAutoDispatchTick,
    queuedComposerTurns,
    queuedSteerGate,
    removeQueuedComposerTurnFromDraft,
    threadId,
  ]);

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingComposerPrompt({
      provider: selectedProvider,
      model: selectedModel,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncateTitle(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;
    const sourceProposedPlan = buildSourceProposedPlanReference({
      threadId: activeThread.id,
      proposedPlan: activeProposedPlan,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch();
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        envMode: activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local"),
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        lastKnownPr: activeThread.lastKnownPr ?? null,
        associatedWorktreePath: activeThreadAssociatedWorktree.associatedWorktreePath,
        associatedWorktreeBranch: activeThreadAssociatedWorktree.associatedWorktreeBranch,
        associatedWorktreeRef: activeThreadAssociatedWorktree.associatedWorktreeRef,
        createdAt,
      })
      .then(() => {
        rememberCustomBinaryPathForDispatch({
          threadId: nextThreadId,
          provider: selectedModelSelection.provider,
          providerOptions: providerOptionsForDispatch,
        });
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode,
          dispatchMode: "queue",
          runtimeMode,
          interactionMode: "default",
          ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
          createdAt,
        });
      })
      .then(() => api.orchestration.getShellSnapshot())
      .then((snapshot) => {
        syncServerShellSnapshot(snapshot);
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        const deletedOnServer = await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .then(() => true)
          .catch(() => false);
        if (deletedOnServer) {
          void reconcileDeletedThreadFromClient({
            threadId: nextThreadId,
            removeDeletedThreadFromClientState:
              useStore.getState().removeDeletedThreadFromClientState,
          });
        }
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    activeThreadAssociatedWorktree,
    beginLocalDispatch,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    selectedPromptEffort,
    selectedModelSelection,
    providerOptionsForDispatch,
    rememberCustomBinaryPathForDispatch,
    selectedProvider,
    assistantDeliveryMode,
    syncServerShellSnapshot,
    selectedModel,
  ]);

  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  const selectedProviderModelOptions = composerModelOptions?.[selectedProvider];
  const composerTraitSelection = getComposerTraitSelection(
    selectedProvider,
    selectedModel,
    prompt,
    selectedProviderModelOptions,
    selectedRuntimeModel,
  );
  const runtimeUsageContextWindow = useMemo(
    () =>
      activeContextWindow ??
      (selectedProvider === "claudeAgent"
        ? deriveSelectedContextWindowSnapshot(composerTraitSelection.contextWindow)
        : null),
    [activeContextWindow, composerTraitSelection.contextWindow, selectedProvider],
  );
  const contextWindowSelectionStatus = useMemo(
    () =>
      deriveContextWindowSelectionStatus({
        activeSnapshot: runtimeUsageContextWindow,
        selectedValue:
          selectedProvider === "claudeAgent" ? composerTraitSelection.contextWindow : null,
      }),
    [runtimeUsageContextWindow, composerTraitSelection.contextWindow, selectedProvider],
  );
  const useSplitComposerPickerControls = isLocalDraftThread && !hasThreadStarted;
  const composerFooterControlsPlan = useMemo(
    () => composerFooterPlanForTier(composerFooterTier, Boolean(runtimeUsageContextWindow)),
    [composerFooterTier, runtimeUsageContextWindow],
  );
  // The displayed labels changed (model switch, effort change, picker layout):
  // recorded overflow widths no longer apply, so reset to the richest tier and
  // let the measured-overflow loop demote again before paint if needed.
  const composerFooterModelLabel = resolveProviderModelLabel({
    provider: selectedProvider,
    lockedProvider,
    model: selectedModelForPickerWithCustomFallback,
    modelOptionsByProvider,
  });
  const composerFooterTraitsSummary = resolveTraitsTriggerSummary({
    provider: selectedProvider,
    model: selectedModelForPickerWithCustomFallback,
    prompt,
    modelOptions: selectedProviderModelOptions,
    ...(selectedRuntimeModel ? { runtimeModel: selectedRuntimeModel } : {}),
    runtimeAgents: dynamicAgents,
  });
  const composerFooterPlanInputsKey = [
    composerFooterModelLabel,
    composerFooterTraitsSummary.summaryText,
    Boolean(runtimeUsageContextWindow),
    useSplitComposerPickerControls,
  ].join(":");
  useLayoutEffect(() => {
    composerFooterDemotionWidthsRef.current = [];
    composerFooterTierRef.current = 0;
    setComposerFooterTier(0);
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterPlanInputsKey]);
  // After a tier renders, re-measure before paint: a still-overflowing footer
  // demotes another step until it fits (bounded by COMPOSER_FOOTER_MAX_TIER).
  useLayoutEffect(() => {
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterTier]);
  const composerModelPickerWidthClassName = isComposerFooterCompact ? "w-32" : "w-36 sm:w-44";
  const composerOptionsPickerWidthClassName = isComposerFooterCompact ? "w-28" : "w-32";
  const composerModelEffortPickerWidthClassName = isComposerFooterCompact ? "w-40" : "w-44 sm:w-52";
  const isComposerModelEffortPickerOpen = isModelPickerOpen || isTraitsPickerOpen;
  const handleComposerModelEffortPickerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        handleModelPickerOpenChange(true);
      } else {
        setIsModelPickerOpen(false);
        setIsTraitsPickerOpen(false);
      }
    },
    [handleModelPickerOpenChange],
  );
  const composerPickerControls = showComposerModelBootstrapSkeleton ? (
    useSplitComposerPickerControls ? (
      <>
        {selectedProviderRuntimeModelDiscoveryPending ? (
          <ComposerModelLoadingControl widthClassName={composerModelPickerWidthClassName} />
        ) : (
          <ComposerControlSkeleton widthClassName={composerModelPickerWidthClassName} />
        )}
        <ComposerControlSkeleton widthClassName={composerOptionsPickerWidthClassName} />
      </>
    ) : selectedProviderRuntimeModelDiscoveryPending ? (
      <ComposerModelLoadingControl widthClassName={composerModelEffortPickerWidthClassName} />
    ) : (
      <ComposerControlSkeleton widthClassName={composerModelEffortPickerWidthClassName} />
    )
  ) : useSplitComposerPickerControls ? (
    <>
      <ProviderModelPicker
        compact={isComposerFooterCompact}
        hideLabel={!composerFooterControlsPlan.showModelLabel}
        provider={selectedProvider}
        model={selectedModelForPickerWithCustomFallback}
        lockedProvider={lockedProvider}
        providers={providerStatuses}
        modelOptionsByProvider={modelOptionsByProvider}
        loadingModelProviders={loadingModelProviders}
        hiddenProviders={settings.hiddenProviders}
        providerOrder={settings.providerOrder}
        onProviderModelChange={onProviderModelSelect}
        onSelectionCommitted={scheduleComposerFocus}
        open={isModelPickerOpen}
        onOpenChange={handleModelPickerOpenChange}
        shortcutLabel={modelPickerShortcutLabel}
      />
      <TraitsPicker
        provider={selectedProvider}
        threadId={threadId}
        model={selectedModelForPickerWithCustomFallback}
        runtimeModel={selectedRuntimeModel}
        runtimeModels={runtimeModelsByProvider[selectedProvider]}
        runtimeAgents={dynamicAgents}
        modelOptions={selectedProviderModelOptions}
        prompt={prompt}
        onPromptChange={setPromptFromTraits}
        open={isTraitsPickerOpen}
        onOpenChange={handleTraitsPickerOpenChange}
        onSelectionCommitted={scheduleComposerFocus}
        shortcutLabel={traitsPickerShortcutLabel}
        hideLabel={!composerFooterControlsPlan.showTraitsLabel}
      />
    </>
  ) : (
    <ComposerModelEffortPicker
      compact={isComposerFooterCompact}
      hideModelLabel={!composerFooterControlsPlan.showModelLabel}
      hideStatusLabel={!composerFooterControlsPlan.showTraitsLabel}
      provider={selectedProvider}
      model={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      loadingModelProviders={loadingModelProviders}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      threadId={threadId}
      runtimeModel={selectedRuntimeModel}
      runtimeModels={runtimeModelsByProvider[selectedProvider]}
      runtimeAgents={dynamicAgents}
      modelOptions={selectedProviderModelOptions}
      prompt={prompt}
      onPromptChange={setPromptFromTraits}
      onProviderModelChange={onProviderModelSelect}
      onSelectionCommitted={scheduleComposerFocus}
      open={isComposerModelEffortPickerOpen}
      onOpenChange={handleComposerModelEffortPickerOpenChange}
      shortcutLabel={modelPickerShortcutLabel}
    />
  );
  const toggleFastMode = useCallback(() => {
    if (!composerTraitSelection.caps.supportsFastMode) {
      scheduleComposerFocus();
      return;
    }
    setComposerDraftProviderModelOptions(
      threadId,
      selectedProvider,
      buildNextProviderOptions(selectedProvider, selectedProviderModelOptions, {
        fastMode: !composerTraitSelection.fastModeEnabled,
      }),
      { persistSticky: true },
    );
    scheduleComposerFocus();
  }, [
    composerTraitSelection.caps.supportsFastMode,
    composerTraitSelection.fastModeEnabled,
    scheduleComposerFocus,
    selectedProvider,
    selectedProviderModelOptions,
    setComposerDraftProviderModelOptions,
    threadId,
  ]);
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      const nextBranch =
        mode === "worktree"
          ? (activeThread?.branch ?? draftThread?.branch ?? activeRootBranch ?? null)
          : (activeThread?.branch ?? draftThread?.branch ?? null);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          envMode: mode,
          ...(mode === "local" ? { worktreePath: null } : {}),
          ...(nextBranch ? { branch: nextBranch } : {}),
        });
      }
      if (isServerThread && activeThread && !hasNativeUserMessages && !activeThread.session) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId,
            envMode: mode,
            ...(nextBranch ? { branch: nextBranch } : {}),
            ...(mode === "local" ? { worktreePath: null } : {}),
          });
        }
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      activeRootBranch,
      draftThread?.branch,
      hasNativeUserMessages,
      isLocalDraftThread,
      isServerThread,
      scheduleComposerFocus,
      setDraftThreadContext,
      threadId,
    ],
  );

  const moveEmptyDraftToLocalProject = useCallback(
    (projectId: ProjectId) => {
      // Project moves reset branch; the previous project's current branch may not exist here.
      moveDraftThreadToProject(threadId, projectId, LOCAL_PROJECT_DRAFT_CONTEXT);
      scheduleComposerFocus();
    },
    [moveDraftThreadToProject, scheduleComposerFocus, threadId],
  );

  const handleResetWorkspaceToHome = useCallback(() => {
    if (isLocalDraftThread) {
      if (isStudioContainer) {
        return (async () => {
          const studioProjectId = await ensureStudioProject({
            homeDir,
            chatWorkspaceRoot,
            studioWorkspaceRoot,
          });
          if (!studioProjectId) {
            throw new Error("Unable to prepare Studio.");
          }
          const api = readNativeApi();
          if (!api) {
            throw new Error("App is still connecting. Try again in a moment.");
          }
          const hasStudioProjectInStore = useStore
            .getState()
            .projects.some((project) => project.id === studioProjectId);
          if (!hasStudioProjectInStore) {
            const { project, snapshot } = await waitForShellProjectById(api, studioProjectId);
            if (!project || !snapshot) {
              throw new Error(PROJECT_CREATE_SYNC_ERROR);
            }
            syncServerShellSnapshot(snapshot);
          }
          moveEmptyDraftToLocalProject(studioProjectId);
        })();
      }
      if (!isHomeChatContainer) {
        return (async () => {
          if (!homeDir) {
            throw new Error("Home folder is not available yet.");
          }
          const homeProjectId = await ensureHomeChatProject({ homeDir, chatWorkspaceRoot });
          if (!homeProjectId) {
            throw new Error("Unable to prepare a normal chat.");
          }
          const api = readNativeApi();
          if (!api) {
            throw new Error("App is still connecting. Try again in a moment.");
          }
          const hasHomeProjectInStore = useStore
            .getState()
            .projects.some((project) => project.id === homeProjectId);
          if (!hasHomeProjectInStore) {
            const { project, snapshot } = await waitForShellProjectById(api, homeProjectId);
            if (!project || !snapshot) {
              throw new Error(PROJECT_CREATE_SYNC_ERROR);
            }
            syncServerShellSnapshot(snapshot);
          }
          moveEmptyDraftToLocalProject(homeProjectId);
        })();
      }
      setDraftThreadContext(threadId, {
        envMode: "local",
        worktreePath: null,
        branch: null,
        lastKnownPr: null,
      });
      scheduleComposerFocus();
      return;
    }

    if (activeThread) {
      setStoreThreadWorkspace(activeThread.id, {
        envMode: "local",
        worktreePath: null,
      });
      const api = readNativeApi();
      if (api && !hasNativeUserMessages && !activeThread.session) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThread.id,
          envMode: "local",
          worktreePath: null,
        });
      }
    }
    scheduleComposerFocus();
  }, [
    activeThread,
    chatWorkspaceRoot,
    hasNativeUserMessages,
    homeDir,
    isHomeChatContainer,
    isLocalDraftThread,
    isStudioContainer,
    moveEmptyDraftToLocalProject,
    scheduleComposerFocus,
    setDraftThreadContext,
    setStoreThreadWorkspace,
    studioWorkspaceRoot,
    syncServerShellSnapshot,
    threadId,
  ]);

  const handleSelectWorkspaceRoot = useCallback(
    (workspaceRoot: string) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          envMode: "worktree",
          worktreePath: workspaceRoot,
        });
        scheduleComposerFocus();
        return;
      }

      if (activeThread) {
        setStoreThreadWorkspace(activeThread.id, {
          envMode: "worktree",
          worktreePath: workspaceRoot,
        });
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      isLocalDraftThread,
      scheduleComposerFocus,
      setDraftThreadContext,
      setStoreThreadWorkspace,
      threadId,
    ],
  );

  const handleSelectProjectForEmptyDraft = useCallback(
    (projectId: ProjectId) => {
      if (!isLocalDraftThread) {
        return;
      }
      const project = useStore
        .getState()
        .projects.find((candidate) => candidate.id === projectId && candidate.kind === "project");
      if (!project) {
        throw new Error("Selected project is not available.");
      }
      if (draftThread?.projectId === projectId) {
        scheduleComposerFocus();
        return;
      }
      moveEmptyDraftToLocalProject(projectId);
    },
    [
      draftThread?.projectId,
      isLocalDraftThread,
      moveEmptyDraftToLocalProject,
      scheduleComposerFocus,
    ],
  );

  const handleCreateProjectFromPickerPath = useCallback(
    async (workspaceRoot: string) => {
      if (!isLocalDraftThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        throw new Error("App is still connecting. Try again in a moment.");
      }

      const existingProject = useStore
        .getState()
        .projects.find(
          (project) =>
            project.kind === "project" && workspaceRootsEqual(project.cwd, workspaceRoot),
        );
      if (existingProject) {
        handleSelectProjectForEmptyDraft(existingProject.id);
        return;
      }

      const creationResult = await createOrRecoverProjectFromPath({
        api,
        workspaceRoot,
        createIfMissing: false,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
      });
      if (creationResult.snapshot) {
        syncServerShellSnapshot(creationResult.snapshot);
      }
      if (!creationResult.created && !creationResult.project) {
        throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR);
      }
      if (!creationResult.project) {
        throw new Error(PROJECT_CREATE_SYNC_ERROR);
      }
      moveEmptyDraftToLocalProject(creationResult.project.id);
    },
    [
      handleSelectProjectForEmptyDraft,
      isLocalDraftThread,
      moveEmptyDraftToLocalProject,
      syncServerShellSnapshot,
    ],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; cursorOffset?: number },
    ): number | false => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      let nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      // Apply cursor offset if specified (e.g., -1 to position inside parentheses)
      if (options?.cursorOffset !== undefined) {
        nextCursor = Math.max(0, nextCursor + options.cursorOffset);
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInputKey) {
        const nextDraftAnswer = setPendingUserInputCustomAnswer(
          pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
            activePendingQuestion.id
          ],
          next.text,
        );
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
          [activePendingQuestion.id]: nextDraftAnswer,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: nextRequestAnswers,
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return nextCursor;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInputKey, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    selectionCollapsed: boolean;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      selectionCollapsed: true,
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: {
      value: string;
      cursor: number;
      expandedCursor: number;
      selectionCollapsed: boolean;
    };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  // Shared insertion path for picker selections (mentions, plugins, skills,
  // agents, provider-native commands, local folders). Guarantees the replacement
  // is flanked by a leading space when landing next to a non-whitespace char and
  // absorbs an existing trailing space so we don't end up with double spaces.
  const applyComposerTriggerReplacement = useCallback(
    (params: {
      snapshot: { value: string };
      trigger: ComposerTrigger;
      base: string;
      cursorOffset?: number;
      onApplied?: () => void;
    }): number | false => {
      const { snapshot, trigger, base, cursorOffset, onApplied } = params;
      const replacement = ensureLeadingSpaceForReplacement(
        snapshot.value,
        trigger.rangeStart,
        base,
      );
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const options: { expectedText: string; cursorOffset?: number } = {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      };
      if (cursorOffset !== undefined) {
        options.cursorOffset = cursorOffset;
      }
      const applied = applyPromptReplacement(
        trigger.rangeStart,
        replacementRangeEnd,
        replacement,
        options,
      );
      if (applied !== false) {
        onApplied?.();
        setComposerHighlightedItemId(null);
      }
      return applied;
    },
    [applyPromptReplacement],
  );

  // Replaces the active `@...` token with a completed absolute folder mention.
  const handleSelectLocalDirectoryMention = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${formatComposerMentionToken(absolutePath)} `,
      });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  // Rewrites the active `@...` mention to an absolute folder path with a trailing separator
  // so the local-folder picker stays open and the user can keep browsing by clicking or typing.
  // Paths that need quoting (spaces, parentheses, …) are written as an unclosed
  // `@"...` so detectComposerTrigger keeps matching while the user descends (#351).
  const handleNavigateLocalFolder = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      const separator = absolutePath.includes("\\") ? "\\" : "/";
      const withTrailingSeparator = absolutePath.endsWith(separator)
        ? absolutePath
        : `${absolutePath}${separator}`;
      const base = composerMentionPathNeedsQuoting(withTrailingSeparator)
        ? `@"${withTrailingSeparator}`
        : `@${withTrailingSeparator}`;
      applyComposerTriggerReplacement({ snapshot, trigger, base });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  const setComposerPromptValue = useCallback(
    (nextPrompt: string) => {
      setRestoredQueuedSourceProposedPlan(threadId, null);
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      setComposerHighlightedItemId(null);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
    },
    [setPrompt, setRestoredQueuedSourceProposedPlan, threadId],
  );

  const clearComposerSlashDraft = useCallback(() => {
    promptRef.current = "";
    setRestoredQueuedSourceProposedPlan(threadId, null);
    clearComposerDraftContent(threadId);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
    scheduleComposerFocus();
  }, [
    clearComposerDraftContent,
    scheduleComposerFocus,
    setRestoredQueuedSourceProposedPlan,
    threadId,
  ]);

  const slashEditorActions = useMemo(
    () => ({
      resolveActiveComposerTrigger,
      applyPromptReplacement,
      clearComposerSlashDraft,
      setComposerPromptValue,
      scheduleComposerFocus,
      setComposerHighlightedItemId,
    }),
    [
      applyPromptReplacement,
      clearComposerSlashDraft,
      resolveActiveComposerTrigger,
      scheduleComposerFocus,
      setComposerPromptValue,
    ],
  );

  const {
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
  } = useComposerSlashCommands({
    activeProject,
    activeThread,
    activeRootBranch,
    isServerThread,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      supportsThreadCompaction(providerComposerCapabilitiesQuery.data) &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferSideCommand,
    canOfferExportCommand,
    supportsTextNativeReviewCommand,
    fastModeEnabled,
    providerNativeCommands,
    providerCommandDiscoveryCwd: composerSkillCwd,
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
    environmentMode: envMode ?? null,
    runtimeMode,
    interactionMode,
    threadId,
    syncServerShellSnapshot,
    navigateToThread: (nextThreadId, options) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        ...(options?.splitViewId ? { search: () => ({ splitViewId: options.splitViewId }) } : {}),
      }),
    handleClearConversation: async () => {
      if (!activeProject) {
        toastManager.add({
          type: "warning",
          title: "Clear is unavailable",
          description: "Open a project before starting a fresh thread.",
        });
        return;
      }
      await handleNewThread(activeProject.id, { entryPoint: "chat" });
    },
    handleInteractionModeChange,
    openForkTargetPicker: () => {
      setComposerCommandPicker("fork-target");
      setComposerHighlightedItemId("fork-target:worktree");
    },
    openReviewTargetPicker: () => {
      setComposerCommandPicker("review-target");
      setComposerHighlightedItemId("review-target:changes");
    },
    setComposerDraftProviderModelOptions,
    editorActions: slashEditorActions,
  });

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      if (item.type === "fork-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleForkTargetSelection(item.target);
        return;
      }
      if (item.type === "review-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleReviewTargetSelection(item.target);
        return;
      }
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.path)} `,
        });
        return;
      }
      if (item.type === "local-root") {
        handleNavigateLocalFolder(localFolderBrowseRootPath ?? "/");
        return;
      }
      if (item.type === "slash-command") {
        handleSlashCommandSelection(item);
        return;
      }
      if (item.type === "provider-native-command") {
        if (selectedProvider === "codex" && item.command.toLowerCase() === "review") {
          setComposerCommandPicker("review-target");
          setComposerHighlightedItemId("review-target:changes");
          scheduleComposerFocus();
          return;
        }
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `/${item.command} `,
        });
        return;
      }
      if (item.type === "skill") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${skillMentionPrefix(selectedProvider)}${item.skill.name} `,
          onApplied: () => {
            updateSelectedComposerSkills((existing) => {
              const nextSkill = {
                name: item.skill.name,
                path: item.skill.path,
              } satisfies ProviderSkillReference;
              return existing.some(
                (skill) => skill.name === nextSkill.name && skill.path === nextSkill.path,
              )
                ? existing
                : [...existing, nextSkill];
            });
          },
        });
        return;
      }
      if (item.type === "plugin" || item.type === "thread") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.mention.name)} `,
          onApplied: () => {
            updateSelectedComposerMentions((existing) => {
              const nextMention = item.mention;
              const nextWithoutSameName = existing.filter(
                (mention) => mention.name !== nextMention.name,
              );
              return [...nextWithoutSameName, nextMention];
            });
          },
        });
        return;
      }
      if (item.type === "model") {
        onProviderModelSelect(item.provider, item.model);
        applyComposerTriggerReplacement({ snapshot, trigger, base: "" });
        return;
      }
      if (item.type === "agent") {
        // Insert @alias() and position cursor inside the parentheses.
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `@${item.alias}()`,
          cursorOffset: -1,
        });
      }
    },
    [
      applyComposerTriggerReplacement,
      scheduleComposerFocus,
      handleForkTargetSelection,
      handleNavigateLocalFolder,
      handleReviewTargetSelection,
      handleSlashCommandSelection,
      onProviderModelSelect,
      setComposerCommandPicker,
      localFolderBrowseRootPath,
      selectedProvider,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        providerPluginsQuery.isLoading ||
        providerPluginsQuery.isFetching)) ||
    (composerTriggerKind === "slash-command" &&
      (providerCommandsQuery.isLoading ||
        providerCommandsQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching));

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        const interruptedNavigation = promptHistoryNavigationRef.current;
        if (interruptedNavigation !== null) {
          // An active question ended the history browse while the persisted
          // prompt still held a recalled entry; put the real draft back.
          promptHistoryNavigationRef.current = null;
          restoreComposerDraftPromptHistorySavedDraft(threadId);
          promptRef.current = interruptedNavigation.draft;
          setPrompt(interruptedNavigation.draft);
        }
        expectedPromptHistoryPromptRef.current = null;
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      const expectedPromptHistoryPrompt = expectedPromptHistoryPromptRef.current;
      if (expectedPromptHistoryPrompt !== null) {
        if (nextPrompt === expectedPromptHistoryPrompt) {
          expectedPromptHistoryPromptRef.current = null;
        } else {
          // The user edited past the recalled entry: the edited text is the
          // draft now, so the saved pre-browse draft must not be restored.
          promptHistoryNavigationRef.current = null;
          expectedPromptHistoryPromptRef.current = null;
          setComposerDraftPromptHistorySavedDraft(threadId, null);
        }
      } else if (!applyingPromptHistoryNavigationRef.current) {
        const activePromptHistoryNavigation = promptHistoryNavigationRef.current;
        if (
          activePromptHistoryNavigation !== null &&
          !promptStillMatchesActiveHistoryBrowse({
            state: activePromptHistoryNavigation,
            history: promptHistory,
            nextPrompt,
            appliedPrompt: promptHistoryAppliedPromptRef.current,
          })
        ) {
          promptHistoryNavigationRef.current = null;
          setComposerDraftPromptHistorySavedDraft(threadId, null);
        }
      }
      const restoredQueuedSource = restoredQueuedSourceProposedPlanRef.current;
      if (
        restoredQueuedSource?.threadId === threadId &&
        !composerPromptStillMatchesRestoredQueuedDraft(
          restoredQueuedSource.restoredPrompt,
          nextPrompt,
        )
      ) {
        setRestoredQueuedSourceProposedPlan(threadId, null);
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (composerCommandPicker !== null && nextPrompt.trim().length > 0) {
        setComposerCommandPicker(null);
      }
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      composerCommandPicker,
      onChangeActivePendingUserInputCustomAnswer,
      promptHistory,
      restoreComposerDraftPromptHistorySavedDraft,
      setPrompt,
      setComposerDraftPromptHistorySavedDraft,
      setComposerDraftTerminalContexts,
      setComposerCommandPicker,
      setRestoredQueuedSourceProposedPlan,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => {
    if (key === "Slash" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      const slashTriggerText =
        trigger && (trigger.kind === "slash-command" || trigger.kind === "slash-model")
          ? snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd)
          : null;

      if (slashTriggerText === "/" && snapshot.expandedCursor === trigger?.rangeEnd) {
        // Pressing `/` again on a lone `/` dismisses the picker. Only wipe the
        // draft when the slash IS the whole prompt; a mid-line slash (e.g. after
        // an existing chip) must keep surrounding content, so let it type through.
        if (trigger.rangeStart === 0 && trigger.rangeEnd === snapshot.value.length) {
          clearComposerSlashDraft();
          return true;
        }
        return false;
      }
      return false;
    }

    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { snapshot, trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (
      key === "Enter" &&
      !event.shiftKey &&
      !menuIsActive &&
      extractChatAutomationInvocation(snapshot.value) !== null
    ) {
      void onSend(undefined, event.metaKey || event.ctrlKey ? "steer" : "queue");
      return true;
    }

    if (menuIsActive && isLocalFolderBrowserOpen) {
      if (key === "ArrowDown") {
        localDirectoryMenuRef.current?.moveHighlight("down");
        return true;
      }
      if (key === "ArrowUp") {
        localDirectoryMenuRef.current?.moveHighlight("up");
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        localDirectoryMenuRef.current?.activateHighlighted();
        return true;
      }
    }

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (
      shouldHandlePromptHistoryNavigationKey({
        key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        menuIsActive,
        hasActivePendingProgress: Boolean(activePendingProgress),
        isComposerApprovalState,
        pendingUserInputCount: pendingUserInputs.length,
      })
    ) {
      const direction = key === "ArrowUp" ? "older" : "newer";
      const previousNavigationState = promptHistoryNavigationRef.current;
      const result = resolvePromptHistoryNavigation({
        direction,
        history: promptHistory,
        currentPrompt: snapshot.value,
        // Line-boundary math needs raw string offsets; the collapsed cursor
        // undercounts inline token chips (mentions, links, slash commands).
        currentExpandedCursor: snapshot.expandedCursor,
        selectionCollapsed: snapshot.selectionCollapsed,
        state: previousNavigationState,
      });
      if (result.handled) {
        promptHistoryNavigationRef.current = result.state;
        if (result.state === null) {
          restoreComposerDraftPromptHistorySavedDraft(threadId);
        } else if (previousNavigationState === null) {
          setComposerDraftPromptHistorySavedDraft(
            threadId,
            captureComposerPromptHistorySavedDraft({
              threadId,
              draft: composerDraft,
              prompt: result.state.draft,
            }),
          );
        }
        applyingPromptHistoryNavigationRef.current = true;
        expectedPromptHistoryPromptRef.current = result.prompt;
        promptHistoryAppliedPromptRef.current = result.prompt;
        promptRef.current = result.prompt;
        setPrompt(result.prompt);
        setComposerCursor(collapseExpandedComposerCursor(result.prompt, result.expandedCursor));
        // Recalled text replaces the whole prompt; suppress trigger detection
        // so an entry ending in a mention/slash token cannot pop a menu that
        // would capture the next arrow keypress.
        setComposerTrigger(null);
        window.requestAnimationFrame(() => {
          applyingPromptHistoryNavigationRef.current = false;
        });
        return true;
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      if (promptHistoryNavigationRef.current !== null) {
        // Sending commits the recalled text as the prompt; drop the saved
        // draft here (not just in the send path) so it cannot linger and
        // resurrect a stale draft if the send is rejected.
        promptHistoryNavigationRef.current = null;
        setComposerDraftPromptHistorySavedDraft(threadId, null);
      }
      expectedPromptHistoryPromptRef.current = null;
      void onSend(undefined, event.metaKey || event.ctrlKey ? "steer" : "queue");
      return true;
    }
    return false;
  };
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onScrollToBottom = useCallback(() => {
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    scrollToEnd(true);
  }, [scrollToEnd]);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (diffEnvironmentPending) {
        return;
      }
      if (onOpenTurnDiffPanel) {
        onOpenTurnDiffPanel(turnId, filePath);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? {
                ...rest,
                panel: "diff",
                diff: "1",
                diffTurnId: turnId,
                diffFilePath: filePath,
              }
            : { ...rest, panel: "diff", diff: "1", diffTurnId: turnId };
        },
      });
    },
    [diffEnvironmentPending, navigate, onOpenTurnDiffPanel, threadId],
  );
  const onReviewComposerLiveChanges = useCallback(() => {
    if (!activeTurnLiveDiffState.turnId) {
      return;
    }
    onOpenTurnDiff(activeTurnLiveDiffState.turnId);
  }, [activeTurnLiveDiffState.turnId, onOpenTurnDiff]);
  const onNavigateToThread = useCallback(
    (nextThreadId: ThreadId) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: (previous) =>
          isEditorRail
            ? { ...stripDiffSearchParams(previous), view: "editor" }
            : stripDiffSearchParams(previous),
      });
    },
    [isEditorRail, navigate],
  );
  const onOpenAutomation = useCallback(
    (automationId: string) => {
      void navigate({
        to: "/automations/$automationId",
        params: { automationId },
      });
    },
    [navigate],
  );
  const activeProjectIdForNewChat = activeProject?.id ?? null;
  const onNewEditorChat = useCallback(() => {
    if (!activeProjectIdForNewChat) {
      return;
    }
    // Keep the editor workspace view (and any open file) across the new-thread
    // navigation; the default new-thread flow clears all search params.
    void handleNewThread(activeProjectIdForNewChat, undefined, {
      search: (previous) => ({ ...stripDiffSearchParams(previous), view: "editor" }),
    });
  }, [activeProjectIdForNewChat, handleNewThread]);
  const onOpenEditorChat = useCallback(
    (nextThreadId: ThreadId) => {
      storeOpenChatThreadPage(nextThreadId);
      onNavigateToThread(nextThreadId);
    },
    [onNavigateToThread, storeOpenChatThreadPage],
  );
  const onOpenEditorTerminal = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("workspace");
    setTerminalWorkspaceLayout("terminal-only");
    setTerminalWorkspaceTab("terminal");
    requestTerminalFocus();
  }, [
    activeThreadId,
    requestTerminalFocus,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
  ]);
  const onCloseEditorTerminal = useCallback(() => {
    void closeTerminal(terminalState.activeTerminalId);
  }, [closeTerminal, terminalState.activeTerminalId]);
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );
  const onRunProjectScriptFromHeader = useCallback(
    (script: ProjectScript) => {
      void runProjectScript(script);
    },
    [runProjectScript],
  );
  const dismissActiveThreadError = useCallback(() => {
    if (!activeThread) return;
    setThreadError(activeThread.id, null);
  }, [activeThread, setThreadError]);
  const dismissActiveProviderHealthBanner = useCallback(() => {
    if (!activeProviderHealthBannerDismissalKey) return;
    setDismissedProviderHealthBannerKeys((current) => {
      if (current.includes(activeProviderHealthBannerDismissalKey)) {
        return current;
      }
      return [activeProviderHealthBannerDismissalKey, ...current].slice(
        0,
        MAX_DISMISSED_PROVIDER_HEALTH_BANNERS,
      );
    });
  }, [activeProviderHealthBannerDismissalKey, setDismissedProviderHealthBannerKeys]);
  const dismissActiveRateLimitBanner = useCallback(() => {
    if (!activeRateLimitBannerDismissalKey) return;
    setDismissedRateLimitBannerKey(activeRateLimitBannerDismissalKey);
  }, [activeRateLimitBannerDismissalKey]);

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col text-[var(--color-text-foreground-secondary)]",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        {!isElectron && (
          <header className={cn(CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, "px-3 py-2 md:hidden")}>
            <div className="flex items-center gap-2">
              <SidebarHeaderTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-[var(--color-text-foreground)]">
                Threads
              </span>
            </div>
          </header>
        )}
        {isElectron && (
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "drag-region px-5",
              desktopTopBarTrafficLightGutterClassName,
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <SidebarHeaderNavigationControls />
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  const activeThreadDisplayTitle = resolveActiveThreadTitle({
    title: activeThread.title,
    subagentTitle: activeThread.parentThreadId
      ? resolveSubagentPresentationForThread({
          thread: activeThread,
          threads: threadLineageThreads,
        }).fullLabel
      : null,
    isHomeChat: isChatProject,
    isEmpty: timelineEntries.length === 0,
  });

  const handleRenameActiveThread = async (newTitle: string) => {
    const outcome = await dispatchThreadRename({
      threadId: activeThread.id,
      newTitle,
      unchangedTitles: [activeThread.title],
      createIfMissing: isLocalDraftThread
        ? {
            projectId: activeThread.projectId,
            modelSelection: activeThread.modelSelection,
            runtimeMode: activeThread.runtimeMode,
            interactionMode: activeThread.interactionMode,
            envMode: activeThread.envMode ?? "local",
            branch: activeThread.branch,
            worktreePath: activeThread.worktreePath,
            ...(activeThread.lastKnownPr !== undefined
              ? { lastKnownPr: activeThread.lastKnownPr }
              : {}),
            createdAt: activeThread.createdAt,
          }
        : undefined,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      throw error;
    });

    if (outcome === "empty") {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      return;
    }
    if (outcome === "unchanged" || outcome === "unavailable") {
      return;
    }
  };

  const runtimeUsageControlsProps = {
    runtimeMode,
    onRuntimeModeChange: handleRuntimeModeChange,
    contextWindow: runtimeUsageContextWindow,
    cumulativeCostUsd: activeCumulativeCostUsd,
    activeContextWindowLabel: contextWindowSelectionStatus.activeLabel,
    pendingContextWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
  };
  // The composer's leading controls (extras "+" menu, access-rules/runtime
  // indicator). At the narrowest footer tier they relocate from the footer to
  // the branch-toolbar row below the input instead of getting clipped; the
  // relocated variant is icon-only since relocation means space is minimal.
  const relocateComposerLeadingControls = composerFooterControlsPlan.relocateLeadingControls;
  const renderComposerLeadingControls = (options: { iconOnly: boolean }) => (
    <>
      <ComposerExtrasMenu
        interactionMode={interactionMode}
        supportsFastMode={composerTraitSelection.caps.supportsFastMode}
        fastModeEnabled={composerTraitSelection.fastModeEnabled}
        onAddPhotos={addComposerImages}
        onToggleFastMode={toggleFastMode}
        onSetPlanMode={setPlanMode}
      />
      {!isVoiceRecording && !isVoiceTranscribing ? (
        <RuntimeUsageControls
          {...runtimeUsageControlsProps}
          className="shrink-0"
          hideLabel={options.iconOnly}
        />
      ) : null}
    </>
  );
  const branchToolbarProps = {
    threadId: activeThread.id,
    onEnvModeChange,
    envLocked,
    onHandoffToWorktree,
    onHandoffToLocal,
    handoffBusy,
    onComposerFocusRequest: scheduleComposerFocus,
    ...(canCheckoutPullRequestIntoThread
      ? { onCheckoutPullRequestRequest: openPullRequestDialog }
      : {}),
  };
  const showEmptyLandingBranchToolbar =
    isCenteredEmptyLanding && activeProject?.kind === "project" && !isHomeChatContainer;
  // Temporary is chosen while starting a chat. Draft metadata covers local reloads;
  // the in-memory marker keeps the badge + auto-delete alive through promotion.
  const isThreadTemporary = draftThread?.isTemporary === true || hasTemporaryThreadMarker;
  const toggleDraftTemporary = () => {
    const next = !isThreadTemporary;
    setDraftThreadContext(threadId, { isTemporary: next });
    if (next) {
      markTemporaryThread(threadId);
    } else {
      clearTemporaryThread(threadId);
    }
  };
  const showEmptyLandingProjectPicker =
    isCenteredEmptyLanding && isLocalDraftThread && activeProject?.kind === "project";
  const emptyLandingProjectChip =
    !isEmptyChatLanding && !showEmptyLandingProjectPicker && activeProjectDisplayName ? (
      <span className="inline-flex min-w-0 max-w-56 shrink items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] sm:max-w-64">
        <FolderClosed className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{activeProjectDisplayName}</span>
      </span>
    ) : null;
  const showEmptyLandingControls =
    isCenteredEmptyLanding &&
    (isEmptyChatLanding ||
      showEmptyLandingProjectPicker ||
      emptyLandingProjectChip !== null ||
      showEmptyLandingBranchToolbar);
  const emptyLandingControls = showEmptyLandingControls ? (
    <div
      className={cn(
        // Full-width tray under the composer that reads as UNITED but not fused: it carries extra
        // top height (pt-6) and is pulled up by that amount (-mt-5 = 20px, just past the
        // --composer-radius ~19px corner). That hidden top slice sits BEHIND the composer's rounded
        // bottom corners (z-0), so its tint fills those corner notches and its straight full-width
        // top edge stays covered by the composer's solid sides — no gap/poke at the sides. The
        // composer keeps its own rounded shape; the tray keeps its tint + rounded bottom.
        "chat-composer-shell relative z-0 -mt-5 flex min-h-8 min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden !rounded-t-none !rounded-b-[var(--composer-radius)] bg-[color-mix(in_srgb,var(--color-background-elevated-secondary)_76%,var(--color-background-surface)_24%)] px-2 pb-1.5 pt-6 transition-colors duration-150 ease-out motion-reduce:transition-none sm:min-h-7",
        COMPOSER_COLUMN_FRAME_CLASS_NAME,
      )}
    >
      {isEmptyChatLanding ? (
        <ProjectPicker
          align="start"
          side="top"
          triggerClassName="h-7 py-1"
          showResetToHome={Boolean(resolvedThreadWorktreePath)}
          selectedWorkspaceRoot={resolvedThreadWorktreePath}
          onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
          onResetToHome={handleResetWorkspaceToHome}
          // Studio folder picks only tag the chat's workspace root; they never create a
          // Projects entry or move the draft out of the Studio container.
          {...(isStudioContainer
            ? {
                emptyTriggerLabel: "Use a folder",
                addActionLabel: "Choose a folder",
                resetActionLabel: "Don't use a folder",
                searchPlaceholder: "Search folders",
              }
            : {
                onSelectProject: handleSelectProjectForEmptyDraft,
                onCreateProjectFromPath: handleCreateProjectFromPickerPath,
              })}
        />
      ) : showEmptyLandingProjectPicker ? (
        <ProjectPicker
          align="start"
          side="top"
          triggerClassName="h-7 py-1"
          selectionMode="project"
          selectedProjectId={activeProject.id}
          selectedWorkspaceRoot={activeProject.cwd}
          showResetToHome
          onSelectProject={handleSelectProjectForEmptyDraft}
          onCreateProjectFromPath={handleCreateProjectFromPickerPath}
          onResetToHome={handleResetWorkspaceToHome}
        />
      ) : (
        emptyLandingProjectChip
      )}
      {/* Reserve the Local/branch slot so project selection fades controls in without resizing. */}
      <div
        aria-hidden={showEmptyLandingBranchToolbar ? undefined : true}
        className={cn(
          "flex min-w-0 flex-1 items-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          showEmptyLandingBranchToolbar
            ? "translate-y-0 opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        {showEmptyLandingBranchToolbar ? (
          <BranchToolbar
            {...branchToolbarProps}
            className="mx-0 min-w-0 flex-1 !justify-start !px-0 !pb-0 !pt-0"
            showBranchSelector={isGitRepo}
          />
        ) : null}
      </div>
      {showEmptyLandingBranchToolbar ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={isThreadTemporary}
          onClick={toggleDraftTemporary}
          title={
            isThreadTemporary
              ? "Temporary chat — deleted when you leave. Click to keep it."
              : "Make this a temporary chat (deleted when you leave)"
          }
          aria-label="Temporary chat"
          className={cn(
            "ml-auto shrink-0 gap-1.5 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] font-normal transition-colors sm:px-2.5",
            isThreadTemporary
              ? "text-[var(--color-text-accent)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-accent)]"
              : "text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
          )}
        >
          <TemporaryThreadIcon className="size-3.5" />
          <span className="sr-only sm:not-sr-only">Temporary</span>
        </Button>
      ) : null}
    </div>
  ) : null;

  const threadAutomationItems = heartbeatAutomationsForThread(
    automationData.definitions,
    activeThread.id,
  ).map((definition) => ({ definition }));

  // Shared inputs for both Environment panel surfaces (the header Popover when the dock is
  // open, and the docked right column when it is closed) so the two never drift.
  const environmentPanelProps: Omit<EnvironmentPanelProps, "open" | "variant"> = {
    gitCwd: threadWorkspaceCwd,
    openInTarget: threadWorkspaceCwd,
    githubRepository: githubRepositoryQuery.data?.repository ?? null,
    githubRepositories: githubRepositoryQuery.data?.repositories ?? [],
    isGitRepo,
    keybindings,
    availableEditors,
    activeThreadId: activeThread.id,
    activeProvider: activeThread.session?.provider ?? activeThread.modelSelection.provider,
    isStudioChat: isStudioContainer,
    studioFolderPath: isStudioContainer ? resolvedThreadWorktreePath : null,
    showGitActions,
    diffOpen: resolvedDiffOpen,
    threadAutomations: threadAutomationItems,
    diffDisabledReason,
    diffTotals: repoDiffTotals,
    branchToolbar: branchToolbarProps,
    recap: threadRecap,
    pinnedMessages,
    threadMarkers,
    pinnedMessageTextById,
    markerMessageTextById,
    notes: threadNotes,
    activeProjectId,
    projectInstructions,
    canCopyProjectInstructionsToNotes: !isLocalDraftThread,
    onProjectInstructionsChange: setProjectInstructions,
    onCopyProjectInstructionsToNotes: handleCopyProjectInstructionsToNotes,
    onToggleDiff,
    onOpenAutomation: openAutomationEditDialog,
    onOpenGithubRepository: openBrowserUrl,
    onJumpToPinnedMessage: handleJumpToPinnedMessage,
    onTogglePinnedMessageDone: handleTogglePinnedMessageDone,
    onUnpinMessage: handleUnpinMessage,
    onRenamePinnedMessage: handleRenamePinnedMessage,
    onJumpToThreadMarker: handleJumpToThreadMarker,
    onToggleThreadMarkerDone: handleToggleThreadMarkerDone,
    onRemoveThreadMarker: handleRemoveThreadMarker,
    onRenameThreadMarker: handleRenameThreadMarker,
    onNotesChange: handleNotesChange,
    onOpenEditorView: viewModeAction?.onClick ?? null,
    onClose: closeEnvironmentPanelAfterAction,
    onRegisterCommitAndPushTrigger,
  };
  // Full-width single chat: overlay plus transcript/composer inset. Floating overlay when the
  // column is already narrow — right dock open or a split pane (same as header compact mode).
  // Terminal surfaces always float so opening Environment never resizes the terminal workspace.
  const environmentAppliesContentInset = environmentPanelVisible && !environmentUsesFloatingOverlay;
  const environmentOverlayVariant = environmentUsesFloatingOverlay ? "floating" : "docked";
  const environmentHeaderState = environmentEnabled
    ? {
        open: environmentPanelVisible,
        onOpenChange: setEnvironmentPanelOpenPreference,
      }
    : null;

  const showComposerLiveChangesHeader = latestTurnLive && activeTurnLiveDiffState.hasChanges;
  const showComposerActiveTaskListCard = Boolean(activeTaskList && !planSidebarOpen);
  const showComposerWorkflowRunCard = workflowRunState !== null;
  const showComposerSubagentStrip = composerSubagentStripItems.length > 0;
  // The workflow card already lists its run and member agents, so the generic
  // "N background agents" footer only counts tasks outside the workflow.
  const composerBackgroundTaskCount = workflowRunState
    ? (activeBackgroundTasks?.taskIds.filter((taskId) => !workflowRunState.taskIds.includes(taskId))
        .length ?? 0)
    : (activeBackgroundTasks?.activeCount ?? 0);

  // Composer layout keeps the task list and footer actions in one render path so
  // follow-up prompts and normal chat mode stay visually in sync.
  const renderActiveTaskListCard = (attachedToPrevious: boolean) =>
    activeTaskList && showComposerActiveTaskListCard ? (
      <ComposerActiveTaskListCard
        activeTaskList={activeTaskList}
        backgroundTaskCount={composerBackgroundTaskCount}
        compact={activeTaskListCompact}
        onCompactChange={setActiveTaskListCompact}
        onOpenSidebar={() => setPlanSidebarOpen(true)}
        attachedToPrevious={attachedToPrevious}
      />
    ) : null;

  const composerSection =
    secondaryChromeReady && shouldRenderChatPaneContent ? (
      <div
        className={cn(isCenteredEmptyLanding ? "w-full overflow-visible" : "contents")}
        data-empty-landing-composer-block={isCenteredEmptyLanding ? "true" : undefined}
      >
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="relative z-10 w-full overflow-visible"
          data-chat-composer-form="true"
          data-chat-pane-scope={paneScopeId}
        >
          <ComposerColumnFrame>
            {/* A bare wrapper keeps the normal-flow panels' -mb-px seam onto the input shell
                via margin collapse. */}
            <div>
              {showComposerLiveChangesHeader ? (
                <ComposerLiveChangesHeader
                  fileCount={activeTurnLiveDiffState.fileCount}
                  additions={activeTurnLiveDiffState.additions}
                  deletions={activeTurnLiveDiffState.deletions}
                  onReview={
                    activeTurnLiveDiffState.turnId ? onReviewComposerLiveChanges : undefined
                  }
                />
              ) : null}
              {renderActiveTaskListCard(showComposerLiveChangesHeader)}
              {workflowRunState ? (
                <WorkflowRunCard
                  workflowRun={workflowRunState}
                  nowMs={workflowNowMs}
                  compact={workflowRunCardCompact}
                  onCompactChange={setWorkflowRunCardCompact}
                  onOpenThread={onNavigateToThread}
                  onStop={onStopWorkflowRun}
                  onPause={onPauseWorkflowRun}
                  onResume={onResumeWorkflowRun}
                  onDismiss={onDismissWorkflowRun}
                  attachedToPrevious={
                    showComposerLiveChangesHeader || showComposerActiveTaskListCard
                  }
                />
              ) : null}
              {showComposerSubagentStrip ? (
                <ComposerSubagentStrip
                  items={composerSubagentStripItems}
                  compact={subagentStripCompact}
                  onCompactChange={setSubagentStripCompact}
                  onOpenThread={onNavigateToThread}
                  onBackgroundItem={onBackgroundSubagentStripItem}
                  onStopItem={onStopSubagentStripItem}
                  onStopAll={onStopAllSubagentStripItems}
                  attachedToPrevious={
                    showComposerLiveChangesHeader ||
                    showComposerActiveTaskListCard ||
                    showComposerWorkflowRunCard
                  }
                />
              ) : null}
              <ComposerQueuedHeader
                queuedTurns={queuedComposerTurns}
                onSteer={onSteerQueuedComposerTurn}
                onRemove={removeQueuedComposerTurn}
                onEdit={onEditQueuedComposerTurn}
                cwd={threadWorkspaceCwd ?? undefined}
                attachedToPrevious={
                  showComposerLiveChangesHeader ||
                  showComposerActiveTaskListCard ||
                  showComposerWorkflowRunCard ||
                  showComposerSubagentStrip
                }
              />
              {/* Pending approvals and AskUserQuestion prompts both render as a detached
                  card floating just above the composer (padding gives the measured gap),
                  instead of a banner fused into the composer surface. An approval takes
                  precedence and suppresses the question card while one is active. */}
              {activePendingApproval ? (
                <div className="pb-2">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                    isResponding={respondingRequestKeys.includes(
                      pendingRequestInstanceKey(
                        activePendingApproval.requestId,
                        activePendingApproval.lifecycleGeneration,
                      ),
                    )}
                    onRespond={onRespondToApproval}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="pb-2">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    isResponding={activePendingIsResponding}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onToggleActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onPrevious={onPreviousActivePendingUserInputQuestion}
                    onCancel={onCancelActivePendingUserInput}
                  />
                </div>
              ) : null}
            </div>
            <div
              className={cn(
                COMPOSER_INPUT_SHELL_CLASS_NAME,
                composerProviderState.composerFrameClassName,
                composerMenuOpen && !isComposerApprovalState && "overflow-visible",
              )}
            >
              <div
                className={cn(
                  COMPOSER_INPUT_SURFACE_CLASS_NAME,
                  composerProviderState.composerSurfaceClassName,
                  composerMenuOpen && !isComposerApprovalState && "overflow-visible",
                )}
              >
                <ComposerInputBanners
                  roundedTopReset={false}
                  planFollowUp={
                    !activePendingApproval &&
                    pendingUserInputs.length === 0 &&
                    showPlanFollowUpPrompt &&
                    activeProposedPlan
                      ? {
                          id: activeProposedPlan.id,
                          title: proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null,
                        }
                      : null
                  }
                  automationSetup={
                    !activePendingApproval &&
                    pendingUserInputs.length === 0 &&
                    pendingAutomationConversation &&
                    pendingAutomationConversation.threadId === threadId
                      ? { onCancel: cancelAutomationConversation }
                      : null
                  }
                />
                <div
                  className={cn(
                    COMPOSER_EDITOR_PADDING_CLASS_NAME,
                    composerMenuOpen && !isComposerApprovalState && "overflow-visible",
                  )}
                >
                  {composerMenuOpen && !isComposerApprovalState ? (
                    <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                      {isLocalFolderBrowserOpen ? (
                        <ComposerLocalDirectoryMenu
                          mentionQuery={mentionTriggerQuery}
                          rootLabel={localFolderBrowseRootPath ?? "Local folders unavailable"}
                          homeDir={serverConfigQuery.data?.homeDir ?? null}
                          onSelectEntry={(absolutePath) =>
                            handleSelectLocalDirectoryMention(absolutePath)
                          }
                          onNavigateFolder={handleNavigateLocalFolder}
                          handleRef={localDirectoryMenuRef}
                        />
                      ) : (
                        <ComposerCommandMenu
                          items={composerMenuItems}
                          resolvedTheme={resolvedTheme}
                          isLoading={isComposerMenuLoading}
                          triggerKind={
                            composerCommandPicker !== null
                              ? "slash-command"
                              : effectiveComposerTriggerKind
                          }
                          activeItemId={activeComposerMenuItem?.id ?? null}
                          onHighlightedItemChange={onComposerMenuItemHighlighted}
                          onSelect={onSelectComposerItem}
                        />
                      )}
                    </div>
                  ) : null}
                  {!isComposerApprovalState &&
                    pendingUserInputs.length === 0 &&
                    (composerAssistantSelections.length > 0 ||
                      composerFileComments.length > 0 ||
                      composerPastedTexts.length > 0 ||
                      composerFiles.length > 0 ||
                      composerImages.length > 0) && (
                      <ComposerReferenceAttachments
                        assistantSelections={composerAssistantSelections}
                        fileComments={composerFileComments}
                        pastedTexts={composerPastedTexts}
                        files={composerFiles}
                        images={composerImages}
                        nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                        onExpandImage={setExpandedImage}
                        onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
                        onRemoveFileComments={clearComposerFileCommentsFromDraft}
                        onRemovePastedText={removeComposerPastedTextFromDraft}
                        onShowPastedTextInField={showComposerPastedTextInField}
                        onRemoveFile={removeComposerFile}
                        onRemoveImage={removeComposerImage}
                      />
                    )}
                  <ComposerPromptEditor
                    ref={composerEditorRef}
                    value={
                      isComposerApprovalState
                        ? ""
                        : activePendingProgress
                          ? activePendingProgress.customAnswer
                          : prompt
                    }
                    cursor={composerCursor}
                    terminalContexts={
                      !isComposerApprovalState && pendingUserInputs.length === 0
                        ? composerTerminalContexts
                        : []
                    }
                    mentionReferences={selectedComposerMentions}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={onPromptChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onPaste={onComposerPaste}
                    {...(canCollapsePastedTextToDraft
                      ? { onCollapsePastedText: addPastedTextToDraft }
                      : {})}
                    placeholder={
                      isComposerApprovalState
                        ? "Resolve this approval request to continue"
                        : activePendingProgress
                          ? activePendingProgress.activeQuestion?.options.length === 0
                            ? "Type your answer to continue"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : activeThread?.parentThreadId
                              ? "Message this subagent while it works"
                              : hasLiveTurn
                                ? "Ask for follow-up changes"
                                : phase === "disconnected"
                                  ? "Ask for follow-up changes or attach images"
                                  : "Ask anything, @tag files/folders, or use / to show available commands"
                    }
                    disabled={isComposerEditorDisabled}
                  />
                </div>
                {/* Bottom toolbar — hidden while an approval takes over the composer,
                    since the approve/decline actions live in the detached approval card
                    floating above (see ComposerPendingApprovalPanel). */}
                {activePendingApproval ? null : (
                  <div
                    data-chat-composer-footer="true"
                    className={cn(
                      "@container",
                      COMPOSER_FOOTER_ROW_CLASS_NAME,
                      isComposerFooterCompact
                        ? "gap-1.5"
                        : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
                    )}
                  >
                    <div
                      data-chat-composer-leading="true"
                      className={cn(
                        "flex items-center",
                        isVoiceRecording || isVoiceTranscribing
                          ? "min-w-0 shrink-0 gap-1"
                          : isComposerFooterCompact
                            ? "min-w-0 flex-1 gap-1 overflow-hidden"
                            : "min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                      )}
                    >
                      {relocateComposerLeadingControls
                        ? null
                        : renderComposerLeadingControls({ iconOnly: false })}

                      {!isVoiceRecording && !isVoiceTranscribing ? (
                        <>
                          {interactionMode === "plan" ? (
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] sm:px-3"
                              size="sm"
                              type="button"
                              onClick={toggleInteractionMode}
                              title="Plan mode — click to return to normal build mode"
                            >
                              <GoTasklist className="size-3.5" />
                              <span className="sr-only sm:not-sr-only">Plan</span>
                            </Button>
                          ) : null}

                          {activeTaskList || sidebarProposedPlan || planSidebarOpen ? (
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal sm:px-3"
                              size="sm"
                              type="button"
                              onClick={togglePlanSidebar}
                              title={planSidebarToggleTitle}
                              aria-label={planSidebarToggleTitle}
                            >
                              <LayoutSidebarIcon className="size-3.5" />
                              <span className="sr-only sm:not-sr-only">
                                {planSidebarToggleLabel}
                              </span>
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    <div
                      data-chat-composer-actions="right"
                      className={cn(
                        "flex items-center gap-2",
                        isVoiceRecording || isVoiceTranscribing ? "min-w-0 flex-1" : "shrink-0",
                      )}
                    >
                      {!isVoiceRecording &&
                      !isVoiceTranscribing &&
                      runtimeUsageContextWindow &&
                      composerFooterControlsPlan.showContextMeter ? (
                        <ContextWindowMeter
                          usage={runtimeUsageContextWindow}
                          {...(activeCumulativeCostUsd != null
                            ? { cumulativeCostUsd: activeCumulativeCostUsd }
                            : {})}
                          {...(contextWindowSelectionStatus.activeLabel !== undefined
                            ? {
                                activeWindowLabel: contextWindowSelectionStatus.activeLabel,
                              }
                            : {})}
                          {...(contextWindowSelectionStatus.pendingSelectedLabel !== undefined
                            ? {
                                pendingWindowLabel:
                                  contextWindowSelectionStatus.pendingSelectedLabel,
                              }
                            : {})}
                        />
                      ) : null}
                      {!isVoiceRecording && !isVoiceTranscribing ? composerPickerControls : null}
                      {showVoiceNotesControl && (isVoiceRecording || isVoiceTranscribing) ? (
                        <ComposerVoiceRecorderBar
                          disabled={isComposerApprovalState || isConnecting || isSendBusy}
                          isRecording={isVoiceRecording}
                          isTranscribing={isVoiceTranscribing}
                          durationLabel={voiceRecordingDurationLabel}
                          waveformLevels={voiceWaveformLevels}
                          onCancel={() => {
                            if (isVoiceRecording) {
                              void submitComposerVoiceRecording();
                              return;
                            }
                            cancelComposerVoiceRecording();
                          }}
                          onSubmit={() => {
                            void submitComposerVoiceRecording();
                          }}
                        />
                      ) : null}
                      {activePendingProgress ? (
                        <Button
                          type="submit"
                          size="sm"
                          className="rounded-full px-4"
                          disabled={
                            activePendingIsResponding ||
                            (activePendingProgress.isLastQuestion
                              ? !activePendingResolvedAnswers
                              : !activePendingProgress.canAdvance)
                          }
                        >
                          {activePendingIsResponding
                            ? "Submitting..."
                            : activePendingProgress.isLastQuestion
                              ? "Submit answers"
                              : "Next question"}
                        </Button>
                      ) : phase === "running" ? (
                        <Button
                          type="button"
                          variant="prominent"
                          size="icon-xs"
                          className="sm:size-[26px]"
                          onClick={() => void onInterrupt()}
                          aria-label="Stop generation"
                          title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                        >
                          <span
                            aria-hidden="true"
                            className="block size-2 rounded-[1px] bg-current"
                          />
                        </Button>
                      ) : pendingUserInputs.length === 0 &&
                        !isVoiceRecording &&
                        !isVoiceTranscribing ? (
                        showPlanFollowUpPrompt ? (
                          prompt.trim().length > 0 ? (
                            <Button
                              type="submit"
                              size="sm"
                              className="h-9 rounded-full px-4 sm:h-8"
                              disabled={isSendBusy || isConnecting}
                            >
                              {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                            </Button>
                          ) : (
                            <div className="flex items-center">
                              <Button
                                type="submit"
                                size="sm"
                                className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                                disabled={isSendBusy || isConnecting}
                              >
                                {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                              </Button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <Button
                                      size="sm"
                                      variant="default"
                                      className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                      aria-label="Implementation actions"
                                      disabled={isSendBusy || isConnecting}
                                    />
                                  }
                                >
                                  <ChevronDownIcon className="size-3.5" />
                                </MenuTrigger>
                                <ComposerPickerMenuPopup align="end" side="top">
                                  <MenuItem
                                    disabled={isSendBusy || isConnecting}
                                    onClick={() => void onImplementPlanInNewThread()}
                                  >
                                    Implement in a new thread
                                  </MenuItem>
                                </ComposerPickerMenuPopup>
                              </Menu>
                            </div>
                          )
                        ) : (
                          <>
                            {showVoiceNotesControl ? (
                              <ComposerVoiceButton
                                disabled={isComposerApprovalState || isConnecting || isSendBusy}
                                isRecording={isVoiceRecording}
                                isTranscribing={isVoiceTranscribing}
                                durationLabel={voiceRecordingDurationLabel}
                                onClick={toggleComposerVoiceRecording}
                              />
                            ) : null}
                            <Button
                              type="submit"
                              variant="prominent"
                              size="icon-xs"
                              className="size-7 rounded-full sm:size-7"
                              disabled={
                                isSendBusy ||
                                isConnecting ||
                                isVoiceTranscribing ||
                                !composerSendState.hasSendableContent
                              }
                              aria-label={
                                isConnecting
                                  ? "Connecting"
                                  : isVoiceTranscribing
                                    ? "Transcribing voice note"
                                    : isPreparingWorktree
                                      ? "Preparing worktree"
                                      : isSendBusy
                                        ? "Sending"
                                        : "Send message"
                              }
                            >
                              {isConnecting || isSendBusy ? (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 14 14"
                                  fill="none"
                                  className="animate-spin"
                                  aria-hidden="true"
                                >
                                  <circle
                                    cx="7"
                                    cy="7"
                                    r="5.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeDasharray="20 12"
                                  />
                                </svg>
                              ) : (
                                <ComposerSendArrowIcon
                                  aria-hidden="true"
                                  className="size-5 shrink-0"
                                />
                              )}
                            </Button>
                          </>
                        )
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ComposerColumnFrame>
        </form>
        {emptyLandingControls}
      </div>
    ) : (
      <div
        aria-hidden="true"
        className="w-full overflow-visible"
        data-chat-composer-form="deferred"
      >
        <div
          className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, COMPOSER_COLUMN_FRAME_CLASS_NAME)}
          style={{ height: secondaryChromePlaceholderHeight }}
        />
      </div>
    );

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {/* Subtle accent tint over the whole pane while a file is dragged anywhere over it,
          signalling that dropping it will attach the file to the composer. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-50 transition-opacity duration-150",
          "bg-info/8 ring-1 ring-inset ring-info/30",
          isDragOverComposer ? "opacity-100" : "opacity-0",
        )}
      />
      {/* Top bar */}
      <header
        className={cn(
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          !isEditorRail && CHAT_SURFACE_HEADER_PADDING_X_CLASS,
          "flex items-center",
          isEditorRail ? "h-10" : CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          isElectron && "drag-region",
          // The editor-rail chat header sits in the editor's second row (inside the
          // right-side chat pane), not flush against the window edges — the editor's
          // own top bar already reserves both desktop window-control gutters. Applying
          // them here just leaves redundant empty space on the sides.
          !isEditorRail && desktopTopBarTrafficLightGutterClassName,
          !isEditorRail && desktopTopBarWindowControlsGutterClassName,
        )}
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThreadDisplayTitle}
          activeThreadEntryPoint={terminalState.entryPoint}
          activeProvider={activeThread.session?.provider ?? activeThread.modelSelection.provider}
          activeProjectName={isEditorRail ? undefined : activeProjectDisplayName}
          threadBreadcrumbs={threadBreadcrumbs}
          {...(isEditorRail
            ? { className: cn(CHAT_SURFACE_HEADER_PADDING_X_CLASS, "h-full") }
            : {})}
          isSidechat={Boolean(activeThread.sidechatSourceThreadId)}
          hideSidebarControls={isEditorRail}
          hideHandoffControls={terminalWorkspaceTerminalTabActive || isEditorRail}
          isGitRepo={isGitRepo}
          openInTarget={threadWorkspaceCwd}
          activeProjectScripts={isEditorRail ? undefined : activeProjectScripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          handoffBadgeLabel={handoffBadgeLabel}
          handoffActionLabel={handoffActionLabel}
          handoffDisabled={handoffDisabled}
          handoffActionTargetProviders={handoffTargetProviders}
          handoffBadgeSourceProvider={handoffBadgeSourceProvider}
          handoffBadgeTargetProvider={handoffBadgeTargetProvider}
          gitCwd={threadWorkspaceCwd}
          diffTotals={repoDiffTotals}
          showGitActions={showGitActions && !isEditorRail}
          showDiffToggle={!isEditorRail}
          diffOpen={resolvedDiffOpen}
          diffDisabledReason={diffDisabledReason}
          environment={isEditorRail ? null : environmentHeaderState}
          surfaceMode={surfaceMode}
          chatLayoutAction={
            surfaceMode === "single" && onSplitSurface
              ? {
                  kind: "split",
                  label: "Split chat",
                  shortcutLabel: chatSplitShortcutLabel,
                  onClick: onSplitSurface,
                }
              : surfaceMode === "split" && isFocusedPane && onMaximizeSurface
                ? {
                    kind: "maximize",
                    label: "Expand this chat",
                    shortcutLabel: null,
                    onClick: onMaximizeSurface,
                  }
                : null
          }
          editorChatControls={
            isEditorRail && activeProject
              ? {
                  projectId: activeProject.id,
                  activeSurface: terminalWorkspaceTerminalTabActive ? "terminal" : "chat",
                  terminalAvailable: terminalState.terminalOpen,
                  terminalHasRunningActivity: terminalState.runningTerminalIds.length > 0,
                  onNewChat: onNewEditorChat,
                  onNewTerminal: onOpenEditorTerminal,
                  onOpenChat: onOpenEditorChat,
                  onOpenTerminal: onOpenEditorTerminal,
                  onCloseTerminal: onCloseEditorTerminal,
                }
              : null
          }
          changeThreadAction={
            surfaceMode === "split" && isFocusedPane && onChangeThreadInSplitPane
              ? {
                  label: "Change thread",
                  onClick: onChangeThreadInSplitPane,
                }
              : null
          }
          onRunProjectScript={onRunProjectScriptFromHeader}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onToggleDiff={onToggleDiff}
          onRegisterCommitAndPushTrigger={onRegisterCommitAndPushTrigger}
          onCreateHandoff={onCreateHandoffThread}
          onNavigateToThread={onNavigateToThread}
          onRenameThread={() => setRenameDialogOpen(true)}
          {...(onCloseThreadPane ? { onCloseThreadPane } : {})}
        />
      </header>

      <RenameThreadDialog
        open={renameDialogOpen}
        currentTitle={activeThread.title}
        onOpenChange={setRenameDialogOpen}
        onSave={handleRenameActiveThread}
      />
      {automationDraftForm ? (
        <AutomationDialog
          open={automationDraftOpen}
          editing={automationEditingDefinition !== null}
          form={automationDraftForm}
          projects={automationProjects}
          threads={automationThreads}
          warnings={automationDraftWarnings}
          acknowledgedWarningIds={acknowledgedAutomationWarnings}
          onToggleWarning={toggleAutomationWarning}
          onOpenChange={setAutomationDraftDialogOpen}
          onFormChange={updateAutomationDraftForm}
          onSubmit={submitAutomationDraft}
          busy={isAutomationDraftSubmitting || automationUpdateMutation.isPending}
        />
      ) : null}

      {/* Error banner */}
      <ProviderHealthBanner
        status={shouldShowProviderHealthBanner ? visibleActiveProviderStatus : null}
        onDismiss={dismissActiveProviderHealthBanner}
      />
      <ThreadErrorBanner error={activeThread.error} onDismiss={dismissActiveThreadError} />
      <RateLimitBanner
        rateLimitStatus={visibleActiveRateLimitStatus}
        onDismiss={dismissActiveRateLimitBanner}
      />
      {terminalWorkspaceOpen && !isEditorRail ? (
        <TerminalWorkspaceTabs
          activeTab={terminalState.workspaceActiveTab}
          isWorking={isWorking}
          terminalHasRunningActivity={terminalState.runningTerminalIds.length > 0}
          terminalCount={terminalState.terminalIds.length}
          workspaceLayout={terminalState.workspaceLayout}
          onSelectTab={setTerminalWorkspaceTab}
        />
      ) : null}
      {/* Main content area with optional plan sidebar */}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Chat column */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            aria-hidden={terminalWorkspaceTerminalTabActive}
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
            )}
          >
            {shouldRenderChatPaneContent && isCenteredEmptyLanding ? (
              <div
                className={cn(
                  "chat-pane-enter flex flex-1 items-center justify-center",
                  CHAT_COLUMN_GUTTER_CLASS_NAME,
                )}
              >
                {/* Center the heading, composer, and suggestion list together as a
                    single group: the suggestions live in normal flow so the whole
                    block (composer + suggestions) stays vertically centered in the
                    view instead of the composer being centered with the list hanging
                    below it. */}
                <div className="flex w-full flex-col justify-center">
                  <div
                    className={cn(
                      "flex flex-col items-center gap-4 px-6 pb-5 text-center select-none",
                      CHAT_COLUMN_FRAME_CLASS_NAME,
                    )}
                  >
                    <SynaraLogo aria-label="Synara logo" className="size-10" />
                    <h2
                      data-testid="empty-landing-heading"
                      className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]"
                    >
                      {isEmptyChatLanding ? (
                        "What should we work on?"
                      ) : (
                        <>
                          What should we do in{" "}
                          {showEmptyLandingProjectPicker ? (
                            <ProjectPicker
                              align="center"
                              side="bottom"
                              selectionMode="project"
                              selectedProjectId={activeProject.id}
                              selectedWorkspaceRoot={activeProject.cwd}
                              showResetToHome
                              onSelectProject={handleSelectProjectForEmptyDraft}
                              onCreateProjectFromPath={handleCreateProjectFromPickerPath}
                              onResetToHome={handleResetWorkspaceToHome}
                              renderTrigger={
                                <button
                                  type="button"
                                  data-testid="empty-landing-heading-project-trigger"
                                  className="cursor-pointer rounded-sm text-inherit underline decoration-dotted decoration-[1.5px] decoration-foreground/45 underline-offset-[6px] transition-colors duration-150 ease-out hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                                >
                                  {activeProjectDisplayName ?? "this folder"}
                                </button>
                              }
                            />
                          ) : (
                            <span className={COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME}>
                              {activeProjectDisplayName ?? "this folder"}
                            </span>
                          )}
                          ?
                        </>
                      )}
                    </h2>
                  </div>
                  {composerSection}
                  {(isGitRepo && !environmentEnabled && !isCenteredEmptyLanding) ||
                  relocateComposerLeadingControls ? (
                    <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                      <div className="flex w-full items-center gap-1">
                        {relocateComposerLeadingControls ? (
                          <div className="flex shrink-0 items-center gap-1 pl-1">
                            {renderComposerLeadingControls({ iconOnly: true })}
                          </div>
                        ) : null}
                        {isGitRepo && !environmentEnabled && !isCenteredEmptyLanding ? (
                          <BranchToolbar {...branchToolbarProps} className="min-w-0 flex-1" />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {shouldRenderChatPaneContent && !isCenteredEmptyLanding ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ChatTranscriptPane
                    activeThreadId={activeThread.id}
                    activeTurnId={activeThread.session?.activeTurnId ?? null}
                    agentActivityDetail={openAgentActivityDetail}
                    hasMessages={timelineEntries.length > 0}
                    isWorking={isWorking}
                    worktreeSetup={activeWorktreeSetup}
                    activeTurnInProgress={activeTurnInProgress}
                    activeTurnStartedAt={activeWorkStartedAt}
                    listRef={legendListRef}
                    timelineControllerRef={timelineControllerRef}
                    pinnedMessageIds={pinnedMessageIds}
                    canPinMessage={(messageId) => !isPendingSetupBubbleId(messageId)}
                    onTogglePinMessage={handleTogglePinMessageGuarded}
                    threadMarkers={threadMarkers}
                    enteringUserMessageIds={enteringUserMessageIds}
                    crossTaskOrigin={crossTaskOrigin}
                    timelineEntries={timelineEntries}
                    turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                    onOpenTurnDiff={onOpenTurnDiff}
                    onOpenThread={onNavigateToThread}
                    onOpenAutomation={onOpenAutomation}
                    subagentToolTraceByThreadId={subagentToolTraceByThreadId}
                    revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                    onRevertUserMessage={onRevertUserMessage}
                    onUndoTurnFiles={onUndoTurnFiles}
                    onEditUserMessage={onEditUserMessage}
                    isRevertingCheckpoint={isRevertingCheckpoint}
                    onExpandTimelineImage={onExpandTimelineImage}
                    followLiveOutput={hasStreamingAssistantText}
                    onIsAtEndChange={onIsAtEndChange}
                    markdownCwd={threadWorkspaceCwd ?? undefined}
                    resolvedTheme={resolvedTheme}
                    chatFontSizePx={settings.chatFontSizePx}
                    timestampFormat={timestampFormat}
                    workspaceRoot={activeProject?.cwd ?? undefined}
                    emptyStateContent={isEditorRail ? <span aria-hidden="true" /> : undefined}
                    emptyStateProjectName={activeProjectDisplayName}
                    terminalWorkspaceTerminalTabActive={terminalWorkspaceTerminalTabActive}
                    onMessagesScroll={onMessagesScroll}
                    onMessagesClickCapture={onMessagesClickCapture}
                    onMessagesMouseUp={onMessagesMouseUp}
                    onMessagesWheel={onMessagesWheel}
                    onMessagesPointerDown={onMessagesPointerDown}
                    onMessagesPointerUp={onMessagesPointerUp}
                    onMessagesPointerCancel={onMessagesPointerCancel}
                    onMessagesTouchStart={onMessagesTouchStart}
                    onMessagesTouchMove={onMessagesTouchMove}
                    onMessagesTouchEnd={onMessagesTouchEnd}
                    onOpenAgentActivity={setOpenAgentActivityId}
                    onCloseAgentActivityDetail={() => setOpenAgentActivityId(null)}
                    scrollButtonVisible={showScrollToBottom}
                    onScrollToBottom={onScrollToBottom}
                    contentInsetRightPx={
                      environmentAppliesContentInset
                        ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX
                        : undefined
                    }
                  />
                </div>

                <div
                  className={cn(
                    "relative z-10 -mt-5 w-full shrink-0 overflow-visible pt-0 sm:pt-0",
                    ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
                    CHAT_COLUMN_GUTTER_CLASS_NAME,
                    // A trailing BranchToolbar only renders for legacy git threads; otherwise the
                    // composer is the last element, so give it a comfortable bottom margin.
                    isGitRepo && !environmentEnabled ? "pb-0.5" : "pb-3 sm:pb-4",
                  )}
                  // Match the transcript's right inset so the composer stays aligned with chat
                  // content (and clear of the docked Environment overlay).
                  style={
                    environmentAppliesContentInset
                      ? { paddingRight: ENVIRONMENT_DOCKED_CONTENT_INSET_PX }
                      : undefined
                  }
                >
                  {composerSection}
                </div>
                {secondaryChromeReady &&
                ((isGitRepo && !environmentEnabled) || relocateComposerLeadingControls) ? (
                  <div className={CHAT_COLUMN_GUTTER_CLASS_NAME}>
                    <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                      <div className="flex w-full items-center gap-1">
                        {relocateComposerLeadingControls ? (
                          <div className="flex shrink-0 items-center gap-1 pl-1">
                            {renderComposerLeadingControls({ iconOnly: true })}
                          </div>
                        ) : null}
                        {isGitRepo && !environmentEnabled ? (
                          <BranchToolbar {...branchToolbarProps} className="min-w-0 flex-1" />
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {shouldRenderChatPaneContent && secondaryChromeReady && pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                cwd={activeProject?.cwd ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>

          {terminalWorkspaceOpen ? (
            <div
              aria-hidden={!terminalWorkspaceTerminalTabActive}
              className={cn(
                "absolute inset-0 min-h-0 min-w-0 transition-all duration-200 ease-out",
                terminalWorkspaceTerminalTabActive
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none translate-y-1 opacity-0",
              )}
            >
              <ThreadTerminalDrawer
                key={`${activeThread.id}-workspace`}
                {...terminalDrawerProps}
                presentationMode="workspace"
                isVisible={terminalWorkspaceTerminalTabActive}
                onTogglePresentationMode={
                  terminalState.workspaceLayout === "both" ? collapseTerminalWorkspace : undefined
                }
              />
            </div>
          ) : null}

          {/* Environment overlay — always mounted so open/close can transition in lockstep with inset. */}
          {environmentEnabled ? (
            <EnvironmentPanel
              {...environmentPanelProps}
              open={environmentPanelVisible}
              variant={environmentOverlayVariant}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        {planSidebarOpen ? (
          <PlanSidebar
            activeTaskList={activeTaskList}
            activeProposedPlan={sidebarProposedPlan}
            markdownCwd={threadWorkspaceCwd ?? undefined}
            workspaceRoot={activeProject?.cwd ?? undefined}
            timestampFormat={timestampFormat}
            onClose={() => {
              setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              const turnKey = activeTaskList?.turnId ?? sidebarProposedPlan?.turnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            }}
          />
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {(() => {
        if (!terminalState.terminalOpen || terminalWorkspaceOpen) {
          return null;
        }
        return (
          <ThreadTerminalDrawer
            key={activeThread.id}
            {...terminalDrawerProps}
            presentationMode="drawer"
            onTogglePresentationMode={expandTerminalWorkspace}
          />
        );
      })()}

      <ComposerSlashStatusDialog
        open={isSlashStatusDialogOpen}
        onOpenChange={setIsSlashStatusDialogOpen}
        selectedModel={selectedModel}
        fastModeEnabled={fastModeEnabled}
        selectedPromptEffort={selectedPromptEffort}
        interactionMode={interactionMode}
        envMode={envMode}
        envState={envState}
        branch={activeThread?.branch ?? activeRootBranch}
        contextWindow={activeContextWindow}
        cumulativeCostUsd={activeCumulativeCostUsd}
        rateLimitStatus={activeRateLimitStatus}
        activeContextWindowLabel={contextWindowSelectionStatus.activeLabel}
        pendingContextWindowLabel={contextWindowSelectionStatus.pendingSelectedLabel}
      />
      <ThreadWorktreeHandoffDialog
        open={worktreeHandoffDialogOpen}
        worktreeName={worktreeHandoffName}
        busy={handoffBusy}
        onWorktreeNameChange={setWorktreeHandoffName}
        onOpenChange={setWorktreeHandoffDialogOpen}
        onConfirm={confirmWorktreeHandoff}
      />
      {isInactiveSplitPane ? null : (
        <TranscriptSelectionActionLayer
          action={pendingTranscriptSelectionAction}
          onHighlight={createHighlightFromPendingSelection}
          onUnderline={createUnderlineFromPendingSelection}
          onAddToChat={commitTranscriptAssistantSelection}
        />
      )}
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
    </div>
  );
}
