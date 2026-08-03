// FILE: composerDraftActions.ts
// Purpose: Constructs the ComposerDraftStoreState actions while preserving granular thread identity.
// Exports: Zustand state creator consumed by the public facade.

import {
  type ModelSelection,
  type ProviderKind,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { getDefaultModel, normalizeModelSlug } from "@synara/shared/model";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import type { StateCreator } from "zustand";

import {
  DRAFT_ATTACHMENT_SLOT,
  PROMPT_HISTORY_ATTACHMENT_SLOT,
  composerFileDedupKey,
  deleteDraftComposerImageBlobs,
  deletePersistedComposerImageBlobs,
  mergeComposerImages,
  revokeDraftComposerImagePreviewUrls,
  revokeDraftPreviewUrls,
  revokeObjectPreviewUrl,
  revokePromptHistorySavedDraftPreviewUrls,
  revokeQueuedTurnPreviewUrls,
  syncPersistedAttachmentsForSlot,
} from "./composerDraftAttachments";
import {
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type DraftThreadState,
  type PersistedComposerImageAttachment,
  assistantSelectionDedupKey,
  buildDraftThreadState,
  buildTransferredComposerDraft,
  createEmptyThreadDraft,
  draftThreadStatesEqual,
  fileCommentDedupKey,
  normalizeAssistantSelection,
  normalizeAssistantSelections,
  normalizeDraftThreadEntryPoint,
  normalizeFileComment,
  normalizeFileComments,
  normalizePastedTexts,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  projectDraftThreadMappingKey,
  projectIdFromDraftThreadMappingKey,
  removeProjectDraftMappingsForThread,
  shouldRemoveDraft,
  terminalContextDedupKey,
} from "./composerDraftDomain";
import {
  COMPOSER_PROVIDER_KINDS,
  makeModelSelection,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
  reconcileProviderScopedModelSelection,
  stripNonStickyModelOptions,
} from "./composerDraftModels";
import { isComposerAppSnapCaptureSource } from "./lib/composerImageSource";
import {
  BROWSER_ANNOTATION_MAX_COUNT,
  nextBrowserAnnotationOrdinal,
  normalizeBrowserAnnotation,
  normalizeBrowserAnnotations,
} from "./lib/browserAnnotations";
import { ensureInlineTerminalContextPlaceholders } from "./lib/terminalContext";
import {
  availableComposerAttachmentSlots,
  composerImageConsumesAttachmentSlot,
  effectiveComposerAttachmentCount,
} from "./lib/composerAttachmentCapacity";
import { buildModelSelection } from "./providerModelOptions";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";

function removeDraftThreadIfUnmapped(input: {
  threadId: ThreadId | undefined;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  getDraftsByThreadId: () => Record<ThreadId, ComposerThreadDraftState>;
}): {
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
} {
  if (
    !input.threadId ||
    Object.values(input.projectDraftThreadIdByProjectId).includes(input.threadId)
  ) {
    return {
      draftThreadsByThreadId: input.draftThreadsByThreadId,
      draftsByThreadId: input.draftsByThreadId,
    };
  }

  const nextDraftThreadsByThreadId = { ...input.draftThreadsByThreadId };
  delete nextDraftThreadsByThreadId[input.threadId];
  const removedDraft = input.draftsByThreadId[input.threadId];
  if (!removedDraft) {
    return {
      draftThreadsByThreadId: nextDraftThreadsByThreadId,
      draftsByThreadId: input.draftsByThreadId,
    };
  }

  revokeDraftPreviewUrls(removedDraft);
  deleteDraftComposerImageBlobs(removedDraft, input.getDraftsByThreadId);
  const nextDraftsByThreadId = { ...input.draftsByThreadId };
  delete nextDraftsByThreadId[input.threadId];
  return {
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    draftsByThreadId: nextDraftsByThreadId,
  };
}

export const createComposerDraftStoreState =
  (flushPersistStorage: () => void): StateCreator<ComposerDraftStoreState> =>
  (set, get) => ({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
    getDraftThreadByProjectId: (projectId, entryPoint = "chat") => {
      if (projectId.length === 0) {
        return null;
      }
      const threadId =
        get().projectDraftThreadIdByProjectId[projectDraftThreadMappingKey(projectId, entryPoint)];
      if (!threadId) {
        return null;
      }
      const draftThread = get().draftThreadsByThreadId[threadId];
      if (
        !draftThread ||
        draftThread.projectId !== projectId ||
        normalizeDraftThreadEntryPoint(draftThread.entryPoint) !== entryPoint ||
        draftThread.promotedTo !== undefined
      ) {
        return null;
      }
      return {
        threadId,
        ...draftThread,
      };
    },
    getDraftThread: (threadId) => {
      if (threadId.length === 0) {
        return null;
      }
      return get().draftThreadsByThreadId[threadId] ?? null;
    },
    setProjectDraftThreadId: (projectId, threadId, options) => {
      if (projectId.length === 0 || threadId.length === 0) {
        return;
      }
      set((state) => {
        const existingThread = state.draftThreadsByThreadId[threadId];
        const nextDraftThread = buildDraftThreadState({
          projectId,
          existingThread,
          options,
          createdAtMode: "accept-empty",
        });
        const mappingKey = projectDraftThreadMappingKey(projectId, nextDraftThread.entryPoint);
        const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[mappingKey];
        const hasSameProjectMapping = previousThreadIdForProject === threadId;
        if (hasSameProjectMapping && draftThreadStatesEqual(existingThread, nextDraftThread)) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
          ...state.projectDraftThreadIdByProjectId,
          [mappingKey]: threadId,
        };
        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
          [threadId]: nextDraftThread,
        };
        const cleanedDrafts =
          previousThreadIdForProject === threadId
            ? {
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
              }
            : removeDraftThreadIfUnmapped({
                threadId: previousThreadIdForProject,
                projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
                getDraftsByThreadId: () => get().draftsByThreadId,
              });
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    registerDraftThread: (threadId, options) => {
      if (threadId.length === 0 || options.projectId.length === 0) {
        return;
      }
      set((state) => {
        if (state.draftThreadsByThreadId[threadId]) {
          return state;
        }
        const worktreePath = options.worktreePath ?? null;
        const nextDraftThread: DraftThreadState = {
          projectId: options.projectId,
          createdAt: options.createdAt ?? new Date().toISOString(),
          runtimeMode: options.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: options.interactionMode ?? DEFAULT_INTERACTION_MODE,
          entryPoint: options.entryPoint ?? "chat",
          branch: options.branch ?? null,
          worktreePath,
          workingDirectory: options.workingDirectory ?? null,
          lastKnownPr: null,
          envMode: options.envMode ?? (worktreePath ? "worktree" : "local"),
          ...(options.isTemporary ? { isTemporary: true } : {}),
        };
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          },
        };
      });
    },
    setDraftThreadContext: (threadId, options) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextProjectId = options.projectId ?? existing.projectId;
        if (nextProjectId.length === 0) {
          return state;
        }
        const nextDraftThread = buildDraftThreadState({
          projectId: nextProjectId,
          existingThread: existing,
          options,
          createdAtMode: "preserve-existing-on-empty",
        });
        if (draftThreadStatesEqual(existing, nextDraftThread)) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
          ...removeProjectDraftMappingsForThread(state.projectDraftThreadIdByProjectId, threadId),
          [projectDraftThreadMappingKey(nextProjectId, nextDraftThread.entryPoint)]: threadId,
        };
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          },
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    moveDraftThreadToProject: (threadId, projectId, options) => {
      if (threadId.length === 0 || projectId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextDraftThread = buildDraftThreadState({
          projectId,
          existingThread: existing,
          options,
          createdAtMode: "preserve-existing-on-empty",
        });
        const targetMappingKey = projectDraftThreadMappingKey(
          projectId,
          nextDraftThread.entryPoint,
        );
        const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[targetMappingKey];
        const hasOnlyTargetMapping = Object.entries(state.projectDraftThreadIdByProjectId).every(
          ([mappingKey, mappedThreadId]) =>
            mappedThreadId !== threadId || mappingKey === targetMappingKey,
        );
        if (
          previousThreadIdForProject === threadId &&
          hasOnlyTargetMapping &&
          draftThreadStatesEqual(existing, nextDraftThread)
        ) {
          return state;
        }

        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
          ...removeProjectDraftMappingsForThread(state.projectDraftThreadIdByProjectId, threadId),
          [targetMappingKey]: threadId,
        };

        const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
          ...state.draftThreadsByThreadId,
          [threadId]: nextDraftThread,
        };
        const cleanedDrafts =
          previousThreadIdForProject === threadId
            ? {
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
              }
            : removeDraftThreadIfUnmapped({
                threadId: previousThreadIdForProject,
                projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
                draftThreadsByThreadId: nextDraftThreadsByThreadId,
                draftsByThreadId: state.draftsByThreadId,
                getDraftsByThreadId: () => get().draftsByThreadId,
              });

        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    clearProjectDraftThreadId: (projectId, entryPoint = "chat") => {
      if (projectId.length === 0) {
        return;
      }
      set((state) => {
        const mappingKey = projectDraftThreadMappingKey(projectId, entryPoint);
        const threadId = state.projectDraftThreadIdByProjectId[mappingKey];
        if (threadId === undefined) {
          return state;
        }
        const { [mappingKey]: _removed, ...restProjectMappingsRaw } =
          state.projectDraftThreadIdByProjectId;
        const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
        const cleanedDrafts = removeDraftThreadIfUnmapped({
          threadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          draftsByThreadId: state.draftsByThreadId,
          getDraftsByThreadId: () => get().draftsByThreadId,
        });
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
        };
      });
    },
    clearProjectDraftThreads: (projectId) => {
      if (projectId.length === 0) {
        return;
      }
      set((state) => {
        const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
        const removedThreadIds = new Set<ThreadId>();
        for (const [mappingKey, threadId] of Object.entries(
          state.projectDraftThreadIdByProjectId,
        )) {
          if (projectIdFromDraftThreadMappingKey(mappingKey) === projectId) {
            removedThreadIds.add(threadId);
            continue;
          }
          nextProjectDraftThreadIdByProjectId[mappingKey] = threadId;
        }
        if (removedThreadIds.size === 0) {
          return state;
        }
        let cleanedDrafts = {
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          draftsByThreadId: state.draftsByThreadId,
        };
        for (const threadId of removedThreadIds) {
          cleanedDrafts = removeDraftThreadIfUnmapped({
            threadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            getDraftsByThreadId: () => get().draftsByThreadId,
          });
        }
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    clearProjectDraftThreadById: (projectId, threadId) => {
      if (projectId.length === 0 || threadId.length === 0) {
        return;
      }
      set((state) => {
        const matchingMappingKey = Object.entries(state.projectDraftThreadIdByProjectId).find(
          ([mappingKey, mappedThreadId]) =>
            projectIdFromDraftThreadMappingKey(mappingKey) === projectId &&
            mappedThreadId === threadId,
        )?.[0];
        if (!matchingMappingKey) {
          return state;
        }
        const { [matchingMappingKey]: _removed, ...restProjectMappingsRaw } =
          state.projectDraftThreadIdByProjectId;
        const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
        const cleanedDrafts = removeDraftThreadIfUnmapped({
          threadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          draftsByThreadId: state.draftsByThreadId,
          getDraftsByThreadId: () => get().draftsByThreadId,
        });
        return {
          draftsByThreadId: cleanedDrafts.draftsByThreadId,
          draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: restProjectMappings,
        };
      });
    },
    markDraftThreadPromoting: (threadId, promotedTo) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadId[threadId];
        if (!existing) {
          return state;
        }
        const nextPromotedTo = promotedTo ?? threadId;
        if (existing.promotedTo === nextPromotedTo) {
          return state;
        }
        return {
          draftThreadsByThreadId: {
            ...state.draftThreadsByThreadId,
            [threadId]: {
              ...existing,
              promotedTo: nextPromotedTo,
            },
          },
        };
      });
    },
    finalizePromotedDraftThread: (threadId) => {
      const draftThread = get().draftThreadsByThreadId[threadId];
      if (!draftThread?.promotedTo) {
        return;
      }
      get().clearDraftThread(threadId);
    },
    clearDraftThread: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      const removedDraft = get().draftsByThreadId[threadId];
      revokeDraftPreviewUrls(removedDraft);
      deleteDraftComposerImageBlobs(removedDraft, () => get().draftsByThreadId);
      set((state) => {
        const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
        const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
          threadId,
        );
        const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
        if (!hasDraftThread && !hasProjectMapping && !hasComposerDraft) {
          return state;
        }
        const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
          Object.entries(state.projectDraftThreadIdByProjectId).filter(
            ([, draftThreadId]) => draftThreadId !== threadId,
          ),
        ) as Record<string, ThreadId>;
        const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
          state.draftThreadsByThreadId;
        const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } =
          state.draftsByThreadId;
        return {
          draftsByThreadId: restDraftsByThreadId,
          draftThreadsByThreadId: restDraftThreadsByThreadId,
          projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
        };
      });
    },
    setStickyModelSelection: (modelSelection) => {
      const rawNormalized = normalizeModelSelection(modelSelection);
      const normalized = rawNormalized ? stripNonStickyModelOptions(rawNormalized) : null;
      set((state) => {
        if (!normalized) {
          return state;
        }
        const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
          ...state.stickyModelSelectionByProvider,
          [normalized.provider]: normalized,
        };
        if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
          return state.stickyActiveProvider === normalized.provider
            ? state
            : { stickyActiveProvider: normalized.provider };
        }
        return {
          stickyModelSelectionByProvider: nextMap,
          stickyActiveProvider: normalized.provider,
        };
      });
    },
    applyStickyState: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const stickyMap = state.stickyModelSelectionByProvider;
        const stickyActiveProvider = state.stickyActiveProvider;
        if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
          return state;
        }
        const existing = state.draftsByThreadId[threadId];
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const [provider, selection] of Object.entries(stickyMap)) {
          if (selection) {
            const current = nextMap[provider as ProviderKind];
            nextMap[provider as ProviderKind] =
              current && current.model !== selection.model ? current : selection;
          }
        }
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === stickyActiveProvider
        ) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: stickyActiveProvider,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setPrompt: (threadId, prompt) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setPromptHistorySavedDraft: (threadId, savedDraft) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if ((existing?.promptHistorySavedDraft ?? null) === savedDraft) {
          return state;
        }
        if (existing?.promptHistorySavedDraft) {
          revokePromptHistorySavedDraftPreviewUrls(existing?.promptHistorySavedDraft);
          if (savedDraft === null) {
            deletePersistedComposerImageBlobs(
              existing.promptHistorySavedDraft.persistedAttachments,
              () => get().draftsByThreadId,
            );
          }
        }
        const nextDraft: ComposerThreadDraftState = {
          ...(existing ?? createEmptyThreadDraft()),
          promptHistorySavedDraft: savedDraft,
          ...(savedDraft !== null
            ? {
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
              }
            : {}),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    restorePromptHistorySavedDraft: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const savedDraft = current?.promptHistorySavedDraft ?? null;
        if (!current || !savedDraft) {
          return state;
        }
        const restoredImageIds = new Set(savedDraft.images.map((image) => image.id));
        for (const image of current.images) {
          if (!restoredImageIds.has(image.id)) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: savedDraft.prompt,
          promptHistorySavedDraft: null,
          images: savedDraft.images,
          files: [...savedDraft.files],
          nonPersistedImageIds: [...savedDraft.nonPersistedImageIds],
          persistedAttachments: [...savedDraft.persistedAttachments],
          assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections),
          browserAnnotations: normalizeBrowserAnnotations(savedDraft.browserAnnotations),
          terminalContexts: normalizeTerminalContextsForThread(
            threadId,
            savedDraft.terminalContexts,
          ),
          fileComments: normalizeFileComments(savedDraft.fileComments),
          pastedTexts: normalizePastedTexts(savedDraft.pastedTexts),
          skills: [...savedDraft.skills],
          mentions: [...savedDraft.mentions],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addPromptHistorySavedDraftImage: (threadId, image) => {
      if (threadId.length === 0) {
        revokeObjectPreviewUrl(image.previewUrl);
        return false;
      }
      let inserted = false;
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        const savedDraft = current?.promptHistorySavedDraft ?? null;
        if (!current || !savedDraft) {
          revokeObjectPreviewUrl(image.previewUrl);
          return state;
        }
        const consumesSlot = composerImageConsumesAttachmentSlot(savedDraft, image.id);
        if (consumesSlot && availableComposerAttachmentSlots(savedDraft) === 0) {
          revokeObjectPreviewUrl(image.previewUrl);
          return state;
        }
        const images = mergeComposerImages(savedDraft.images, [image]);
        if (!images) return state;
        inserted = true;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...current,
              promptHistorySavedDraft: {
                ...savedDraft,
                images,
              },
            },
          },
        };
      });
      return inserted;
    },
    syncPromptHistorySavedDraftPersistedAttachments: (threadId, attachments) =>
      syncPersistedAttachmentsForSlot(
        threadId,
        attachments,
        get,
        set,
        PROMPT_HISTORY_ATTACHMENT_SLOT,
        flushPersistStorage,
      ),
    setTerminalContexts: (threadId, contexts) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineTerminalContextPlaceholders(
            existing.prompt,
            normalizedContexts.length,
          ),
          terminalContexts: normalizedContexts,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setSkills: (threadId, skills) => {
      if (threadId.length === 0) {
        return;
      }
      const nextSkills = [...skills];
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (Equal.equals(existing.skills, nextSkills)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          skills: nextSkills,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setMentions: (threadId, mentions) => {
      if (threadId.length === 0) {
        return;
      }
      const nextMentions = [...mentions];
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (Equal.equals(existing.mentions, nextMentions)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          mentions: nextMentions,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setModelSelection: (threadId, modelSelection) => {
      if (threadId.length === 0) {
        return;
      }
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalized === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        if (normalized) {
          const current = nextMap[normalized.provider];
          nextMap[normalized.provider] = reconcileProviderScopedModelSelection(normalized, current);
        }
        const nextActiveProvider = normalized?.provider ?? base.activeProvider;
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === nextActiveProvider
        ) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
          activeProvider: nextActiveProvider,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setModelSelectionAndSticky: (threadId, modelSelection) => {
      get().setModelSelection(threadId, modelSelection);
      const correctedSelection =
        get().draftsByThreadId[threadId]?.modelSelectionByProvider[modelSelection.provider];
      get().setStickyModelSelection(correctedSelection ?? modelSelection);
    },
    setModelOptions: (threadId, modelOptions) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedOpts = normalizeProviderModelOptions(modelOptions);
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalizedOpts === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const provider of COMPOSER_PROVIDER_KINDS) {
          // Only touch providers explicitly present in the input
          if (!normalizedOpts || !(provider in normalizedOpts)) continue;
          const opts = normalizedOpts[provider];
          const current = nextMap[provider];
          if (opts) {
            const model = current?.model ?? getDefaultModel(provider);
            if (!model) continue;
            nextMap[provider] = makeModelSelection(
              provider,
              model,
              opts,
              current?.provider === "claudeAgent" ? current.supportsAutoMode : undefined,
            );
          } else if (current?.options) {
            // Remove options but keep the selection
            nextMap[provider] = buildModelSelection(
              provider,
              current.model,
              undefined,
              current.provider === "claudeAgent" ? current.supportsAutoMode : undefined,
            );
          }
        }
        if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setProviderModelOptions: (threadId, provider, nextProviderOptions, options) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedProvider = normalizeProviderKind(provider);
      if (normalizedProvider === null) {
        return;
      }
      // Normalize just this provider's options
      const normalizedOpts = normalizeProviderModelOptions(
        { [normalizedProvider]: nextProviderOptions },
        normalizedProvider,
      );
      const providerOpts = normalizedOpts?.[normalizedProvider];
      const fallbackModel =
        normalizeModelSlug(options?.model, normalizedProvider) ??
        getDefaultModel(normalizedProvider);

      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        const base = existing ?? createEmptyThreadDraft();

        // Update the map entry for this provider
        const nextMap = { ...base.modelSelectionByProvider };
        const currentForProvider = nextMap[normalizedProvider];
        if (providerOpts) {
          const nextModel = currentForProvider?.model ?? fallbackModel;
          if (!nextModel) {
            return state;
          }
          nextMap[normalizedProvider] = makeModelSelection(
            normalizedProvider,
            nextModel,
            providerOpts,
            currentForProvider?.provider === "claudeAgent"
              ? currentForProvider.supportsAutoMode
              : undefined,
          );
        } else if (currentForProvider?.options) {
          nextMap[normalizedProvider] = buildModelSelection(
            normalizedProvider,
            currentForProvider.model,
            undefined,
            currentForProvider.provider === "claudeAgent"
              ? currentForProvider.supportsAutoMode
              : undefined,
          );
        }

        // Handle sticky persistence
        let nextStickyMap = state.stickyModelSelectionByProvider;
        let nextStickyActiveProvider = state.stickyActiveProvider;
        if (options?.persistSticky === true) {
          nextStickyMap = { ...state.stickyModelSelectionByProvider };
          const stickyBase =
            nextStickyMap[normalizedProvider] ??
            base.modelSelectionByProvider[normalizedProvider] ??
            (fallbackModel ? makeModelSelection(normalizedProvider, fallbackModel) : null);
          if (!stickyBase) {
            return state;
          }
          if (providerOpts) {
            nextStickyMap[normalizedProvider] = stripNonStickyModelOptions(
              makeModelSelection(
                normalizedProvider,
                stickyBase.model,
                providerOpts,
                stickyBase.provider === "claudeAgent" ? stickyBase.supportsAutoMode : undefined,
              ),
            );
          } else if (stickyBase.options) {
            nextStickyMap[normalizedProvider] = buildModelSelection(
              normalizedProvider,
              stickyBase.model,
              undefined,
              stickyBase.provider === "claudeAgent" ? stickyBase.supportsAutoMode : undefined,
            );
          }
          nextStickyActiveProvider = base.activeProvider ?? normalizedProvider;
        }

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
          state.stickyActiveProvider === nextStickyActiveProvider
        ) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }

        return {
          draftsByThreadId: nextDraftsByThreadId,
          ...(options?.persistSticky === true
            ? {
                stickyModelSelectionByProvider: nextStickyMap,
                stickyActiveProvider: nextStickyActiveProvider,
              }
            : {}),
        };
      });
    },
    setRuntimeMode: (threadId, runtimeMode) => {
      if (threadId.length === 0) {
        return;
      }
      const nextRuntimeMode = Schema.is(RuntimeMode)(runtimeMode) ? runtimeMode : null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && nextRuntimeMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.runtimeMode === nextRuntimeMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          runtimeMode: nextRuntimeMode,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setInteractionMode: (threadId, interactionMode) => {
      if (threadId.length === 0) {
        return;
      }
      const nextInteractionMode =
        interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && nextInteractionMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.interactionMode === nextInteractionMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          interactionMode: nextInteractionMode,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    // Keep queued follow-ups with the thread draft so route changes do not hide them.
    enqueueQueuedTurn: (threadId, queuedTurn) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              queuedTurns: [...existing.queuedTurns, queuedTurn],
            },
          },
        };
      });
    },
    insertQueuedTurn: (threadId, queuedTurn, index) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const boundedIndex = Math.max(0, Math.min(existing.queuedTurns.length, index));
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              queuedTurns: [
                ...existing.queuedTurns.slice(0, boundedIndex),
                queuedTurn,
                ...existing.queuedTurns.slice(boundedIndex),
              ],
            },
          },
        };
      });
    },
    removeQueuedTurn: (threadId, queuedTurnId) => {
      if (threadId.length === 0 || queuedTurnId.length === 0) {
        return;
      }
      const removedQueuedTurn = get().draftsByThreadId[threadId]?.queuedTurns.find(
        (entry) => entry.id === queuedTurnId,
      );
      if (removedQueuedTurn) {
        revokeQueuedTurnPreviewUrls(removedQueuedTurn);
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.queuedTurns.every((entry) => entry.id !== queuedTurnId)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          queuedTurns: current.queuedTurns.filter((entry) => entry.id !== queuedTurnId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addImage: (threadId, image) => {
      if (threadId.length === 0) {
        revokeObjectPreviewUrl(image.previewUrl);
        return false;
      }
      return get().addImages(threadId, [image]) === 1;
    },
    addImages: (threadId, images) => {
      if (threadId.length === 0 || images.length === 0) {
        for (const image of images) revokeObjectPreviewUrl(image.previewUrl);
        return 0;
      }
      let insertedCount = 0;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        let mergedImages = existing.images;
        let attachmentCount = effectiveComposerAttachmentCount(existing);
        for (const image of images) {
          const consumesSlot = composerImageConsumesAttachmentSlot(existing, image.id);
          if (consumesSlot && attachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
            revokeObjectPreviewUrl(image.previewUrl);
            continue;
          }
          const nextImages = mergeComposerImages(mergedImages, [image]);
          if (!nextImages) continue;
          mergedImages = nextImages;
          insertedCount += 1;
          if (consumesSlot) attachmentCount += 1;
        }
        if (insertedCount === 0) return state;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              images: mergedImages,
            },
          },
        };
      });
      return insertedCount;
    },
    removeImage: (threadId, imageId) => {
      if (threadId.length === 0) {
        return;
      }
      const existing = get().draftsByThreadId[threadId];
      if (!existing) {
        return;
      }
      const removedImage = existing.images.find((image) => image.id === imageId);
      const removedPersistedAttachment = existing.persistedAttachments.find(
        (attachment) => attachment.id === imageId,
      );
      if (removedImage) {
        revokeObjectPreviewUrl(removedImage.previewUrl);
      }
      if (removedPersistedAttachment) {
        deletePersistedComposerImageBlobs(
          [removedPersistedAttachment],
          () => get().draftsByThreadId,
        );
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          images: current.images.filter((image) => image.id !== imageId),
          nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
          persistedAttachments: current.persistedAttachments.filter(
            (attachment) => attachment.id !== imageId,
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    removeAppSnapCapture: (captureId) => {
      if (captureId.length === 0) return;

      const currentDrafts = get().draftsByThreadId;
      const removedImages: ComposerImageAttachment[] = [];
      const removedAttachments: PersistedComposerImageAttachment[] = [];
      for (const draft of Object.values(currentDrafts)) {
        removedImages.push(
          ...draft.images.filter((image) =>
            isComposerAppSnapCaptureSource(image.source, captureId),
          ),
          ...(draft.promptHistorySavedDraft?.images.filter((image) =>
            isComposerAppSnapCaptureSource(image.source, captureId),
          ) ?? []),
        );
        removedAttachments.push(
          ...draft.persistedAttachments.filter((attachment) =>
            isComposerAppSnapCaptureSource(attachment.source, captureId),
          ),
          ...(draft.promptHistorySavedDraft?.persistedAttachments.filter((attachment) =>
            isComposerAppSnapCaptureSource(attachment.source, captureId),
          ) ?? []),
        );
      }
      for (const image of removedImages) {
        revokeObjectPreviewUrl(image.previewUrl);
      }
      deletePersistedComposerImageBlobs(removedAttachments, () => get().draftsByThreadId);

      set((state) => {
        let changed = false;
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        for (const [rawThreadId, current] of Object.entries(state.draftsByThreadId)) {
          const removedCurrentIds = new Set([
            ...current.images
              .filter((image) => isComposerAppSnapCaptureSource(image.source, captureId))
              .map((image) => image.id),
            ...current.persistedAttachments
              .filter((attachment) => isComposerAppSnapCaptureSource(attachment.source, captureId))
              .map((attachment) => attachment.id),
          ]);
          const savedDraft = current.promptHistorySavedDraft;
          const removedSavedIds = new Set([
            ...(savedDraft?.images
              .filter((image) => isComposerAppSnapCaptureSource(image.source, captureId))
              .map((image) => image.id) ?? []),
            ...(savedDraft?.persistedAttachments
              .filter((attachment) => isComposerAppSnapCaptureSource(attachment.source, captureId))
              .map((attachment) => attachment.id) ?? []),
          ]);
          if (removedCurrentIds.size === 0 && removedSavedIds.size === 0) continue;

          changed = true;
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            images: current.images.filter((image) => !removedCurrentIds.has(image.id)),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => !removedCurrentIds.has(attachment.id),
            ),
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (imageId) => !removedCurrentIds.has(imageId),
            ),
            ...(savedDraft
              ? {
                  promptHistorySavedDraft: {
                    ...savedDraft,
                    images: savedDraft.images.filter((image) => !removedSavedIds.has(image.id)),
                    persistedAttachments: savedDraft.persistedAttachments.filter(
                      (attachment) => !removedSavedIds.has(attachment.id),
                    ),
                    nonPersistedImageIds: savedDraft.nonPersistedImageIds.filter(
                      (imageId) => !removedSavedIds.has(imageId),
                    ),
                  },
                }
              : {}),
          };
          const threadId = rawThreadId as ThreadId;
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
        }
        return changed ? { draftsByThreadId: nextDraftsByThreadId } : state;
      });
    },
    addFiles: (threadId, files) => {
      if (threadId.length === 0 || files.length === 0) {
        return 0;
      }
      let insertedCount = 0;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        let availableSlots = availableComposerAttachmentSlots(existing);
        const existingIds = new Set(existing.files.map((file) => file.id));
        const existingDedupKeys = new Set(existing.files.map((file) => composerFileDedupKey(file)));
        const dedupedIncoming: ComposerFileAttachment[] = [];
        for (const file of files) {
          if (availableSlots === 0) break;
          const dedupKey = composerFileDedupKey(file);
          if (existingIds.has(file.id) || existingDedupKeys.has(dedupKey)) {
            continue;
          }
          dedupedIncoming.push(file);
          availableSlots -= 1;
          existingIds.add(file.id);
          existingDedupKeys.add(dedupKey);
        }
        if (dedupedIncoming.length === 0) {
          return state;
        }
        insertedCount = dedupedIncoming.length;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              files: [...existing.files, ...dedupedIncoming],
            },
          },
        };
      });
      return insertedCount;
    },
    removeFile: (threadId, fileId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          files: current.files.filter((file) => file.id !== fileId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addAssistantSelection: (threadId, selection) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedSelection = normalizeAssistantSelection(selection);
        if (!normalizedSelection) {
          return state;
        }
        const dedupKey = assistantSelectionDedupKey(normalizedSelection);
        if (
          existing.assistantSelections.some((entry) => entry.id === normalizedSelection.id) ||
          existing.assistantSelections.some(
            (entry) => assistantSelectionDedupKey(entry) === dedupKey,
          )
        ) {
          return state;
        }
        if (availableComposerAttachmentSlots(existing) === 0) {
          return state;
        }
        inserted = true;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              assistantSelections: [...existing.assistantSelections, normalizedSelection],
            },
          },
        };
      });
      return inserted;
    },
    removeAssistantSelection: (threadId, selectionId) => {
      if (threadId.length === 0 || selectionId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          assistantSelections: current.assistantSelections.filter(
            (selection) => selection.id !== selectionId,
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearAssistantSelections: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.assistantSelections.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          assistantSelections: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addBrowserAnnotation: (threadId, annotation) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (
          existing.browserAnnotations.length >= BROWSER_ANNOTATION_MAX_COUNT ||
          existing.browserAnnotations.some((entry) => entry.id === annotation.id)
        ) {
          return state;
        }
        const normalized = normalizeBrowserAnnotation({
          ...annotation,
          ordinal: nextBrowserAnnotationOrdinal(existing.browserAnnotations),
        });
        if (!normalized) {
          return state;
        }
        inserted = true;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              browserAnnotations: [...existing.browserAnnotations, normalized],
            },
          },
        };
      });
      return inserted;
    },
    addBrowserAnnotations: (threadId, annotations) => {
      if (threadId.length === 0 || annotations.length === 0) {
        return 0;
      }
      let insertedCount = 0;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextAnnotations = [...existing.browserAnnotations];
        const ids = new Set(nextAnnotations.map((annotation) => annotation.id));
        const preserveBatchOrdinals = existing.browserAnnotations.length === 0;
        const ordinals = new Set(nextAnnotations.map((annotation) => annotation.ordinal));
        for (const annotation of annotations) {
          if (nextAnnotations.length >= BROWSER_ANNOTATION_MAX_COUNT) {
            break;
          }
          if (ids.has(annotation.id)) {
            continue;
          }
          const requestedOrdinal =
            preserveBatchOrdinals &&
            typeof annotation.ordinal === "number" &&
            Number.isFinite(annotation.ordinal) &&
            annotation.ordinal >= 1 &&
            !ordinals.has(Math.floor(annotation.ordinal))
              ? Math.floor(annotation.ordinal)
              : nextBrowserAnnotationOrdinal(nextAnnotations);
          const normalized = normalizeBrowserAnnotation({
            ...annotation,
            ordinal: requestedOrdinal,
          });
          if (!normalized) {
            continue;
          }
          nextAnnotations.push(normalized);
          ids.add(normalized.id);
          ordinals.add(normalized.ordinal);
          insertedCount += 1;
        }
        if (insertedCount === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              browserAnnotations: nextAnnotations,
            },
          },
        };
      });
      return insertedCount;
    },
    removeBrowserAnnotation: (threadId, annotationId) => {
      if (threadId.length === 0 || annotationId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.browserAnnotations.every((entry) => entry.id !== annotationId)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          browserAnnotations: current.browserAnnotations.filter(
            (annotation) => annotation.id !== annotationId,
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearBrowserAnnotations: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.browserAnnotations.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          browserAnnotations: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addFileComment: (threadId, comment) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedComment = normalizeFileComment(comment);
        if (!normalizedComment) {
          return state;
        }
        const dedupKey = fileCommentDedupKey(normalizedComment);
        if (
          existing.fileComments.some((entry) => entry.id === normalizedComment.id) ||
          existing.fileComments.some((entry) => fileCommentDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              fileComments: [...existing.fileComments, normalizedComment],
            },
          },
        };
      });
      return inserted;
    },
    removeFileComment: (threadId, commentId) => {
      if (threadId.length === 0 || commentId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          fileComments: current.fileComments.filter((comment) => comment.id !== commentId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearFileComments: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.fileComments.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          fileComments: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addPastedTexts: (threadId, pastedTexts) => {
      if (threadId.length === 0 || pastedTexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const acceptedPastedTexts = normalizePastedTexts([
          ...existing.pastedTexts,
          ...pastedTexts,
        ]).slice(existing.pastedTexts.length);
        if (acceptedPastedTexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              pastedTexts: [...existing.pastedTexts, ...acceptedPastedTexts],
            },
          },
        };
      });
    },
    removePastedText: (threadId, pastedTextId) => {
      if (threadId.length === 0 || pastedTextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          pastedTexts: current.pastedTexts.filter((pasted) => pasted.id !== pastedTextId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearPastedTexts: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.pastedTexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          pastedTexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    insertTerminalContext: (threadId, prompt, context, index) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);
        if (!normalizedContext) {
          return state;
        }
        const dedupKey = terminalContextDedupKey(normalizedContext);
        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: nextDraft,
          },
        };
      });
      return inserted;
    },
    addTerminalContext: (threadId, context) => {
      if (threadId.length === 0) {
        return;
      }
      get().addTerminalContexts(threadId, [context]);
    },
    addTerminalContexts: (threadId, contexts) => {
      if (threadId.length === 0 || contexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);
        if (acceptedContexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                existing.terminalContexts.length + acceptedContexts.length,
              ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },
    removeTerminalContext: (threadId, contextId) => {
      if (threadId.length === 0 || contextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearTerminalContexts: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.terminalContexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearPersistedAttachments: (threadId) => {
      if (threadId.length === 0) {
        return;
      }
      const existing = get().draftsByThreadId[threadId];
      if (existing) {
        deletePersistedComposerImageBlobs(
          existing.persistedAttachments,
          () => get().draftsByThreadId,
        );
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          persistedAttachments: [],
          nonPersistedImageIds: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    syncPersistedAttachments: (threadId, attachments) =>
      syncPersistedAttachmentsForSlot(
        threadId,
        attachments,
        get,
        set,
        DRAFT_ATTACHMENT_SLOT,
        flushPersistStorage,
      ),
    copyTransferableComposerState: (sourceThreadId, targetThreadId) => {
      if (sourceThreadId.length === 0 || targetThreadId.length === 0) {
        return;
      }
      set((state) => {
        const sourceDraft = state.draftsByThreadId[sourceThreadId];
        if (!sourceDraft) {
          return state;
        }
        const nextDraft = buildTransferredComposerDraft({
          sourceDraft,
          targetDraft: state.draftsByThreadId[targetThreadId],
          targetThreadId,
        });
        const currentTargetDraft = state.draftsByThreadId[targetThreadId];
        if (Equal.equals(currentTargetDraft, nextDraft)) {
          return state;
        }
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[targetThreadId];
        } else {
          nextDraftsByThreadId[targetThreadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setRestoredSourceProposedPlan: (threadId, source) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          restoredSourceProposedPlan: source,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearComposerContent: (threadId, options) => {
      if (threadId.length === 0) {
        return;
      }
      const clearedDraft = get().draftsByThreadId[threadId];
      deleteDraftComposerImageBlobs(clearedDraft, () => get().draftsByThreadId);
      if (options?.preservePreviewUrls !== true) {
        revokeDraftComposerImagePreviewUrls(clearedDraft);
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
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
          restoredSourceProposedPlan: null,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
  });
