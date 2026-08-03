// FILE: types.ts
// Purpose: Shared web-app view models for threads, projects, terminal layout, and sidebar rows.
// Exports: Runtime UI types consumed across store, routes, and components.

import type {
  ModelSelection,
  MessageDispatchOrigin,
  OrchestrationMessageSource,
  OrchestrationPendingInteraction,
  TurnDispatchMode,
  OrchestrationLatestTurn,
  OrchestrationThreadPullRequest,
  OrchestrationProposedPlanId,
  PinnedMessage,
  ThreadMarker,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ThreadHandoff,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ProjectId,
  SpaceId,
  SpaceIconName,
  TurnId,
  MessageId,
  ProviderMentionReference,
  ProviderSkillReference,
  ProviderKind,
  CheckpointRef,
  ProviderInteractionMode,
  ProjectKind,
  RuntimeMode,
  ThreadCreationSource,
  ThreadEnvironmentMode,
} from "@synara/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 6;
export type ThreadTerminalPresentationMode = "drawer" | "workspace";
export type ThreadTerminalWorkspaceTab = "terminal" | "chat";
export type ThreadTerminalWorkspaceLayout = "both" | "terminal-only";
export type ThreadPrimarySurface = "chat" | "terminal";
export type ProjectScript = ContractProjectScript;

export type ThreadTerminalSplitDirection = "horizontal" | "vertical";
export type ThreadTerminalSplitPosition = "top" | "right" | "bottom" | "left";

export interface ThreadTerminalLeafNode {
  type: "terminal";
  paneId: string;
  terminalIds: string[];
  activeTerminalId: string;
}

export interface ThreadTerminalSplitNode {
  type: "split";
  id: string;
  direction: ThreadTerminalSplitDirection;
  children: ThreadTerminalLayoutNode[];
  weights: number[];
}

export type ThreadTerminalLayoutNode = ThreadTerminalLeafNode | ThreadTerminalSplitNode;

export interface ThreadTerminalGroup {
  id: string;
  activeTerminalId: string;
  layout: ThreadTerminalLayoutNode;
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export interface ChatFileAttachment {
  type: "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ChatAssistantSelectionAttachment {
  type: "assistant-selection";
  id: string;
  assistantMessageId: string;
  text: string;
}

export type ChatAttachment =
  | ChatImageAttachment
  | ChatFileAttachment
  | ChatAssistantSelectionAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  skills?: ProviderSkillReference[];
  mentions?: ProviderMentionReference[];
  dispatchMode?: TurnDispatchMode;
  dispatchOrigin?: MessageDispatchOrigin;
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
  source?: OrchestrationMessageSource;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
  checkpointTurnCounts?: number[] | undefined;
}

// Ephemeral client-side progress of the "New worktree" first-send setup
// sequence (create worktree → link thread → start session). Rendered as a
// transient transcript row; never persisted.
export type WorktreeSetupStepId =
  | "create-worktree"
  | "prepare-thread"
  | "run-setup-action"
  | "start-session";
export type WorktreeSetupStepStatus = "pending" | "active" | "done" | "error";

export interface WorktreeSetupStep {
  id: WorktreeSetupStepId;
  label: string;
  status: WorktreeSetupStepStatus;
}

export interface WorktreeSetupSnapshot {
  steps: WorktreeSetupStep[];
}

export interface Project {
  id: ProjectId;
  kind: ProjectKind;
  name: string;
  remoteName: string;
  folderName: string;
  localName: string | null;
  cwd: string;
  defaultModelSelection: ModelSelection | null;
  expanded: boolean;
  isPinned?: boolean;
  /** Missing on renderer state written before Spaces; normalized snapshots always set it. */
  spaceId?: SpaceId | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface Space {
  id: SpaceId;
  name: string;
  icon: SpaceIconName;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadWorkspaceState {
  envMode?: ThreadEnvironmentMode | undefined;
  branch: string | null;
  worktreePath: string | null;
  workingDirectory?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  createBranchFlowCompleted?: boolean;
}

export interface ThreadWorkspacePatch {
  envMode?: ThreadEnvironmentMode | undefined;
  branch?: string | null;
  worktreePath?: string | null;
  workingDirectory?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  createBranchFlowCompleted?: boolean;
}

export interface Thread extends ThreadWorkspaceState {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  updatedAt?: string | undefined;
  isPinned?: boolean;
  pinnedMessages?: PinnedMessage[];
  threadMarkers?: ThreadMarker[];
  notes?: string;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  lastVisitedAt?: string | undefined;
  parentThreadId?: ThreadId | null;
  creationSource?: ThreadCreationSource | null;
  sourceThreadId?: ThreadId | null;
  subagentAgentId?: string | null;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  forkSourceThreadId?: ThreadId | null;
  sidechatSourceThreadId?: ThreadId | null;
  handoff?: ThreadHandoff | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
  pendingInteractions?: OrchestrationPendingInteraction[];
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface ThreadShell extends ThreadWorkspaceState {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  error: string | null;
  createdAt: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  updatedAt?: string | undefined;
  isPinned?: boolean;
  // Per-thread workspace annotations carried through the normalized projection so
  // `getThreadFromState` reconstructs them (the shell is the source of truth for a Thread).
  // These do not arrive on the sidebar shell snapshot, so the snapshot path preserves them
  // from the previous shell rather than clobbering with `undefined`.
  pinnedMessages?: PinnedMessage[];
  threadMarkers?: ThreadMarker[];
  notes?: string;
  parentThreadId?: ThreadId | null;
  creationSource?: ThreadCreationSource | null;
  sourceThreadId?: ThreadId | null;
  subagentAgentId?: string | null;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  forkSourceThreadId?: ThreadId | null;
  sidechatSourceThreadId?: ThreadId | null;
  handoff?: ThreadHandoff | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
  pendingInteractions?: OrchestrationPendingInteraction[];
  lastVisitedAt?: string | undefined;
}

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  interactionMode: ProviderInteractionMode;
  envMode?: ThreadEnvironmentMode | undefined;
  branch: string | null;
  worktreePath: string | null;
  workingDirectory?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  updatedAt?: string | undefined;
  isPinned?: boolean;
  latestTurn: OrchestrationLatestTurn | null;
  lastVisitedAt?: string | undefined;
  parentThreadId?: ThreadId | null;
  subagentAgentId?: string | null;
  subagentNickname?: string | null;
  subagentRole?: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  hasLiveTailWork: boolean;
  forkSourceThreadId?: ThreadId | null;
  sidechatSourceThreadId?: ThreadId | null;
  handoff?: ThreadHandoff | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
}

/** Lightweight composer identity that ignores live turn/status churn. */
export interface ComposerThreadMentionSource {
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  provider: ProviderKind;
  createdAt: string;
  archivedAt?: string | null;
  lastVisitedAt?: string | undefined;
  latestUserMessageAt: string | null;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
