// FILE: storeNormalization.ts
// Purpose: Normalizes orchestration projects, threads, messages, and activities with stable identity.
// Exports: Pure normalization and equality helpers consumed by projection and event reduction.

import {
  MessageId,
  type OrchestrationReadModel,
  type OrchestrationSpaceShell,
  type OrchestrationSessionStatus,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadActivity,
  type ProviderKind,
  ThreadId,
  type TurnId,
} from "@synara/contracts";
import { resolveThreadBranchRegressionGuard } from "@synara/shared/git";
import { normalizeModelSlug } from "@synara/shared/model";
import { deriveThreadSummaryMetadata } from "@synara/shared/threadSummary";

import { isStalePendingRequestFailureDetail } from "./lib/pendingInteraction";
import { toAttachmentPreviewUrl } from "./lib/wsHttpUrl";
import { hasLiveTurnTailWork } from "./session-logic";
import { getRememberedProjectUiState, projectCwdKey } from "./storePersistence";
import type {
  ChatAttachment,
  ChatMessage,
  Project,
  Space,
  SidebarThreadSummary,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
} from "./types";

type ReadModelProject = OrchestrationReadModel["projects"][number];
type ReadModelSpace = OrchestrationReadModel["spaces"][number];
type ReadModelThread = OrchestrationReadModel["threads"][number];
type ReadModelMessage = ReadModelThread["messages"][number];
type ShellSnapshotThread = OrchestrationShellSnapshot["threads"][number];
export type ProjectNormalizationInput = Pick<
  ReadModelProject,
  | "id"
  | "kind"
  | "title"
  | "workspaceRoot"
  | "defaultModelSelection"
  | "scripts"
  | "isPinned"
  | "spaceId"
  | "createdAt"
  | "updatedAt"
>;

export const MAX_THREAD_MESSAGES = 2_000;
// Matches the server-side activity retention budget: a smaller client cap would
// silently drop work the server still serves in its snapshots.
const MAX_THREAD_ACTIVITIES = 2_000;
const LOCAL_USER_MESSAGE_RETENTION_MS = 10_000;
const PENDING_INTERACTION_REQUEST_KINDS = new Set(["approval.requested", "user-input.requested"]);

function basenameOfPath(value: string): string | null {
  const segments = value.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

function sourceProposedPlansEqual(
  left: Thread["pendingSourceProposedPlan"],
  right: Thread["pendingSourceProposedPlan"],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.threadId === right.threadId && left.planId === right.planId;
}

function latestTurnsEqual(left: Thread["latestTurn"], right: Thread["latestTurn"]): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.requestedAt === right.requestedAt &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.assistantMessageId === right.assistantMessageId &&
    sourceProposedPlansEqual(left.sourceProposedPlan, right.sourceProposedPlan)
  );
}

export function threadSessionsEqual(
  left: ThreadSession | null | undefined,
  right: ThreadSession | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.provider === right.provider &&
    left.status === right.status &&
    left.orchestrationStatus === right.orchestrationStatus &&
    left.activeTurnId === right.activeTurnId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastError === right.lastError
  );
}

export function resolveCreateBranchFlowCompletedMerge(input: {
  currentBranch: string | null;
  nextBranch: string | null;
  currentWorktreePath: string | null;
  nextWorktreePath: string | null;
  currentAssociatedWorktreePath: string | null | undefined;
  nextAssociatedWorktreePath: string | null | undefined;
  currentAssociatedWorktreeBranch: string | null | undefined;
  nextAssociatedWorktreeBranch: string | null | undefined;
  currentAssociatedWorktreeRef: string | null | undefined;
  nextAssociatedWorktreeRef: string | null | undefined;
  currentCreateBranchFlowCompleted: boolean | undefined;
  nextCreateBranchFlowCompleted: boolean | undefined;
}): boolean {
  const contextChanged =
    input.currentBranch !== input.nextBranch ||
    input.currentWorktreePath !== input.nextWorktreePath ||
    (input.currentAssociatedWorktreePath ?? null) !== (input.nextAssociatedWorktreePath ?? null) ||
    (input.currentAssociatedWorktreeBranch ?? null) !==
      (input.nextAssociatedWorktreeBranch ?? null) ||
    (input.currentAssociatedWorktreeRef ?? null) !== (input.nextAssociatedWorktreeRef ?? null);

  if (contextChanged) {
    return input.nextCreateBranchFlowCompleted ?? false;
  }

  if (input.nextCreateBranchFlowCompleted === undefined) {
    return input.currentCreateBranchFlowCompleted ?? false;
  }

  if ((input.currentCreateBranchFlowCompleted ?? false) && !input.nextCreateBranchFlowCompleted) {
    return true;
  }

  return input.nextCreateBranchFlowCompleted;
}

export function threadShellsEqual(left: ThreadShell | undefined, right: ThreadShell): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.codexThreadId === right.codexThreadId &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    (left.archivedAt ?? null) === (right.archivedAt ?? null) &&
    (left.settledAt ?? null) === (right.settledAt ?? null) &&
    left.updatedAt === right.updatedAt &&
    (left.isPinned ?? false) === (right.isPinned ?? false) &&
    left.envMode === right.envMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    (left.workingDirectory ?? null) === (right.workingDirectory ?? null) &&
    (left.associatedWorktreePath ?? null) === (right.associatedWorktreePath ?? null) &&
    (left.associatedWorktreeBranch ?? null) === (right.associatedWorktreeBranch ?? null) &&
    (left.associatedWorktreeRef ?? null) === (right.associatedWorktreeRef ?? null) &&
    (left.createBranchFlowCompleted ?? false) === (right.createBranchFlowCompleted ?? false) &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.creationSource ?? null) === (right.creationSource ?? null) &&
    (left.sourceThreadId ?? null) === (right.sourceThreadId ?? null) &&
    (left.subagentAgentId ?? null) === (right.subagentAgentId ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    (left.forkSourceThreadId ?? null) === (right.forkSourceThreadId ?? null) &&
    (left.sidechatSourceThreadId ?? null) === (right.sidechatSourceThreadId ?? null) &&
    deepEqualJson(left.lastKnownPr ?? null, right.lastKnownPr ?? null) &&
    (left.handoff ?? null) === (right.handoff ?? null) &&
    deepEqualJson(left.pinnedMessages ?? null, right.pinnedMessages ?? null) &&
    deepEqualJson(left.threadMarkers ?? null, right.threadMarkers ?? null) &&
    (left.notes ?? "") === (right.notes ?? "") &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    left.pendingInteractions === right.pendingInteractions &&
    left.lastVisitedAt === right.lastVisitedAt
  );
}

export function threadTurnStatesEqual(
  left: ThreadTurnState | undefined,
  right: ThreadTurnState,
): boolean {
  return (
    left !== undefined &&
    latestTurnsEqual(left.latestTurn, right.latestTurn) &&
    sourceProposedPlansEqual(left.pendingSourceProposedPlan, right.pendingSourceProposedPlan)
  );
}

