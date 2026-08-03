// FILE: composerDraftDomain.ts
// Purpose: Defines composer draft state, stable defaults, and content/project normalization.
// Exports: Internal domain primitives plus public facade types.

import {
  type ModelSelection,
  type OrchestrationLatestTurn,
  type OrchestrationThreadPullRequest,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderMentionReference,
  type ProviderModelOptions,
  type ProviderSkillReference,
  type ProviderStartOptions,
  type RuntimeMode,
  type ThreadId,
} from "@synara/contracts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

import { normalizeAssistantSelectionAttachment } from "./lib/assistantSelections";
import { type BrowserAnnotationDraft, normalizeBrowserAnnotations } from "./lib/browserAnnotations";
import type { ComposerImageSource } from "./lib/composerImageSource";
import {
  type PastedTextDraft,
  countPastedTextLines,
  createPastedTextDraft,
  normalizePastedTextContent,
} from "./lib/composerPastedText";
import {
  type FileCommentDraft,
  type FileCommentSelection,
  normalizeFileCommentSelection,
} from "./lib/fileComments";
import { type TerminalContextDraft, normalizeTerminalContextText } from "./lib/terminalContext";
import {
  type ChatAssistantSelectionAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ThreadPrimarySurface,
} from "./types";

export const COMPOSER_DRAFT_STORAGE_KEY = "synara:composer-drafts:v1";
export const COMPOSER_DRAFT_STORAGE_VERSION = 6;
export type DraftThreadEnvMode = "local" | "worktree";
const TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX = "::terminal";

const PersistedComposerAppSnapSource = Schema.Struct({
  kind: Schema.Literal("appsnap"),
  captureId: Schema.String,
  capturedAt: Schema.String,
  appName: Schema.NullOr(Schema.String),
  bundleIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  appIconDataUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  windowTitle: Schema.NullOr(Schema.String),
});

const LegacyPersistedComposerAppSnapSource = Schema.Struct({
  kind: Schema.Literal("appshot"),
  captureId: Schema.String,
  capturedAt: Schema.String,
  appName: Schema.NullOr(Schema.String),
  bundleIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  appIconDataUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  windowTitle: Schema.NullOr(Schema.String),
});

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.optionalKey(Schema.String),
  blobKey: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(
    Schema.Union([PersistedComposerAppSnapSource, LegacyPersistedComposerAppSnapSource]),
  ),
});

export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export type ComposerAttachmentPersistenceResult = "persisted" | "rejected" | "unverified";

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
  source?: ComposerImageSource | undefined;
}

export interface ComposerFileAttachment extends ChatFileAttachment {
  file: File;
}

export interface ComposerPromptHistorySavedDraft {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  browserAnnotations: BrowserAnnotationDraft[];
  terminalContexts: TerminalContextDraft[];
  fileComments: FileCommentDraft[];
  pastedTexts: PastedTextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
}

export type ComposerAssistantSelectionAttachment = ChatAssistantSelectionAttachment;

export interface QueuedComposerChatTurn {
  id: string;
  kind: "chat";
  createdAt: string;
  previewText: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  browserAnnotations: BrowserAnnotationDraft[];
  terminalContexts: TerminalContextDraft[];
  fileComments: FileCommentDraft[];
  pastedTexts: PastedTextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedPromptEffort: string | null;
  modelSelection: ModelSelection;
  providerOptionsForDispatch?: ProviderStartOptions | undefined;
  sourceProposedPlan?: NonNullable<OrchestrationLatestTurn["sourceProposedPlan"]> | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
}

export interface RestoredComposerSourceProposedPlan {
  threadId: ThreadId;
  restoredPrompt: string;
  sourceProposedPlan: NonNullable<OrchestrationLatestTurn["sourceProposedPlan"]>;
}

export interface QueuedComposerPlanFollowUp {
  id: string;
  kind: "plan-follow-up";
  createdAt: string;
  previewText: string;
  text: string;
  interactionMode: "default" | "plan";
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedPromptEffort: string | null;
  modelSelection: ModelSelection;
  providerOptionsForDispatch?: ProviderStartOptions | undefined;
  runtimeMode: RuntimeMode;
}