export function arraysShallowEqual<T>(
  left: ReadonlyArray<T> | undefined,
  right: ReadonlyArray<T>,
): left is ReadonlyArray<T> {
  if (!left || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function providerReferenceArraysEqual(
  left:
    | ReadonlyArray<Pick<NonNullable<ChatMessage["mentions"]>[number], "name" | "path">>
    | undefined,
  right:
    | ReadonlyArray<Pick<NonNullable<ChatMessage["mentions"]>[number], "name" | "path">>
    | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftReference = left[index];
    const rightReference = right[index];
    if (
      leftReference?.name !== rightReference?.name ||
      leftReference?.path !== rightReference?.path
    ) {
      return false;
    }
  }
  return true;
}

export function recordsShallowEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in right) || left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left == null || right == null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualJson(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in rightRecord) || !deepEqualJson(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

export function normalizeModelSelection<T extends { provider: ProviderKind; model: string }>(
  value: T,
  previous: T | null | undefined,
): T {
  const normalizedModel = normalizeModelSlug(value.model, value.provider) ?? value.model;
  const next = normalizedModel === value.model ? value : { ...value, model: normalizedModel };
  return previous && deepEqualJson(previous, next) ? previous : next;
}

function normalizeProjectScripts(
  incoming: ReadModelProject["scripts"],
  previous: Project["scripts"] | undefined,
): Project["scripts"] {
  const nextScripts = incoming.map((script, index) => {
    const existing = previous?.[index];
    return existing && deepEqualJson(existing, script) ? existing : script;
  });
  return arraysShallowEqual(previous, nextScripts) ? previous : nextScripts;
}

export function normalizeProject(
  incoming: ProjectNormalizationInput,
  previous: Project | undefined,
): Project {
  const rememberedUiState = getRememberedProjectUiState();
  const workspaceRootKey = projectCwdKey(incoming.workspaceRoot);
  const folderName = basenameOfPath(incoming.workspaceRoot) ?? incoming.title;
  const localName =
    previous?.localName ?? rememberedUiState.projectNameForCwd(workspaceRootKey) ?? null;
  const defaultModelSelection =
    incoming.defaultModelSelection === null
      ? null
      : normalizeModelSelection(incoming.defaultModelSelection, previous?.defaultModelSelection);
  const scripts = normalizeProjectScripts(incoming.scripts, previous?.scripts);
  const expanded =
    previous?.expanded ??
    (rememberedUiState.expandedProjectCount > 0
      ? rememberedUiState.isProjectExpanded(workspaceRootKey)
      : true);

  if (
    previous &&
    previous.id === incoming.id &&
    previous.kind === incoming.kind &&
    previous.name === (localName ?? incoming.title) &&
    previous.remoteName === incoming.title &&
    previous.folderName === folderName &&
    previous.localName === localName &&
    previous.cwd === incoming.workspaceRoot &&
    previous.defaultModelSelection === defaultModelSelection &&
    previous.expanded === expanded &&
    (previous.isPinned ?? false) === (incoming.isPinned ?? false) &&
    (previous.spaceId ?? null) === (incoming.spaceId ?? null) &&
    previous.createdAt === incoming.createdAt &&
    previous.updatedAt === incoming.updatedAt &&
    previous.scripts === scripts
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    kind: incoming.kind ?? "project",
    name: localName ?? incoming.title,
    remoteName: incoming.title,
    folderName,
    localName,
    cwd: incoming.workspaceRoot,
    defaultModelSelection,
    expanded,
    isPinned: incoming.isPinned ?? false,
    spaceId: incoming.spaceId ?? null,
    createdAt: incoming.createdAt,
    updatedAt: incoming.updatedAt,
    scripts,
  } satisfies Project;
}

export function normalizeSpace(
  incoming: ReadModelSpace | OrchestrationSpaceShell,
  previous: Space | undefined,
): Space {
  if (
    previous &&
    previous.id === incoming.id &&
    previous.name === incoming.name &&
    previous.icon === incoming.icon &&
    previous.sortOrder === incoming.sortOrder &&
    previous.createdAt === incoming.createdAt &&
    previous.updatedAt === incoming.updatedAt
  ) {
    return previous;
  }
  return {
    id: incoming.id,
    name: incoming.name,
    icon: incoming.icon,
    sortOrder: incoming.sortOrder,
    createdAt: incoming.createdAt,
    updatedAt: incoming.updatedAt,
  };
}

export function mapSpaces(
  incoming: ReadonlyArray<ReadModelSpace | OrchestrationSpaceShell>,
  previous: Space[],
): Space[] {
  const previousById = new Map(previous.map((space) => [space.id, space] as const));
  const next = incoming
    .map((space) => normalizeSpace(space, previousById.get(space.id)))
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  return arraysShallowEqual(previous, next) ? previous : next;
}

function normalizeChatAttachments(
  incoming: ReadModelMessage["attachments"],
  previous: ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  if (!incoming || incoming.length === 0) {
    return undefined;
  }

  const previousById = new Map(previous?.map((attachment) => [attachment.id, attachment] as const));
  const nextAttachments = incoming.map((attachment) => {
    const nextAttachment: ChatAttachment =
      attachment.type === "assistant-selection"
        ? {
            type: "assistant-selection",
            id: attachment.id,
            assistantMessageId: attachment.assistantMessageId,
            text: attachment.text,
          }
        : attachment.type === "file"
          ? {
              type: "file",
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            }
          : {
              type: "image",
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
            };
    const existing = previousById.get(attachment.id);
    if (
      existing &&
      ((existing.type === "assistant-selection" &&
        nextAttachment.type === "assistant-selection" &&
        existing.assistantMessageId === nextAttachment.assistantMessageId &&
        existing.text === nextAttachment.text) ||
        (existing.type === "image" &&
          nextAttachment.type === "image" &&
          existing.name === nextAttachment.name &&
          existing.mimeType === nextAttachment.mimeType &&
          existing.sizeBytes === nextAttachment.sizeBytes &&
          existing.previewUrl === nextAttachment.previewUrl) ||
        (existing.type === "file" &&
          nextAttachment.type === "file" &&
          existing.name === nextAttachment.name &&
          existing.mimeType === nextAttachment.mimeType &&
          existing.sizeBytes === nextAttachment.sizeBytes))
    ) {
      return existing;
    }
    return nextAttachment;
  });

  return arraysShallowEqual(previous, nextAttachments) ? previous : nextAttachments;
}

export function normalizeChatMessage(
  incoming: ReadModelMessage,
  previous: ChatMessage | undefined,
): ChatMessage {
  const attachments = normalizeChatAttachments(incoming.attachments, previous?.attachments);
  // Partial live updates omit skills/mentions; keep the previous arrays so optimistic
  // rows don't lose plugin metadata before thread.message-sent arrives. If message edit
  // can remove @mentions, treat explicit incoming.skills/mentions === [] as a clear.
  const skills =
    incoming.skills && incoming.skills.length > 0 ? incoming.skills : (previous?.skills ?? []);
  const mentions =
    incoming.mentions && incoming.mentions.length > 0
      ? incoming.mentions
      : (previous?.mentions ?? []);
  const previousSkills = previous?.skills ?? [];
  const previousMentions = previous?.mentions ?? [];
  const completedAt = incoming.streaming ? undefined : incoming.updatedAt;
  if (
    previous &&
    previous.role === incoming.role &&
    previous.text === incoming.text &&
    previous.dispatchMode === incoming.dispatchMode &&
    previous.dispatchOrigin === incoming.dispatchOrigin &&
    previous.turnId === incoming.turnId &&
    previous.createdAt === incoming.createdAt &&
    previous.streaming === incoming.streaming &&
    previous.source === incoming.source &&
    previous.completedAt === completedAt &&
    previous.attachments === attachments &&
    providerReferenceArraysEqual(previousSkills, skills) &&
    providerReferenceArraysEqual(previousMentions, mentions)
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    role: incoming.role,
    text: incoming.text,
    ...(incoming.dispatchMode ? { dispatchMode: incoming.dispatchMode } : {}),
    ...(incoming.dispatchOrigin ? { dispatchOrigin: incoming.dispatchOrigin } : {}),
    turnId: incoming.turnId,
    createdAt: incoming.createdAt,
    streaming: incoming.streaming,
    source: incoming.source,
    ...(completedAt ? { completedAt } : {}),
    ...(attachments ? { attachments } : {}),
    ...(skills.length > 0 ? { skills: [...skills] } : {}),
    ...(mentions.length > 0 ? { mentions: [...mentions] } : {}),
  };
}
function normalizeChatMessages(
  incoming: ReadModelThread["messages"],
  previous: ChatMessage[] | undefined,
): ChatMessage[] {
  const previousById = new Map(previous?.map((message) => [message.id, message] as const));
  const nextMessages = incoming
    .slice(-MAX_THREAD_MESSAGES)
    .map((message) => normalizeChatMessage(message, previousById.get(message.id)));
  return arraysShallowEqual(previous, nextMessages) ? previous : nextMessages;
}

function readModelAttachmentsFromChatMessage(
  attachments: ChatMessage["attachments"],
): ReadModelThread["messages"][number]["attachments"] {
  return (
    attachments?.map((attachment) =>
      attachment.type === "assistant-selection"
        ? {
            id: attachment.id,
            type: "assistant-selection" as const,
            assistantMessageId: MessageId.makeUnsafe(attachment.assistantMessageId),
            text: attachment.text,
          }
        : attachment.type === "file"
          ? {
              id: attachment.id,
              name: attachment.name,
              type: "file" as const,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            }
          : {
              id: attachment.id,
              name: attachment.name,
              type: "image" as const,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
    ) ?? []
  );
}

function readModelMessageFromChatMessage(
  message: ChatMessage,
): ReadModelThread["messages"][number] {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.dispatchMode ? { dispatchMode: message.dispatchMode } : {}),
    ...(message.dispatchOrigin ? { dispatchOrigin: message.dispatchOrigin } : {}),
    turnId: message.turnId ?? null,
    streaming: message.streaming,
    source: message.source ?? "native",
    createdAt: message.createdAt,
    updatedAt: message.completedAt ?? message.createdAt,
    attachments: readModelAttachmentsFromChatMessage(message.attachments),
    ...(message.skills && message.skills.length > 0 ? { skills: message.skills } : {}),
    ...(message.mentions && message.mentions.length > 0 ? { mentions: message.mentions } : {}),
  };
}

function shouldRetainLiveAssistantMessageForHotPath(
  previousThread: Thread,
  message: ChatMessage,
): boolean {
  if (message.streaming) {
    return true;
  }
  const latestTurn = previousThread.latestTurn;
  if (!latestTurn) {
    return false;
  }
  if (latestTurn.assistantMessageId === message.id) {
    return true;
  }
  return (
    previousThread.session?.orchestrationStatus === "running" &&
    message.turnId !== undefined &&
    latestTurn.turnId === message.turnId
  );
}

/**
 * A locally dispatched user message has no server twin until the dispatch is
 * projected, so a snapshot generated before that projection legitimately lacks
 * it. Retaining it for a short window keeps what the user just sent on screen,
 * while still letting a deliberate server-side removal (checkpoint rewind) win
 * once the window closes.
 */
function shouldRetainLiveUserMessageForHotPath(
  previousThread: Thread,
  message: ChatMessage,
): boolean {
  const latestTurn = previousThread.latestTurn;
  if (latestTurn && message.turnId != null && message.turnId === latestTurn.turnId) {
    return (
      latestTurn.state === "running" || previousThread.session?.orchestrationStatus === "running"
    );
  }
  const createdAtMs = Date.parse(message.createdAt);
  return (
    Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= LOCAL_USER_MESSAGE_RETENTION_MS
  );
}

function shouldRetainLiveMessageForHotPath(previousThread: Thread, message: ChatMessage): boolean {
  switch (message.role) {
    case "assistant":
      return shouldRetainLiveAssistantMessageForHotPath(previousThread, message);
    case "user":
      return shouldRetainLiveUserMessageForHotPath(previousThread, message);
    default:
      return false;
  }
}

function mergeReadModelMessagesWithLiveHotPath(
  incomingMessages: ReadModelThread["messages"],
  previousThread: Thread | undefined,
  options?: {
    // Turn the snapshot has just settled: its message contents are final, so the
    // "local row looks richer" heuristics must not resurrect mid-stream text.
    readonly authoritativeTurnId?: TurnId | null;
  },
): ReadModelThread["messages"] {
  if (!previousThread || previousThread.messages.length === 0) {
    return incomingMessages;
  }
  const authoritativeTurnId = options?.authoritativeTurnId ?? null;

  const previousMessageById = new Map(
    previousThread.messages.map((message) => [message.id, message] as const),
  );
  const mergedById = new Map<MessageId, ReadModelThread["messages"][number]>();
  let changed = false;

  for (const incomingMessage of incomingMessages) {
    const previousMessage = previousMessageById.get(incomingMessage.id);
    if (!previousMessage || previousMessage.role !== incomingMessage.role) {
      mergedById.set(incomingMessage.id, incomingMessage);
      continue;
    }

    const incomingCompletedAt = incomingMessage.streaming ? undefined : incomingMessage.updatedAt;
    const shouldPreferLiveMessage =
      (authoritativeTurnId === null || incomingMessage.turnId !== authoritativeTurnId) &&
      (previousMessage.text.length > incomingMessage.text.length ||
        (!previousMessage.streaming && incomingMessage.streaming) ||
        (previousMessage.completedAt !== undefined &&
          (incomingCompletedAt === undefined ||
            previousMessage.completedAt > incomingCompletedAt)));

    if (!shouldPreferLiveMessage) {
      mergedById.set(incomingMessage.id, {
        ...incomingMessage,
        ...(!incomingMessage.mentions || incomingMessage.mentions.length === 0
          ? previousMessage.mentions && previousMessage.mentions.length > 0
            ? { mentions: previousMessage.mentions }
            : {}
          : {}),
        ...(!incomingMessage.skills || incomingMessage.skills.length === 0
          ? previousMessage.skills && previousMessage.skills.length > 0
            ? { skills: previousMessage.skills }
            : {}
          : {}),
      });
      continue;
    }

    changed = true;
    mergedById.set(incomingMessage.id, {
      ...incomingMessage,
      text: previousMessage.text,
      dispatchMode: previousMessage.dispatchMode ?? incomingMessage.dispatchMode,
      dispatchOrigin: incomingMessage.dispatchOrigin ?? previousMessage.dispatchOrigin,
      turnId: previousMessage.turnId ?? incomingMessage.turnId ?? null,
      source: previousMessage.source ?? incomingMessage.source ?? "native",
      streaming: previousMessage.streaming,
      updatedAt: previousMessage.completedAt ?? incomingMessage.updatedAt,
      attachments: readModelAttachmentsFromChatMessage(previousMessage.attachments),
      ...(previousMessage.skills && previousMessage.skills.length > 0
        ? { skills: previousMessage.skills }
        : {}),
      ...(previousMessage.mentions && previousMessage.mentions.length > 0
        ? { mentions: previousMessage.mentions }
        : {}),
    });
  }

  for (const previousMessage of previousThread.messages) {
    if (mergedById.has(previousMessage.id)) {
      continue;
    }
    if (!shouldRetainLiveMessageForHotPath(previousThread, previousMessage)) {
      continue;
    }
    changed = true;
    mergedById.set(previousMessage.id, readModelMessageFromChatMessage(previousMessage));
  }

  if (!changed) {
    return incomingMessages;
  }

  // `toSorted` is stable, so equal `createdAt` values keep insertion order
  // (incoming order first, then retained local rows). Tie-breaking on the random
  // message id instead would reshuffle same-millisecond rows on every merge.
  return [...mergedById.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function hasLiveAssistantIntro(previousThread: Thread | undefined): boolean {
  if (!previousThread) {
    return false;
  }
  const latestTurn = previousThread.latestTurn;
  if (!latestTurn || latestTurn.state !== "running") {
    return false;
  }
  if (previousThread.session?.orchestrationStatus !== "running") {
    return false;
  }
  return previousThread.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.turnId === latestTurn.turnId &&
      (message.streaming || message.id === latestTurn.assistantMessageId),
  );
}

function shouldPreserveRunningTurn(
  previousThread: Thread | undefined,
  incoming: ReadModelThread,
): boolean {
  if (!hasLiveAssistantIntro(previousThread)) {
    return false;
  }
  const previousTurnId = previousThread?.latestTurn?.turnId;
  if (!previousTurnId) {
    return false;
  }
  if (incoming.latestTurn?.turnId !== previousTurnId) {
    return true;
  }
  if (incoming.latestTurn.completedAt) {
    return false;
  }
  return true;
}

function readModelSessionFromThreadSession(
  previousSession: ThreadSession,
  previousThread: Thread | undefined,
  incomingSession: ReadModelThread["session"],
): NonNullable<ReadModelThread["session"]> {
  return {
    threadId: previousThread?.id ?? incomingSession?.threadId ?? ThreadId.makeUnsafe("unknown"),
    status: previousSession.orchestrationStatus,
    providerName: previousSession.provider,
    runtimeMode: previousThread?.runtimeMode ?? incomingSession?.runtimeMode ?? "full-access",
    activeTurnId: previousSession.activeTurnId ?? null,
    lastError: previousSession.lastError ?? null,
    updatedAt: previousSession.updatedAt,
  };
}

function mergeReadModelSessionWithLiveHotPath(
  incomingSession: ReadModelThread["session"],
  previousThread: Thread | undefined,
  options: {
    preserveRunningTurn: boolean;
    incomingLatestTurn: ReadModelThread["latestTurn"];
  },
): ReadModelThread["session"] {
  const previousSession = previousThread?.session;
  if (!previousSession || !options.preserveRunningTurn) {
    return incomingSession;
  }
  if (!incomingSession) {
    return previousSession.orchestrationStatus === "running"
      ? readModelSessionFromThreadSession(previousSession, previousThread, incomingSession)
      : incomingSession;
  }
  if (previousSession.updatedAt > incomingSession.updatedAt) {
    const nextSession = readModelSessionFromThreadSession(
      previousSession,
      previousThread,
      incomingSession,
    );
    return {
      ...nextSession,
      providerName: incomingSession.providerName,
      runtimeMode: incomingSession.runtimeMode,
      activeTurnId: previousSession.activeTurnId ?? incomingSession.activeTurnId,
      lastError: previousSession.lastError ?? incomingSession.lastError,
    };
  }
  // When the snapshot is strictly newer than the local session AND carries a
  // terminal latestTurn for a different turn than the one preserved locally, the
  // server has provably moved past the local turn — resurrecting "running" with
  // the stale activeTurnId would desync the session from the (adopted) settled
  // turn forever. Equal timestamps are ambiguous (a queued follow-up can start in
  // the same millisecond the prior turn settles), so they preserve the local
  // running session and let the next live event or snapshot resolve the race.
  const supersededByTerminalTurn =
    incomingSession.updatedAt > previousSession.updatedAt &&
    options.incomingLatestTurn != null &&
    options.incomingLatestTurn.completedAt != null &&
    options.incomingLatestTurn.turnId !== previousThread?.latestTurn?.turnId;
  if (
    previousSession.orchestrationStatus === "running" &&
    incomingSession.status !== "running" &&
    incomingSession.status !== "error" &&
    previousSession.activeTurnId !== undefined &&
    !supersededByTerminalTurn
  ) {
    return {
      ...incomingSession,
      status: "running",
      activeTurnId: previousSession.activeTurnId,
      lastError: previousSession.lastError ?? incomingSession.lastError,
      updatedAt:
        previousSession.updatedAt >= incomingSession.updatedAt
          ? previousSession.updatedAt
          : incomingSession.updatedAt,
    };
  }
  return incomingSession;
}

function mergeReadModelLatestTurnWithLiveHotPath(
  incomingLatestTurn: ReadModelThread["latestTurn"],
  previousThread: Thread | undefined,
  options: {
    preserveRunningTurn: boolean;
  },
): ReadModelThread["latestTurn"] {
  const previousLatestTurn = previousThread?.latestTurn;
  if (!previousLatestTurn) {
    return incomingLatestTurn;
  }
  if (options.preserveRunningTurn) {
    if (incomingLatestTurn === null || incomingLatestTurn.turnId === previousLatestTurn.turnId) {
      return {
        ...(incomingLatestTurn ?? previousLatestTurn),
        turnId: previousLatestTurn.turnId,
        state: "running",
        requestedAt: incomingLatestTurn?.requestedAt ?? previousLatestTurn.requestedAt,
        startedAt: incomingLatestTurn?.startedAt ?? previousLatestTurn.startedAt,
        completedAt: null,
        assistantMessageId:
          previousLatestTurn.assistantMessageId ?? incomingLatestTurn?.assistantMessageId ?? null,
        ...((incomingLatestTurn?.sourceProposedPlan ?? previousLatestTurn.sourceProposedPlan)
          ? {
              sourceProposedPlan:
                incomingLatestTurn?.sourceProposedPlan ?? previousLatestTurn.sourceProposedPlan,
            }
          : {}),
      };
    }
    return incomingLatestTurn;
  }
  if (incomingLatestTurn === null || incomingLatestTurn.turnId !== previousLatestTurn.turnId) {
    return incomingLatestTurn;
  }
  if (
    previousLatestTurn.assistantMessageId === undefined ||
    incomingLatestTurn.assistantMessageId === previousLatestTurn.assistantMessageId
  ) {
    return incomingLatestTurn;
  }
  return {
    ...incomingLatestTurn,
    assistantMessageId: previousLatestTurn.assistantMessageId,
  };
}

function clearSettledTurnStreamingFlags(
  messages: ReadModelThread["messages"],
  settledTurnId: TurnId,
): ReadModelThread["messages"] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!message.streaming || message.turnId !== settledTurnId) {
      return message;
    }
    changed = true;
    return { ...message, streaming: false };
  });
  return changed ? nextMessages : messages;
}