export type QueuedComposerTurn = QueuedComposerChatTurn | QueuedComposerPlanFollowUp;

export interface ComposerThreadDraftState {
  prompt: string;
  // Non-null only while composer prompt-history browsing is active: the user's
  // real draft, kept safe while `prompt` temporarily holds a recalled history
  // entry. Restored (and cleared) when a browse is interrupted by a thread
  // switch or reload.
  promptHistorySavedDraft: ComposerPromptHistorySavedDraft | null;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  browserAnnotations: BrowserAnnotationDraft[];
  terminalContexts: TerminalContextDraft[];
  fileComments: FileCommentDraft[];
  pastedTexts: PastedTextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
  queuedTurns: QueuedComposerTurn[];
  restoredSourceProposedPlan?: RestoredComposerSourceProposedPlan | null;
  modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  activeProvider: ProviderKind | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  entryPoint: ThreadPrimarySurface;
  branch: string | null;
  worktreePath: string | null;
  workingDirectory?: string | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  envMode: DraftThreadEnvMode;
  isTemporary?: boolean;
  promotedTo?: ThreadId;
}

interface DraftThreadMutationOptions {
  branch?: string | null;
  worktreePath?: string | null;
  workingDirectory?: string | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  createdAt?: string;
  // Explicitly `| undefined`: callers forward a `ThreadWorkspacePatch`, whose `envMode` is
  // optional in the same way, and under `exactOptionalPropertyTypes` a bare `?:` would reject
  // that spread even though the value sets are identical ("local" | "worktree").
  envMode?: DraftThreadEnvMode | undefined;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  entryPoint?: ThreadPrimarySurface;
  isTemporary?: boolean;
}

type DraftThreadCreatedAtMode = "accept-empty" | "preserve-existing-on-empty";

interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

export interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  stickyActiveProvider: ProviderKind | null;
  getDraftThreadByProjectId: (
    projectId: ProjectId,
    entryPoint?: ThreadPrimarySurface,
  ) => ProjectDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: DraftThreadMutationOptions,
  ) => void;
  /**
   * Registers a standalone draft thread without claiming the project's
   * composer-draft mapping. Unlike setProjectDraftThreadId this never replaces
   * (and therefore never deletes) the mapped draft, so any number of standalone
   * drafts — e.g. kanban tasks — can coexist per project. Create-only: an
   * existing draft thread is left untouched.
   */
  registerDraftThread: (
    threadId: ThreadId,
    options: {
      projectId: ProjectId;
      createdAt?: string;
      branch?: string | null;
      worktreePath?: string | null;
      workingDirectory?: string | null;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      entryPoint?: ThreadPrimarySurface;
      isTemporary?: boolean;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: DraftThreadMutationOptions & { projectId?: ProjectId },
  ) => void;
  /**
   * Moves an existing draft into a project's primary draft slot while deleting
   * the draft that used to occupy that slot, if no other project still maps it.
   */
  moveDraftThreadToProject: (
    threadId: ThreadId,
    projectId: ProjectId,
    options?: DraftThreadMutationOptions,
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId, entryPoint?: ThreadPrimarySurface) => void;
  clearProjectDraftThreads: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  markDraftThreadPromoting: (threadId: ThreadId, promotedTo?: ThreadId) => void;
  finalizePromotedDraftThread: (threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setPromptHistorySavedDraft: (
    threadId: ThreadId,
    savedDraft: ComposerPromptHistorySavedDraft | null,
  ) => void;
  restorePromptHistorySavedDraft: (threadId: ThreadId) => void;
  addPromptHistorySavedDraftImage: (threadId: ThreadId, image: ComposerImageAttachment) => boolean;
  syncPromptHistorySavedDraftPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<ComposerAttachmentPersistenceResult>;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setSkills: (threadId: ThreadId, skills: ProviderSkillReference[]) => void;
  setMentions: (threadId: ThreadId, mentions: ProviderMentionReference[]) => void;
  setModelSelection: (
    threadId: ThreadId,
    modelSelection: ModelSelection | null | undefined,
  ) => void;
  setModelSelectionAndSticky: (threadId: ThreadId, modelSelection: ModelSelection) => void;
  setModelOptions: (
    threadId: ThreadId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  applyStickyState: (threadId: ThreadId) => void;
  setProviderModelOptions: (
    threadId: ThreadId,
    provider: ProviderKind,
    nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
    options?: {
      model?: string | null;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  enqueueQueuedTurn: (threadId: ThreadId, queuedTurn: QueuedComposerTurn) => void;
  insertQueuedTurn: (threadId: ThreadId, queuedTurn: QueuedComposerTurn, index: number) => void;
  removeQueuedTurn: (threadId: ThreadId, queuedTurnId: string) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => boolean;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => number;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  removeAppSnapCapture: (captureId: string) => void;
  addFiles: (threadId: ThreadId, files: ComposerFileAttachment[]) => number;
  removeFile: (threadId: ThreadId, fileId: string) => void;
  addAssistantSelection: (
    threadId: ThreadId,
    selection: ComposerAssistantSelectionAttachment,
  ) => boolean;
  removeAssistantSelection: (threadId: ThreadId, selectionId: string) => void;
  clearAssistantSelections: (threadId: ThreadId) => void;
  addBrowserAnnotation: (
    threadId: ThreadId,
    annotation: Omit<BrowserAnnotationDraft, "ordinal"> & { ordinal?: number },
  ) => boolean;
  addBrowserAnnotations: (
    threadId: ThreadId,
    annotations: ReadonlyArray<Omit<BrowserAnnotationDraft, "ordinal"> & { ordinal?: number }>,
  ) => number;
  removeBrowserAnnotation: (threadId: ThreadId, annotationId: string) => void;
  clearBrowserAnnotations: (threadId: ThreadId) => void;
  addFileComment: (threadId: ThreadId, comment: FileCommentDraft) => boolean;
  removeFileComment: (threadId: ThreadId, commentId: string) => void;
  clearFileComments: (threadId: ThreadId) => void;
  addPastedTexts: (threadId: ThreadId, pastedTexts: PastedTextDraft[]) => void;
  removePastedText: (threadId: ThreadId, pastedTextId: string) => void;
  clearPastedTexts: (threadId: ThreadId) => void;
  insertTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadId: ThreadId, contextId: string) => void;
  clearTerminalContexts: (threadId: ThreadId) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<ComposerAttachmentPersistenceResult>;
  copyTransferableComposerState: (sourceThreadId: ThreadId, targetThreadId: ThreadId) => void;
  setRestoredSourceProposedPlan: (
    threadId: ThreadId,
    source: RestoredComposerSourceProposedPlan | null,
  ) => void;
  clearComposerContent: (
    threadId: ThreadId,
    options?: { readonly preservePreviewUrls?: boolean },
  ) => void;
}

export function projectDraftThreadMappingKey(
  projectId: ProjectId,
  entryPoint: ThreadPrimarySurface = "chat",
): string {
  return entryPoint === "terminal"
    ? `${projectId}${TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX}`
    : projectId;
}

export function projectDraftThreadEntryPointFromKey(key: string): ThreadPrimarySurface {
  return key.endsWith(TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX) ? "terminal" : "chat";
}

export function projectIdFromDraftThreadMappingKey(key: string): ProjectId {
  return (
    key.endsWith(TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX)
      ? key.slice(0, -TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX.length)
      : key
  ) as ProjectId;
}

function resolveDraftThreadCreatedAt(input: {
  createdAt: string | undefined;
  existingThread: DraftThreadState | undefined;
  mode: DraftThreadCreatedAtMode;
}): string {
  if (input.createdAt === undefined) {
    return input.existingThread?.createdAt ?? new Date().toISOString();
  }
  if (input.mode === "preserve-existing-on-empty") {
    return input.createdAt || input.existingThread?.createdAt || new Date().toISOString();
  }
  return input.createdAt;
}

export function buildDraftThreadState(input: {
  projectId: ProjectId;
  existingThread?: DraftThreadState | undefined;
  options?: DraftThreadMutationOptions | undefined;
  createdAtMode: DraftThreadCreatedAtMode;
}): DraftThreadState {
  const { existingThread, options } = input;
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextEntryPoint = normalizeDraftThreadEntryPoint(
    options?.entryPoint,
    existingThread?.entryPoint ?? "chat",
  );
  const nextIsTemporary =
    options?.isTemporary === true
      ? true
      : options?.isTemporary === false
        ? false
        : existingThread?.isTemporary === true;
  const nextPromotedTo = existingThread?.promotedTo;

  return {
    projectId: input.projectId,
    createdAt: resolveDraftThreadCreatedAt({
      createdAt: options?.createdAt,
      existingThread,
      mode: input.createdAtMode,
    }),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    entryPoint: nextEntryPoint,
    branch:
      options?.branch === undefined ? (existingThread?.branch ?? null) : (options.branch ?? null),
    worktreePath: nextWorktreePath,
    workingDirectory:
      options?.workingDirectory === undefined
        ? (existingThread?.workingDirectory ?? null)
        : (options.workingDirectory ?? null),
    lastKnownPr:
      options?.lastKnownPr === undefined
        ? (existingThread?.lastKnownPr ?? null)
        : (options.lastKnownPr ?? null),
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    ...(nextIsTemporary ? { isTemporary: true } : {}),
    ...(nextPromotedTo ? { promotedTo: nextPromotedTo } : {}),
  };
}

export function draftThreadStatesEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.projectId === right.projectId &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.entryPoint === right.entryPoint &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    (left.workingDirectory ?? null) === (right.workingDirectory ?? null) &&
    Equal.equals(left.lastKnownPr ?? null, right.lastKnownPr ?? null) &&
    left.envMode === right.envMode &&
    (left.isTemporary === true) === (right.isTemporary === true) &&
    left.promotedTo === right.promotedTo
  );
}

export function removeProjectDraftMappingsForThread(
  projectDraftThreadIdByProjectId: Record<string, ThreadId>,
  threadId: ThreadId,
): Record<string, ThreadId> {
  let nextProjectDraftThreadIdByProjectId = projectDraftThreadIdByProjectId;
  for (const [mappingKey, mappedThreadId] of Object.entries(projectDraftThreadIdByProjectId)) {
    if (mappedThreadId !== threadId) {
      continue;
    }
    if (nextProjectDraftThreadIdByProjectId === projectDraftThreadIdByProjectId) {
      nextProjectDraftThreadIdByProjectId = { ...projectDraftThreadIdByProjectId };
    }
    delete nextProjectDraftThreadIdByProjectId[mappingKey];
  }
  return nextProjectDraftThreadIdByProjectId;
}

export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    promptHistorySavedDraft: null,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    queuedTurns: [],
    restoredSourceProposedPlan: null,
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function assistantSelectionDedupKey(
  selection: Pick<ComposerAssistantSelectionAttachment, "assistantMessageId" | "text">,
): string {
  return `${selection.assistantMessageId}\u0000${selection.text}`;
}

export function normalizeAssistantSelection(
  selection: Pick<ComposerAssistantSelectionAttachment, "id" | "assistantMessageId" | "text">,
): ComposerAssistantSelectionAttachment | null {
  const normalized = normalizeAssistantSelectionAttachment(selection);
  if (!normalized) {
    return null;
  }
  return {
    type: "assistant-selection",
    ...selection,
    assistantMessageId: normalized.assistantMessageId,
    text: normalized.text,
  };
}

export function normalizeAssistantSelections(
  selections: ReadonlyArray<
    Pick<ComposerAssistantSelectionAttachment, "id" | "assistantMessageId" | "text">
  >,
): ComposerAssistantSelectionAttachment[] {
  const normalizedSelections: ComposerAssistantSelectionAttachment[] = [];
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();

  for (const selection of selections) {
    const normalizedSelection = normalizeAssistantSelection(selection);
    if (!normalizedSelection) {
      continue;
    }
    const dedupKey = assistantSelectionDedupKey(normalizedSelection);
    if (existingIds.has(normalizedSelection.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedSelections.push(normalizedSelection);
    existingIds.add(normalizedSelection.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedSelections;
}

export function fileCommentDedupKey(comment: FileCommentSelection): string {
  return JSON.stringify([comment.path, comment.startLine, comment.endLine, comment.text]);
}

export function normalizeFileComment(comment: FileCommentDraft): FileCommentDraft | null {
  const normalized = normalizeFileCommentSelection(comment);
  if (!normalized) {
    return null;
  }
  return {
    id: comment.id,
    ...normalized,
  };
}

export function normalizeFileComments(
  comments: ReadonlyArray<FileCommentDraft>,
): FileCommentDraft[] {
  const normalizedComments: FileCommentDraft[] = [];
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();

  for (const comment of comments) {
    const normalizedComment = normalizeFileComment(comment);
    if (!normalizedComment) {
      continue;
    }
    const dedupKey = fileCommentDedupKey(normalizedComment);
    if (existingIds.has(normalizedComment.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedComments.push(normalizedComment);
    existingIds.add(normalizedComment.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedComments;
}

function normalizePastedText(pasted: PastedTextDraft): PastedTextDraft | null {
  const text = normalizePastedTextContent(pasted.text);
  if (pasted.id.length === 0 || text.length === 0) {
    return null;
  }
  return {
    id: pasted.id,
    createdAt: pasted.createdAt,
    text,
    lineCount: countPastedTextLines(text),
    charCount: text.length,
  };
}

export function normalizePastedTexts(
  pastedTexts: ReadonlyArray<PastedTextDraft>,
): PastedTextDraft[] {
  const normalizedPastedTexts: PastedTextDraft[] = [];
  const existingIds = new Set<string>();
  for (const pasted of pastedTexts) {
    const normalized = normalizePastedText(pasted);
    if (!normalized || existingIds.has(normalized.id)) {
      continue;
    }
    normalizedPastedTexts.push(normalized);
    existingIds.add(normalized.id);
  }
  return normalizedPastedTexts;
}

type PersistedPastedTextDraft = Pick<PastedTextDraft, "id" | "createdAt" | "text">;

export function hydratePastedTextsFromPersisted(
  persisted: ReadonlyArray<PersistedPastedTextDraft> | undefined,
): PastedTextDraft[] {
  if (!persisted || persisted.length === 0) {
    return [];
  }
  return normalizePastedTexts(persisted.map((entry) => createPastedTextDraft(entry)));
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

export function captureComposerPromptHistorySavedDraft(input: {
  threadId: ThreadId;
  draft: ComposerThreadDraftState;
  prompt: string;
}): ComposerPromptHistorySavedDraft {
  const { threadId, draft, prompt } = input;
  return {
    prompt,
    // Keep the same image objects here: ownership moves from visible composer to saved snapshot.
    images: [...draft.images],
    files: [...draft.files],
    nonPersistedImageIds: [...draft.nonPersistedImageIds],
    persistedAttachments: [...draft.persistedAttachments],
    assistantSelections: normalizeAssistantSelections(draft.assistantSelections),
    browserAnnotations: normalizeBrowserAnnotations(draft.browserAnnotations),
    terminalContexts: normalizeTerminalContextsForThread(threadId, draft.terminalContexts),
    fileComments: normalizeFileComments(draft.fileComments),
    pastedTexts: normalizePastedTexts(draft.pastedTexts),
    skills: [...draft.skills],
    mentions: [...draft.mentions],
  };
}

export function buildTransferredComposerDraft(input: {
  sourceDraft: ComposerThreadDraftState;
  targetDraft: ComposerThreadDraftState | undefined;
  targetThreadId: ThreadId;
}): ComposerThreadDraftState {
  const { sourceDraft, targetDraft, targetThreadId } = input;
  const base = targetDraft ?? createEmptyThreadDraft();
  return {
    ...base,
    prompt: sourceDraft.prompt,
    promptHistorySavedDraft: clonePromptHistorySavedDraft(
      sourceDraft.promptHistorySavedDraft,
      targetThreadId,
    ),
    images: sourceDraft.images.map(cloneComposerImageAttachment),
    files: [...sourceDraft.files],
    nonPersistedImageIds: [...sourceDraft.nonPersistedImageIds],
    persistedAttachments: [...sourceDraft.persistedAttachments],
    assistantSelections: normalizeAssistantSelections(sourceDraft.assistantSelections),
    browserAnnotations: normalizeBrowserAnnotations(sourceDraft.browserAnnotations),
    terminalContexts: normalizeTerminalContextsForThread(
      targetThreadId,
      sourceDraft.terminalContexts,
    ),
    fileComments: normalizeFileComments(sourceDraft.fileComments),
    pastedTexts: normalizePastedTexts(sourceDraft.pastedTexts),
    skills: [...sourceDraft.skills],
    mentions: [...sourceDraft.mentions],
    restoredSourceProposedPlan: null,
  };
}

export function cloneComposerImageAttachment(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

function clonePromptHistorySavedDraft(
  savedDraft: ComposerPromptHistorySavedDraft | null,
  targetThreadId: ThreadId,
): ComposerPromptHistorySavedDraft | null {
  if (!savedDraft) {
    return null;
  }
  return {
    prompt: savedDraft.prompt,
    images: savedDraft.images.map(cloneComposerImageAttachment),
    files: [...savedDraft.files],
    nonPersistedImageIds: [...savedDraft.nonPersistedImageIds],
    persistedAttachments: [...savedDraft.persistedAttachments],
    assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections),
    browserAnnotations: normalizeBrowserAnnotations(savedDraft.browserAnnotations),
    terminalContexts: normalizeTerminalContextsForThread(
      targetThreadId,
      savedDraft.terminalContexts,
    ),
    fileComments: normalizeFileComments(savedDraft.fileComments),
    pastedTexts: normalizePastedTexts(savedDraft.pastedTexts),
    skills: [...savedDraft.skills],
    mentions: [...savedDraft.mentions],
  };
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.promptHistorySavedDraft === null &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.assistantSelections.length === 0 &&
    draft.browserAnnotations.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.fileComments.length === 0 &&
    draft.pastedTexts.length === 0 &&
    draft.skills.length === 0 &&
    draft.mentions.length === 0 &&
    draft.queuedTurns.length === 0 &&
    draft.restoredSourceProposedPlan == null &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

export function normalizeDraftThreadEntryPoint(
  value: unknown,
  fallback: ThreadPrimarySurface = "chat",
) {
  return value === "terminal" || value === "chat" ? value : fallback;
}

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_FILES: ComposerFileAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_BROWSER_ANNOTATIONS: BrowserAnnotationDraft[] = [];
const EMPTY_PASTED_TEXTS: PastedTextDraft[] = [];
const EMPTY_SKILLS: ProviderSkillReference[] = [];
const EMPTY_MENTIONS: ProviderMentionReference[] = [];
const EMPTY_QUEUED_TURNS: QueuedComposerTurn[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_FILES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_TERMINAL_CONTEXTS);
Object.freeze(EMPTY_BROWSER_ANNOTATIONS);
Object.freeze(EMPTY_PASTED_TEXTS);
Object.freeze(EMPTY_SKILLS);
Object.freeze(EMPTY_MENTIONS);
Object.freeze(EMPTY_QUEUED_TURNS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> =
  Object.freeze({});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  promptHistorySavedDraft: null,
  images: EMPTY_IMAGES,
  files: EMPTY_FILES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  assistantSelections: [],
  browserAnnotations: EMPTY_BROWSER_ANNOTATIONS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  fileComments: [],
  pastedTexts: EMPTY_PASTED_TEXTS,
  skills: EMPTY_SKILLS,
  mentions: EMPTY_MENTIONS,
  queuedTurns: EMPTY_QUEUED_TURNS,
  restoredSourceProposedPlan: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

export function selectComposerThreadDraft(
  state: Pick<ComposerDraftStoreState, "draftsByThreadId">,
  threadId: ThreadId,
): ComposerThreadDraftState {
  return state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT;
}