export function mergeReadModelThreadDetailWithLiveHotPath(
  incoming: ReadModelThread,
  previousThread: Thread | undefined,
): ReadModelThread {
  if (!previousThread) {
    return incoming;
  }

  // A scoped projection refresh is authoritative for a *terminal transition*: the
  // turn it settles must not keep local streaming flags or a resurrected running
  // session alive. It is not authoritative for message contents, so the normal
  // merge still runs — skipping it drops locally streamed assistant text and
  // locally preserved mentions/skills/attachments the snapshot has not caught up
  // with yet.
  const settledLocalTurnId =
    previousThread.latestTurn?.state === "running" &&
    incoming.latestTurn !== null &&
    incoming.latestTurn.turnId === previousThread.latestTurn.turnId &&
    incoming.latestTurn.state !== "running" &&
    incoming.latestTurn.completedAt !== null
      ? incoming.latestTurn.turnId
      : null;

  const preserveRunningTurn =
    settledLocalTurnId === null && shouldPreserveRunningTurn(previousThread, incoming);
  const mergedMessages = mergeReadModelMessagesWithLiveHotPath(incoming.messages, previousThread, {
    authoritativeTurnId: settledLocalTurnId,
  });
  const messages =
    settledLocalTurnId === null
      ? mergedMessages
      : clearSettledTurnStreamingFlags(mergedMessages, settledLocalTurnId);
  const session = mergeReadModelSessionWithLiveHotPath(incoming.session, previousThread, {
    preserveRunningTurn,
    incomingLatestTurn: incoming.latestTurn,
  });
  const latestTurn = mergeReadModelLatestTurnWithLiveHotPath(incoming.latestTurn, previousThread, {
    preserveRunningTurn,
  });
  if (
    messages === incoming.messages &&
    session === incoming.session &&
    latestTurn === incoming.latestTurn
  ) {
    return incoming;
  }
  return {
    ...incoming,
    messages,
    session,
    latestTurn,
  };
}

export function normalizeProposedPlans(
  incoming: ReadModelThread["proposedPlans"],
  previous: Thread["proposedPlans"] | undefined,
): Thread["proposedPlans"] {
  const previousById = new Map(previous?.map((plan) => [plan.id, plan] as const));
  const nextPlans = incoming.map((plan) => {
    const existing = previousById.get(plan.id);
    if (
      existing &&
      existing.turnId === plan.turnId &&
      existing.planMarkdown === plan.planMarkdown &&
      existing.implementedAt === plan.implementedAt &&
      existing.implementationThreadId === plan.implementationThreadId &&
      existing.createdAt === plan.createdAt &&
      existing.updatedAt === plan.updatedAt
    ) {
      return existing;
    }
    return {
      id: plan.id,
      turnId: plan.turnId,
      planMarkdown: plan.planMarkdown,
      implementedAt: plan.implementedAt,
      implementationThreadId: plan.implementationThreadId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  });
  return arraysShallowEqual(previous, nextPlans) ? previous : nextPlans;
}

export function normalizeTurnDiffFiles(
  incoming: ReadonlyArray<Thread["turnDiffSummaries"][number]["files"][number]>,
  previous: Thread["turnDiffSummaries"][number]["files"] | undefined,
): Thread["turnDiffSummaries"][number]["files"] {
  const mergedIncoming = mergeTurnDiffFilesByPath(incoming);
  const nextFiles = mergedIncoming.map((file, index) => {
    const existing = previous?.[index];
    if (
      existing &&
      existing.path === file.path &&
      existing.kind === file.kind &&
      existing.additions === file.additions &&
      existing.deletions === file.deletions
    ) {
      return existing;
    }
    return file;
  });
  return arraysShallowEqual(previous, nextFiles) ? previous : nextFiles;
}

function mergeTurnDiffFilesByPath(
  files: ReadonlyArray<Thread["turnDiffSummaries"][number]["files"][number]>,
): Thread["turnDiffSummaries"][number]["files"] {
  const filesByPath = new Map<string, Thread["turnDiffSummaries"][number]["files"][number]>();
  for (const file of files) {
    const existing = filesByPath.get(file.path);
    if (!existing) {
      filesByPath.set(file.path, file);
      continue;
    }
    filesByPath.set(file.path, {
      path: file.path,
      kind: existing.kind,
      additions: (existing.additions ?? 0) + (file.additions ?? 0),
      deletions: (existing.deletions ?? 0) + (file.deletions ?? 0),
    });
  }
  return Array.from(filesByPath.values());
}

function normalizeTurnDiffSummaries(
  incoming: ReadModelThread["checkpoints"],
  previous: Thread["turnDiffSummaries"] | undefined,
): Thread["turnDiffSummaries"] {
  const previousByTurnId = new Map(previous?.map((summary) => [summary.turnId, summary] as const));
  const nextSummaries = incoming.map((checkpoint) => {
    const existing = previousByTurnId.get(checkpoint.turnId);
    const files = normalizeTurnDiffFiles(checkpoint.files, existing?.files);
    if (
      existing &&
      existing.completedAt === checkpoint.completedAt &&
      existing.status === checkpoint.status &&
      existing.assistantMessageId === (checkpoint.assistantMessageId ?? undefined) &&
      existing.checkpointTurnCount === checkpoint.checkpointTurnCount &&
      existing.checkpointRef === checkpoint.checkpointRef &&
      existing.files === files
    ) {
      return existing;
    }
    return {
      turnId: checkpoint.turnId,
      completedAt: checkpoint.completedAt,
      status: checkpoint.status,
      assistantMessageId: checkpoint.assistantMessageId ?? undefined,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      checkpointRef: checkpoint.checkpointRef,
      files,
    };
  });
  return arraysShallowEqual(previous, nextSummaries) ? previous : nextSummaries;
}

export function normalizeActivities(
  incoming: ReadModelThread["activities"],
  previous: Thread["activities"] | undefined,
): Thread["activities"] {
  const previousActivities = previous ? dedupeActivitiesById(previous) : undefined;
  const incomingActivities = dedupeActivitiesById(incoming);
  const previousById = new Map(
    previousActivities?.map((activity) => [activity.id, activity] as const),
  );
  const nextActivities = incomingActivities.map((activity) => {
    const existing = previousById.get(activity.id);
    if (existing) {
      const preferred = preferRicherActivity(existing, activity);
      if (preferred === existing || activitiesEqual(existing, preferred)) {
        return existing;
      }
      return preferred;
    }
    return activity;
  });
  const cappedActivities = capThreadActivities(nextActivities);
  return arraysShallowEqual(previous, cappedActivities) ? previous : cappedActivities;
}

type ThreadActivity = Thread["activities"][number];

/**
 * Incremental equivalent of repeatedly calling
 * `normalizeActivities([...previous, activity], previous)` while folding a batch of
 * `thread.activity-appended` events into one thread write.
 *
 * `normalizeActivities` re-dedupes, re-maps and re-caps the whole list for every activity, which
 * is O(events x activities) inside a batch. The accumulator keeps an id index instead, so each
 * append is O(1) amortised while staying observationally identical:
 * - unseen ids append at the end, known ids merge in place via `preferRicherActivity`,
 * - the cap is applied after every append (not just once at the end), so retention of pending
 *   approval/user-input requests is decided at exactly the same points,
 * - `result()` returns `previous` by reference when the batch changed nothing, and `append()`
 *   reports per-activity change so callers can reproduce the old `updatedAt` bumping rule.
 */
export interface ThreadActivityAccumulator {
  /** Appends one already-sequenced activity. Returns true when the accumulated list changed. */
  readonly append: (activity: ThreadActivity) => boolean;
  /** Accumulated activities, reference-identical to `previous` when nothing changed. */
  readonly result: () => Thread["activities"];
}

export function createThreadActivityAccumulator(
  previous: Thread["activities"],
): ThreadActivityAccumulator {
  const deduped = dedupeActivitiesById(previous);
  // `dedupeActivitiesById` only returns a new array when it actually removed a duplicate, so a
  // different reference here means the first `append()` must report a change even if that append
  // is itself a no-op (matching `normalizeActivities`, which dedupes `previous` on every call).
  let pendingDedupeChange = deduped !== previous;
  let working: ThreadActivity[] = deduped;
  let owned = pendingDedupeChange;
  let indexById: Map<string, number> | undefined;

  const ensureIndexById = (): Map<string, number> => {
    if (!indexById) {
      const nextIndexById = new Map<string, number>();
      for (let index = 0; index < working.length; index += 1) {
        nextIndexById.set(working[index]!.id, index);
      }
      indexById = nextIndexById;
    }
    return indexById;
  };

  const ensureOwned = (): void => {
    if (!owned) {
      working = [...working];
      owned = true;
    }
  };

  return {
    append: (activity) => {
      const activityIndexById = ensureIndexById();
      const existingIndex = activityIndexById.get(activity.id);
      let changed = false;
      if (existingIndex === undefined) {
        ensureOwned();
        working.push(activity);
        activityIndexById.set(activity.id, working.length - 1);
        changed = true;
      } else {
        const existing = working[existingIndex]!;
        const preferred = preferRicherActivity(existing, activity);
        if (preferred !== existing) {
          ensureOwned();
          working[existingIndex] = preferred;
          changed = true;
        }
      }
      if (working.length > MAX_THREAD_ACTIVITIES) {
        const capped = capThreadActivities(working);
        // `capThreadActivities` only filters, so an unchanged length means unchanged contents.
        if (capped.length !== working.length) {
          working = capped;
          owned = true;
          indexById = undefined;
          changed = true;
        }
      }
      if (pendingDedupeChange) {
        pendingDedupeChange = false;
        return true;
      }
      return changed;
    },
    result: () => (arraysShallowEqual(previous, working) ? previous : working),
  };
}

export function withOrchestrationEventSequence(
  activity: OrchestrationThreadActivity,
  sequence: number,
): OrchestrationThreadActivity {
  return { ...activity, sequence };
}

/**
 * How many of the oldest activities to drop so the tail stays under the cap
 * *without* cutting a turn in half — a half-dropped turn renders as an incomplete
 * work group. Extends the minimum drop forward to the next turn boundary, unless
 * that would consume the whole array (a single turn larger than the cap), where
 * showing a partial turn beats showing nothing.
 */
function resolveTurnAlignedDropCount(
  activities: readonly Thread["activities"][number][],
  minimumDropCount: number,
): number {
  const boundaryTurnId = activities[minimumDropCount - 1]?.turnId ?? null;
  let dropCount = minimumDropCount;
  while (
    dropCount < activities.length &&
    (activities[dropCount]?.turnId ?? null) === boundaryTurnId
  ) {
    dropCount += 1;
  }
  return dropCount >= activities.length ? minimumDropCount : dropCount;
}

export function capThreadActivities<TActivity extends Thread["activities"][number]>(
  activities: readonly TActivity[],
): TActivity[] {
  if (activities.length <= MAX_THREAD_ACTIVITIES) {
    return activities as TActivity[];
  }
  const dropCount = resolveTurnAlignedDropCount(
    activities,
    activities.length - MAX_THREAD_ACTIVITIES,
  );
  const retainedIds = new Set(activities.slice(dropCount).map((activity) => activity.id));
  const pendingRequestIds = pendingInteractionRequestIds(activities);
  for (const activity of activities) {
    const requestId = activityRequestId(activity);
    if (
      requestId !== null &&
      pendingRequestIds.has(requestId) &&
      PENDING_INTERACTION_REQUEST_KINDS.has(activity.kind)
    ) {
      retainedIds.add(activity.id);
    }
  }
  return activities.filter((activity) => retainedIds.has(activity.id));
}

function activityRequestId(activity: Thread["activities"][number]): string | null {
  const payload = asActivityRecord(activity.payload);
  const requestId = payload?.requestId;
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId : null;
}

function pendingInteractionRequestIds(
  activities: readonly Thread["activities"][number][],
): Set<string> {
  const pendingRequestIds = new Set<string>();
  for (const activity of activities) {
    const requestId = activityRequestId(activity);
    if (requestId === null) {
      continue;
    }
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      pendingRequestIds.add(requestId);
      continue;
    }
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      pendingRequestIds.delete(requestId);
      continue;
    }
    if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStalePendingRequestFailureDetail(asActivityRecord(activity.payload)?.detail)
    ) {
      pendingRequestIds.delete(requestId);
    }
  }
  return pendingRequestIds;
}

export function dedupeActivitiesById<TActivity extends Thread["activities"][number]>(
  activities: ReadonlyArray<TActivity>,
): TActivity[] {
  const indexById = new Map<string, number>();
  const result: TActivity[] = [];
  for (const activity of activities) {
    const existingIndex = indexById.get(activity.id);
    if (existingIndex === undefined) {
      indexById.set(activity.id, result.length);
      result.push(activity);
      continue;
    }
    result[existingIndex] = preferRicherActivity(result[existingIndex]!, activity);
  }
  return arraysShallowEqual(activities, result) ? (activities as TActivity[]) : result;
}

function preferRicherActivity<TActivity extends Thread["activities"][number]>(
  previous: TActivity,
  incoming: TActivity,
): TActivity {
  if (activitiesEqual(previous, incoming)) {
    return previous;
  }
  const previousScore = activityPayloadDetailScore(previous);
  const incomingScore = activityPayloadDetailScore(incoming);
  return incomingScore < previousScore ? previous : incoming;
}

function activitiesEqual(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): boolean {
  return (
    left.kind === right.kind &&
    left.tone === right.tone &&
    left.summary === right.summary &&
    deepEqualJson(left.payload, right.payload) &&
    left.turnId === right.turnId &&
    left.sequence === right.sequence &&
    left.createdAt === right.createdAt
  );
}

function activityPayloadDetailScore(activity: Thread["activities"][number]): number {
  const payload = asActivityRecord(activity.payload);
  const data = asActivityRecord(payload?.data);
  const item = asActivityRecord(data?.item);
  const commandActions = item?.commandActions ?? data?.commandActions ?? payload?.commandActions;
  let score = 0;
  if (payload?.itemType) score += 4;
  if (payload?.title) score += 1;
  if (payload?.detail) score += 2;
  if (data) score += 2;
  if (item) score += 4;
  if (normalizeActivityCommandValue(item?.command ?? data?.command ?? payload?.command)) score += 8;
  if (Array.isArray(commandActions) && commandActions.length > 0) score += 8;
  return score;
}

export function asActivityRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeActivityCommandValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

function isNonFatalThreadErrorMessage(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.trim().toLowerCase();
  return normalized.includes("write_stdin failed: stdin is closed for this session");
}

export function normalizeThreadErrorMessage(message: string | null | undefined): string | null {
  return message && !isNonFatalThreadErrorMessage(message) ? message : null;
}

export function normalizeThreadSession(
  incoming: ReadModelThread["session"],
  previous: Thread["session"] | undefined | null,
): Thread["session"] {
  if (!incoming) {
    return null;
  }
  const nextLastError =
    incoming.lastError && !isNonFatalThreadErrorMessage(incoming.lastError)
      ? incoming.lastError
      : undefined;
  const nextSession = {
    provider: toLegacyProvider(incoming.providerName),
    status: toLegacySessionStatus(incoming.status),
    orchestrationStatus: incoming.status,
    activeTurnId: incoming.activeTurnId ?? undefined,
    createdAt: incoming.updatedAt,
    updatedAt: incoming.updatedAt,
    ...(nextLastError ? { lastError: nextLastError } : {}),
  } satisfies NonNullable<Thread["session"]>;
  if (
    previous &&
    previous.provider === nextSession.provider &&
    previous.status === nextSession.status &&
    previous.orchestrationStatus === nextSession.orchestrationStatus &&
    previous.activeTurnId === nextSession.activeTurnId &&
    previous.createdAt === nextSession.createdAt &&
    previous.updatedAt === nextSession.updatedAt &&
    previous.lastError === nextSession.lastError
  ) {
    return previous;
  }
  return nextSession;
}

function normalizeLatestTurn(
  incoming: ReadModelThread["latestTurn"],
  previous: Thread["latestTurn"] | undefined | null,
): Thread["latestTurn"] {
  if (!incoming) {
    return null;
  }
  const nextSourceProposedPlan = incoming.sourceProposedPlan
    ? previous?.sourceProposedPlan &&
      previous.sourceProposedPlan.threadId === incoming.sourceProposedPlan.threadId &&
      previous.sourceProposedPlan.planId === incoming.sourceProposedPlan.planId
      ? previous.sourceProposedPlan
      : incoming.sourceProposedPlan
    : undefined;

  if (
    previous &&
    previous.turnId === incoming.turnId &&
    previous.state === incoming.state &&
    previous.requestedAt === incoming.requestedAt &&
    previous.startedAt === incoming.startedAt &&
    previous.completedAt === incoming.completedAt &&
    previous.assistantMessageId === incoming.assistantMessageId &&
    previous.sourceProposedPlan === nextSourceProposedPlan
  ) {
    return previous;
  }

  return {
    turnId: incoming.turnId,
    state: incoming.state,
    requestedAt: incoming.requestedAt,
    startedAt: incoming.startedAt,
    completedAt: incoming.completedAt,
    assistantMessageId: incoming.assistantMessageId,
    ...(nextSourceProposedPlan ? { sourceProposedPlan: nextSourceProposedPlan } : {}),
  };
}

export function normalizeThreadFromReadModel(
  incoming: ReadModelThread,
  previous: Thread | undefined,
): Thread {
  const modelSelection = normalizeModelSelection(incoming.modelSelection, previous?.modelSelection);
  const session = normalizeThreadSession(incoming.session, previous?.session);
  const messages = normalizeChatMessages(incoming.messages, previous?.messages);
  const proposedPlans = normalizeProposedPlans(incoming.proposedPlans, previous?.proposedPlans);
  const latestTurn = normalizeLatestTurn(incoming.latestTurn, previous?.latestTurn);
  const handoff =
    previous?.handoff && incoming.handoff && deepEqualJson(previous.handoff, incoming.handoff)
      ? previous.handoff
      : (incoming.handoff ?? null);
  const lastKnownPr =
    previous?.lastKnownPr &&
    incoming.lastKnownPr &&
    deepEqualJson(previous.lastKnownPr, incoming.lastKnownPr)
      ? previous.lastKnownPr
      : (incoming.lastKnownPr ?? null);
  const pinnedMessages =
    previous?.pinnedMessages &&
    deepEqualJson(previous.pinnedMessages, incoming.pinnedMessages ?? null)
      ? previous.pinnedMessages
      : (incoming.pinnedMessages as Thread["pinnedMessages"]);
  const threadMarkers =
    previous?.threadMarkers && deepEqualJson(previous.threadMarkers, incoming.threadMarkers ?? null)
      ? previous.threadMarkers
      : (incoming.threadMarkers as Thread["threadMarkers"]);
  const notes = incoming.notes;
  const turnDiffSummaries = normalizeTurnDiffSummaries(
    incoming.checkpoints,
    previous?.turnDiffSummaries,
  );
  const activities = normalizeActivities(incoming.activities, previous?.activities);
  const incomingPendingInteractions = Object.hasOwn(incoming, "pendingInteractions")
    ? (incoming.pendingInteractions ?? [])
    : previous?.pendingInteractions;
  const pendingInteractions =
    previous?.pendingInteractions &&
    deepEqualJson(previous.pendingInteractions, incomingPendingInteractions ?? [])
      ? previous.pendingInteractions
      : incomingPendingInteractions === undefined
        ? undefined
        : [...incomingPendingInteractions];
  const error = normalizeThreadErrorMessage(incoming.session?.lastError);
  const lastVisitedAt = previous?.lastVisitedAt ?? incoming.updatedAt;
  const resolvedLatestUserMessageAt =
    Object.hasOwn(incoming, "latestUserMessageAt") && incoming.latestUserMessageAt !== undefined
      ? (incoming.latestUserMessageAt ?? null)
      : undefined;
  const resolvedHasPendingApprovals =
    typeof incoming.hasPendingApprovals === "boolean" ? incoming.hasPendingApprovals : undefined;
  const resolvedHasPendingUserInput =
    typeof incoming.hasPendingUserInput === "boolean" ? incoming.hasPendingUserInput : undefined;
  const resolvedHasActionableProposedPlan =
    typeof incoming.hasActionableProposedPlan === "boolean"
      ? incoming.hasActionableProposedPlan
      : undefined;
  const nextWorktreePath = incoming.worktreePath;
  const nextWorkingDirectory = incoming.workingDirectory ?? null;
  const nextAssociatedWorktreePath = incoming.associatedWorktreePath ?? null;
  const nextAssociatedWorktreeBranch = incoming.associatedWorktreeBranch ?? null;
  const nextAssociatedWorktreeRef = incoming.associatedWorktreeRef ?? null;
  const resolvedBranch = resolveThreadBranchRegressionGuard({
    currentBranch: previous?.branch ?? null,
    nextBranch: incoming.branch,
  });
  const resolvedCreateBranchFlowCompleted = resolveCreateBranchFlowCompletedMerge({
    currentBranch: previous?.branch ?? null,
    nextBranch: resolvedBranch,
    currentWorktreePath: previous?.worktreePath ?? null,
    nextWorktreePath,
    currentAssociatedWorktreePath: previous?.associatedWorktreePath,
    nextAssociatedWorktreePath,
    currentAssociatedWorktreeBranch: previous?.associatedWorktreeBranch,
    nextAssociatedWorktreeBranch,
    currentAssociatedWorktreeRef: previous?.associatedWorktreeRef,
    nextAssociatedWorktreeRef,
    currentCreateBranchFlowCompleted: previous?.createBranchFlowCompleted,
    nextCreateBranchFlowCompleted: incoming.createBranchFlowCompleted,
  });
  const pendingSourceProposedPlan =
    latestTurn?.sourceProposedPlan ??
    (incoming.session?.status === "running" ? previous?.pendingSourceProposedPlan : undefined);

  if (
    previous &&
    previous.projectId === incoming.projectId &&
    previous.title === incoming.title &&
    previous.modelSelection === modelSelection &&
    previous.runtimeMode === incoming.runtimeMode &&
    previous.interactionMode === incoming.interactionMode &&
    previous.session === session &&
    previous.messages === messages &&
    previous.proposedPlans === proposedPlans &&
    previous.error === error &&
    previous.createdAt === incoming.createdAt &&
    (previous.archivedAt ?? null) === (incoming.archivedAt ?? null) &&
    (previous.settledAt ?? null) === (incoming.settledAt ?? null) &&
    previous.updatedAt === incoming.updatedAt &&
    (previous.isPinned ?? false) === (incoming.isPinned ?? false) &&
    previous.latestTurn === latestTurn &&
    previous.pendingSourceProposedPlan === pendingSourceProposedPlan &&
    previous.lastVisitedAt === lastVisitedAt &&
    (previous.parentThreadId ?? null) === (incoming.parentThreadId ?? null) &&
    (previous.creationSource ?? null) === (incoming.creationSource ?? null) &&
    (previous.sourceThreadId ?? null) === (incoming.sourceThreadId ?? null) &&
    (previous.subagentAgentId ?? null) === (incoming.subagentAgentId ?? null) &&
    (previous.subagentNickname ?? null) === (incoming.subagentNickname ?? null) &&
    (previous.subagentRole ?? null) === (incoming.subagentRole ?? null) &&
    previous.envMode === (incoming.envMode ?? "local") &&
    previous.branch === resolvedBranch &&
    previous.worktreePath === nextWorktreePath &&
    (previous.workingDirectory ?? null) === nextWorkingDirectory &&
    (previous.associatedWorktreePath ?? null) === nextAssociatedWorktreePath &&
    (previous.associatedWorktreeBranch ?? null) === nextAssociatedWorktreeBranch &&
    (previous.associatedWorktreeRef ?? null) === nextAssociatedWorktreeRef &&
    (previous.createBranchFlowCompleted ?? false) === resolvedCreateBranchFlowCompleted &&
    previous.latestUserMessageAt === resolvedLatestUserMessageAt &&
    previous.hasPendingApprovals === resolvedHasPendingApprovals &&
    previous.hasPendingUserInput === resolvedHasPendingUserInput &&
    previous.hasActionableProposedPlan === resolvedHasActionableProposedPlan &&
    (previous.forkSourceThreadId ?? null) === (incoming.forkSourceThreadId ?? null) &&
    (previous.sidechatSourceThreadId ?? null) === (incoming.sidechatSourceThreadId ?? null) &&
    deepEqualJson(previous.lastKnownPr ?? null, lastKnownPr) &&
    (previous.handoff ?? null) === handoff &&
    previous.pinnedMessages === pinnedMessages &&
    previous.threadMarkers === threadMarkers &&
    previous.notes === notes &&
    previous.turnDiffSummaries === turnDiffSummaries &&
    previous.activities === activities &&
    previous.pendingInteractions === pendingInteractions
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    codexThreadId: null,
    projectId: incoming.projectId,
    title: incoming.title,
    modelSelection,
    runtimeMode: incoming.runtimeMode,
    interactionMode: incoming.interactionMode,
    session,
    messages,
    proposedPlans,
    error,
    createdAt: incoming.createdAt,
    archivedAt: incoming.archivedAt ?? null,
    settledAt: incoming.settledAt ?? null,
    updatedAt: incoming.updatedAt,
    isPinned: incoming.isPinned ?? false,
    latestTurn,
    ...(pendingSourceProposedPlan ? { pendingSourceProposedPlan } : {}),
    lastVisitedAt,
    parentThreadId: incoming.parentThreadId ?? null,
    creationSource: incoming.creationSource ?? null,
    sourceThreadId: incoming.sourceThreadId ?? null,
    subagentAgentId: incoming.subagentAgentId ?? null,
    subagentNickname: incoming.subagentNickname ?? null,
    subagentRole: incoming.subagentRole ?? null,
    envMode: incoming.envMode ?? "local",
    branch: resolvedBranch,
    worktreePath: nextWorktreePath,
    workingDirectory: nextWorkingDirectory,
    associatedWorktreePath: nextAssociatedWorktreePath,
    associatedWorktreeBranch: nextAssociatedWorktreeBranch,
    associatedWorktreeRef: nextAssociatedWorktreeRef,
    createBranchFlowCompleted: resolvedCreateBranchFlowCompleted,
    forkSourceThreadId: incoming.forkSourceThreadId ?? null,
    sidechatSourceThreadId: incoming.sidechatSourceThreadId ?? null,
    lastKnownPr,
    handoff,
    ...(pinnedMessages !== undefined ? { pinnedMessages } : {}),
    ...(threadMarkers !== undefined ? { threadMarkers } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(resolvedLatestUserMessageAt !== undefined
      ? { latestUserMessageAt: resolvedLatestUserMessageAt }
      : {}),
    ...(resolvedHasPendingApprovals !== undefined
      ? { hasPendingApprovals: resolvedHasPendingApprovals }
      : {}),
    ...(resolvedHasPendingUserInput !== undefined
      ? { hasPendingUserInput: resolvedHasPendingUserInput }
      : {}),
    ...(resolvedHasActionableProposedPlan !== undefined
      ? { hasActionableProposedPlan: resolvedHasActionableProposedPlan }
      : {}),
    turnDiffSummaries,
    activities,
    ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
  };
}

export function normalizeThreadShellSnapshot(
  incoming: ShellSnapshotThread,
  previous: Thread | undefined,
): {
  shell: ThreadShell;
  session: ThreadSession | null;
  turnState: ThreadTurnState;
} {
  const modelSelection = normalizeModelSelection(incoming.modelSelection, previous?.modelSelection);
  const session = normalizeThreadSession(incoming.session, previous?.session);
  const latestTurn = normalizeLatestTurn(incoming.latestTurn, previous?.latestTurn);
  const handoff =
    previous?.handoff && incoming.handoff && deepEqualJson(previous.handoff, incoming.handoff)
      ? previous.handoff
      : (incoming.handoff ?? null);
  const lastKnownPr =
    previous?.lastKnownPr &&
    incoming.lastKnownPr &&
    deepEqualJson(previous.lastKnownPr, incoming.lastKnownPr)
      ? previous.lastKnownPr
      : (incoming.lastKnownPr ?? null);
  const error = normalizeThreadErrorMessage(incoming.session?.lastError);
  const lastVisitedAt = previous?.lastVisitedAt ?? incoming.updatedAt;
  const nextWorktreePath = incoming.worktreePath;
  const nextWorkingDirectory = incoming.workingDirectory ?? null;
  const nextAssociatedWorktreePath = incoming.associatedWorktreePath ?? null;
  const nextAssociatedWorktreeBranch = incoming.associatedWorktreeBranch ?? null;
  const nextAssociatedWorktreeRef = incoming.associatedWorktreeRef ?? null;
  const resolvedBranch = resolveThreadBranchRegressionGuard({
    currentBranch: previous?.branch ?? null,
    nextBranch: incoming.branch,
  });
  const resolvedCreateBranchFlowCompleted = resolveCreateBranchFlowCompletedMerge({
    currentBranch: previous?.branch ?? null,
    nextBranch: resolvedBranch,
    currentWorktreePath: previous?.worktreePath ?? null,
    nextWorktreePath,
    currentAssociatedWorktreePath: previous?.associatedWorktreePath,
    nextAssociatedWorktreePath,
    currentAssociatedWorktreeBranch: previous?.associatedWorktreeBranch,
    nextAssociatedWorktreeBranch,
    currentAssociatedWorktreeRef: previous?.associatedWorktreeRef,
    nextAssociatedWorktreeRef,
    currentCreateBranchFlowCompleted: previous?.createBranchFlowCompleted,
    nextCreateBranchFlowCompleted: incoming.createBranchFlowCompleted,
  });
  const shell: ThreadShell = {
    id: incoming.id,
    codexThreadId: previous?.codexThreadId ?? null,
    projectId: incoming.projectId,
    title: incoming.title,
    modelSelection,
    runtimeMode: incoming.runtimeMode,
    interactionMode: incoming.interactionMode,
    error,
    createdAt: incoming.createdAt,
    archivedAt: incoming.archivedAt ?? null,
    settledAt: incoming.settledAt ?? null,
    updatedAt: incoming.updatedAt,
    isPinned: incoming.isPinned ?? false,
    envMode: incoming.envMode ?? "local",
    branch: resolvedBranch,
    worktreePath: nextWorktreePath,
    workingDirectory: nextWorkingDirectory,
    associatedWorktreePath: nextAssociatedWorktreePath,
    associatedWorktreeBranch: nextAssociatedWorktreeBranch,
    associatedWorktreeRef: nextAssociatedWorktreeRef,
    createBranchFlowCompleted: resolvedCreateBranchFlowCompleted,
    parentThreadId: incoming.parentThreadId ?? null,
    creationSource: incoming.creationSource ?? null,
    sourceThreadId: incoming.sourceThreadId ?? null,
    subagentAgentId: incoming.subagentAgentId ?? null,
    subagentNickname: incoming.subagentNickname ?? null,
    subagentRole: incoming.subagentRole ?? null,
    forkSourceThreadId: incoming.forkSourceThreadId ?? null,
    sidechatSourceThreadId: incoming.sidechatSourceThreadId ?? null,
    lastKnownPr,
    handoff,
    // The sidebar shell snapshot/event does not carry thread annotations, so keep the values
    // resolved from the thread-detail path instead of clobbering them with `undefined`.
    ...(previous?.pinnedMessages !== undefined ? { pinnedMessages: previous.pinnedMessages } : {}),
    ...(previous?.threadMarkers !== undefined ? { threadMarkers: previous.threadMarkers } : {}),
    ...(previous?.notes !== undefined ? { notes: previous.notes } : {}),
    ...(incoming.latestUserMessageAt !== undefined
      ? { latestUserMessageAt: incoming.latestUserMessageAt ?? null }
      : {}),
    ...(incoming.hasPendingApprovals !== undefined
      ? { hasPendingApprovals: incoming.hasPendingApprovals }
      : {}),
    ...(incoming.hasPendingUserInput !== undefined
      ? { hasPendingUserInput: incoming.hasPendingUserInput }
      : {}),
    ...(incoming.hasActionableProposedPlan !== undefined
      ? { hasActionableProposedPlan: incoming.hasActionableProposedPlan }
      : {}),
    ...(previous?.pendingInteractions !== undefined
      ? { pendingInteractions: previous.pendingInteractions }
      : {}),
    ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
  };
  return {
    shell,
    session,
    turnState: {
      latestTurn,
      ...(latestTurn?.sourceProposedPlan
        ? { pendingSourceProposedPlan: latestTurn.sourceProposedPlan }
        : {}),
    },
  };
}

export function mapProjects(
  incoming: ReadonlyArray<ProjectNormalizationInput>,
  previous: Project[],
): Project[] {
  const rememberedUiState = getRememberedProjectUiState();
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(
    previous.map((project) => [projectCwdKey(project.cwd), project] as const),
  );
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [projectCwdKey(project.cwd), index] as const),
  );
  const usePersistedOrder = previous.length === 0;

  const mappedProjects = incoming
    .map((project) => {
      const existing =
        previousById.get(project.id) ?? previousByCwd.get(projectCwdKey(project.workspaceRoot));
      return normalizeProject(project, existing);
    })
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(projectCwdKey(project.cwd));
      const persistedIndex = usePersistedOrder
        ? rememberedUiState.projectOrderIndexForCwd(projectCwdKey(project.cwd))
        : undefined;
      const orderIndex =
        previousIndex ??
        persistedIndex ??
        (usePersistedOrder ? rememberedUiState.projectOrderCount : previous.length) + incomingIndex;
      return { project, incomingIndex, orderIndex };
    })
    .toSorted((a, b) => {
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);

  return arraysShallowEqual(previous, mappedProjects) ? previous : mappedProjects;
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (
    providerName === "codex" ||
    providerName === "claudeAgent" ||
    providerName === "cursor" ||
    providerName === "antigravity" ||
    providerName === "grok" ||
    providerName === "droid" ||
    providerName === "kilo" ||
    providerName === "opencode" ||
    providerName === "pi"
  ) {
    return providerName;
  }
  return "codex";
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

export function resolveThreadSidebarMetadata(
  thread: Thread,
): Pick<
  SidebarThreadSummary,
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "hasLiveTailWork"
> {
  const needsDerivedMetadata =
    thread.latestUserMessageAt === undefined ||
    thread.hasPendingApprovals === undefined ||
    thread.hasPendingUserInput === undefined ||
    thread.hasActionableProposedPlan === undefined;
  const derivedMetadata = needsDerivedMetadata
    ? deriveThreadSummaryMetadata({
        messages: thread.messages,
        activities: thread.activities,
        proposedPlans: thread.proposedPlans,
        latestTurn: thread.latestTurn,
      })
    : null;

  return {
    latestUserMessageAt: thread.latestUserMessageAt ?? derivedMetadata?.latestUserMessageAt ?? null,
    hasPendingApprovals:
      thread.hasPendingApprovals ?? derivedMetadata?.hasPendingApprovals ?? false,
    hasPendingUserInput:
      thread.hasPendingUserInput ?? derivedMetadata?.hasPendingUserInput ?? false,
    hasActionableProposedPlan:
      thread.hasActionableProposedPlan ?? derivedMetadata?.hasActionableProposedPlan ?? false,
    hasLiveTailWork: Boolean(
      hasLiveTurnTailWork({
        latestTurn: thread.latestTurn,
        messages: thread.messages,
        activities: thread.activities,
        session: thread.session,
      }),
    ),
  };
}
