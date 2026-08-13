// FILE: AppSnapCoordinator.tsx
// Purpose: Routes native macOS AppSnaps into the correct Synara composer draft.
// Layer: Root web coordinator
// Depends on: Desktop bridge, focused chat context, and existing composer attachment intake.

import {
  type DesktopAppSnapCapture,
  type DesktopAppSnapShortcut,
  type ThreadId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { useAppSettings } from "../appSettings";
import {
  type AppSnapThreadTarget,
  type TimedAppSnapThreadTarget,
  didAppSnapHydrationInputsChange,
  hasHydratedAppSnapCapture,
  hasPersistedAppSnapCapture,
  persistedAppSnapCaptureBlobKeys,
  resolveAppSnapTarget,
} from "../appSnap.logic";
import {
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  isComposerImageBlobReferenced,
  useComposerDraftStore,
} from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { useFocusedChatContext } from "../focusedChatContext";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import {
  effectiveComposerAttachmentCount,
  prepareComposerImageAttachmentsFromFiles,
} from "../lib/composerSend";
import {
  deleteComposerImageBlob,
  deleteOrphanedComposerImageBlobs,
  persistComposerImageBlob,
  readComposerImageBlob,
} from "../lib/composerImageBlobStore";
import { persistAppSnapIcon, readAppSnapIcon } from "../lib/appSnapIconStore";
import { playAppSnapCaptureSound } from "../lib/appSnapSound";
import {
  type ComposerAppSnapSource,
  isComposerAppSnapCaptureSource,
} from "../lib/composerImageSource";
import { resolveRecentThreadSplitActivation } from "../recentViewActivation.logic";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";

const MAX_REMEMBERED_CAPTURE_IDS = 100;

interface PersistedAppSnapHydrationTarget {
  attachments: ReadonlyArray<PersistedComposerImageAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  hasAttachment: (attachmentId: string) => boolean;
  addImage: (image: ComposerImageAttachment) => void;
  removeAttachment: (attachmentId: string) => Promise<unknown>;
}

function captureTimestampMs(capture: DesktopAppSnapCapture): number {
  const parsed = Date.parse(capture.capturedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isThreadAvailable(threadId: ThreadId): boolean {
  const state = useStore.getState();
  if (state.sidebarThreadSummaryById[threadId]) return true;
  if (state.threadShellById?.[threadId]) return true;
  const draftState = useComposerDraftStore.getState();
  return Boolean(
    draftState.draftsByThreadId[threadId] || draftState.draftThreadsByThreadId[threadId],
  );
}

function rememberCaptureId(captureIds: Map<string, true>, captureId: string): boolean {
  if (captureIds.has(captureId)) return false;
  captureIds.set(captureId, true);
  while (captureIds.size > MAX_REMEMBERED_CAPTURE_IDS) {
    const oldest = captureIds.keys().next().value as string | undefined;
    if (!oldest) break;
    captureIds.delete(oldest);
  }
  return true;
}

async function sourceWithCachedIcon(source: ComposerAppSnapSource): Promise<ComposerAppSnapSource> {
  const bundleIdentifier = source.bundleIdentifier?.trim() || null;
  if (!bundleIdentifier) return source;
  if (source.appIconDataUrl) {
    await persistAppSnapIcon({
      bundleIdentifier,
      dataUrl: source.appIconDataUrl,
    }).catch((error) => console.warn("[appsnap] Could not cache source app icon", error));
    return source;
  }
  const appIconDataUrl = await readAppSnapIcon(bundleIdentifier).catch((error) => {
    console.warn("[appsnap] Could not restore source app icon", error);
    return null;
  });
  return appIconDataUrl ? { ...source, appIconDataUrl } : source;
}

// Kept at module scope so its try/finally stays out of the compiled coordinator.
// `blobHydrationInFlight` and `isDisposed` are the coordinator's mutable cells,
// passed in so the routine can dedupe in-flight blobs and bail after unmount.
async function hydratePersistedAppSnaps(
  captureId: string | undefined,
  blobHydrationInFlight: Set<string>,
  isDisposed: () => boolean,
): Promise<void> {
  const draftStore = useComposerDraftStore.getState();
  for (const [rawThreadId, draft] of Object.entries(draftStore.draftsByThreadId)) {
    const threadId = rawThreadId as ThreadId;
    const targets: PersistedAppSnapHydrationTarget[] = [
      {
        attachments: draft.persistedAttachments,
        images: draft.images,
        hasAttachment: (attachmentId) =>
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.persistedAttachments.some(
              (attachment) => attachment.id === attachmentId,
            ) ?? false,
        addImage: (image) => useComposerDraftStore.getState().addImage(threadId, image),
        removeAttachment: (attachmentId) => {
          const latestAttachments =
            useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
          return useComposerDraftStore.getState().syncPersistedAttachments(
            threadId,
            latestAttachments.filter((attachment) => attachment.id !== attachmentId),
          );
        },
      },
    ];
    if (draft.promptHistorySavedDraft) {
      targets.push({
        attachments: draft.promptHistorySavedDraft.persistedAttachments,
        images: draft.promptHistorySavedDraft.images,
        hasAttachment: (attachmentId) =>
          useComposerDraftStore
            .getState()
            .draftsByThreadId[threadId]?.promptHistorySavedDraft?.persistedAttachments.some(
              (attachment) => attachment.id === attachmentId,
            ) ?? false,
        addImage: (image) =>
          useComposerDraftStore.getState().addPromptHistorySavedDraftImage(threadId, image),
        removeAttachment: (attachmentId) => {
          const latestAttachments =
            useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
              ?.persistedAttachments ?? [];
          return useComposerDraftStore.getState().syncPromptHistorySavedDraftPersistedAttachments(
            threadId,
            latestAttachments.filter((attachment) => attachment.id !== attachmentId),
          );
        },
      });
    }

    for (const target of targets) {
      const existingImageIds = new Set(target.images.map((image) => image.id));
      for (const attachment of target.attachments) {
        if (
          !attachment.blobKey ||
          attachment.source?.kind !== "appsnap" ||
          (captureId !== undefined &&
            !isComposerAppSnapCaptureSource(attachment.source, captureId)) ||
          existingImageIds.has(attachment.id) ||
          blobHydrationInFlight.has(attachment.blobKey)
        ) {
          continue;
        }
        blobHydrationInFlight.add(attachment.blobKey);
        try {
          const [file, source] = await Promise.all([
            readComposerImageBlob(attachment.blobKey),
            sourceWithCachedIcon(attachment.source),
          ]);
          if (!file) {
            await target.removeAttachment(attachment.id);
            continue;
          }
          if (isDisposed() || !target.hasAttachment(attachment.id)) continue;
          target.addImage({
            type: "image",
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: URL.createObjectURL(file),
            file,
            source,
          });
          existingImageIds.add(attachment.id);
        } catch (error) {
          console.warn("[appsnap] Could not restore persisted AppSnap", error);
        } finally {
          blobHydrationInFlight.delete(attachment.blobKey);
        }
      }
    }
  }
}

export function AppSnapCoordinator() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const { handleNewChat } = useHandleNewChat();
  const { focusedThreadId, splitView } = useFocusedChatContext();
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const focusedTargetRef = useRef<AppSnapThreadTarget | null>(null);
  const lastInteractionRef = useRef<TimedAppSnapThreadTarget | null>(null);
  const lastAppSnapRef = useRef<TimedAppSnapThreadTarget | null>(null);
  const captureIdsRef = useRef(new Map<string, true>());
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const blobHydrationInFlightRef = useRef(new Set<string>());
  const hydratePersistedAppSnapsRef = useRef<(captureId?: string) => Promise<void>>(async () => {});
  const attachCaptureRef = useRef<
    ((capture: DesktopAppSnapCapture) => Promise<"persisted" | "unverified">) | null
  >(null);
  // Read through a ref so toggling the sound preference doesn't resubscribe the
  // capture listener (which would re-deliver pending captures).
  const playCaptureSoundRef = useRef(settings.appSnapPlaySound);
  const enableAppSnapRef = useRef(settings.enableAppSnap);
  useEffect(() => {
    playCaptureSoundRef.current = settings.appSnapPlaySound;
    enableAppSnapRef.current = settings.enableAppSnap;
  }, [settings.appSnapPlaySound, settings.enableAppSnap]);

  useEffect(() => {
    let disposed = false;

    let hydrationQueue = Promise.resolve();
    const enqueueHydration = (captureId?: string) => {
      const hydration = hydrationQueue.then(() =>
        hydratePersistedAppSnaps(captureId, blobHydrationInFlightRef.current, () => disposed),
      );
      hydrationQueue = hydration.catch(() => undefined);
      return hydration;
    };
    hydratePersistedAppSnapsRef.current = enqueueHydration;

    void enqueueHydration().then(() => {
      if (disposed) return;
      void deleteOrphanedComposerImageBlobs({
        isReferenced: (blobKey) =>
          blobHydrationInFlightRef.current.has(blobKey) ||
          isComposerImageBlobReferenced(useComposerDraftStore.getState().draftsByThreadId, blobKey),
      }).catch((error) =>
        console.warn("[appsnap] Could not sweep orphaned composer images", error),
      );
    });
    const unsubscribe = useComposerDraftStore.subscribe((state, previousState) => {
      if (didAppSnapHydrationInputsChange(state.draftsByThreadId, previousState.draftsByThreadId)) {
        void enqueueHydration();
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      hydratePersistedAppSnapsRef.current = async () => {};
    };
  }, []);

  useEffect(() => {
    const nextTarget = focusedThreadId
      ? {
          threadId: focusedThreadId,
          ...(splitView?.id ? { splitViewId: splitView.id } : {}),
        }
      : null;
    focusedTargetRef.current = nextTarget;
    if (nextTarget) {
      lastInteractionRef.current = { ...nextTarget, atMs: Date.now() };
    }
  }, [focusedThreadId, splitView?.id]);

  useEffect(() => {
    const recordInteraction = () => {
      const target = focusedTargetRef.current;
      if (target) lastInteractionRef.current = { ...target, atMs: Date.now() };
    };
    window.addEventListener("pointerdown", recordInteraction, { capture: true });
    window.addEventListener("keydown", recordInteraction, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", recordInteraction, { capture: true });
      window.removeEventListener("keydown", recordInteraction, { capture: true });
    };
  }, []);

  // Settings objects are re-decoded from localStorage on every write, so key
  // this effect on the chord's primitive fields rather than object identity.
  const shortcutModifier =
    settings.appSnapShortcut.kind === "key-chord" ? settings.appSnapShortcut.modifier : null;
  const shortcutKey =
    settings.appSnapShortcut.kind === "key-chord" ? settings.appSnapShortcut.key : null;

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    const shortcut: DesktopAppSnapShortcut =
      shortcutModifier && shortcutKey
        ? { kind: "key-chord", modifier: shortcutModifier, key: shortcutKey }
        : { kind: "both-option-keys" };
    // The opt-in preference lives in the renderer settings store. This root
    // coordinator is mounted for the full UI lifetime and owns the native listener.
    // Enable even when the saved shortcut is unavailable: the manager surfaces
    // the conflict as an error state instead of AppSnap silently staying off.
    void bridge
      .setShortcut(shortcut)
      .then((result) => {
        if (!result.availability.available) {
          console.warn("[appsnap] Saved shortcut is unavailable", result.availability.reason);
        }
        return bridge.setEnabled(settings.enableAppSnap);
      })
      .catch((error) => {
        console.warn("[appsnap] Could not update native listener state", error);
      });
  }, [shortcutModifier, shortcutKey, settings.enableAppSnap]);

  const activateExistingTarget = useCallback(
    async (target: AppSnapThreadTarget) => {
      openChatThreadPage(target.threadId);
      // Same thread is only "already active" when the split pane matches too;
      // a capture aimed at another pane still needs activation below.
      const focused = focusedTargetRef.current;
      if (
        focused?.threadId === target.threadId &&
        (!target.splitViewId || focused.splitViewId === target.splitViewId)
      ) {
        return;
      }

      const splitActivation = resolveRecentThreadSplitActivation({
        view: {
          kind: "thread",
          threadId: target.threadId,
          ...(target.splitViewId ? { splitViewId: target.splitViewId } : {}),
        },
        splitViewsById: useSplitViewStore.getState().splitViewsById,
      });
      if (splitActivation) {
        useSplitViewStore
          .getState()
          .setFocusedPane(splitActivation.splitViewId, splitActivation.paneId);
      }
      await navigate({
        to: "/$threadId",
        params: { threadId: target.threadId },
        search: () => (splitActivation ? { splitViewId: splitActivation.splitViewId } : {}),
      });
    },
    [navigate, openChatThreadPage],
  );

  const attachCapture = useCallback(
    async (capture: DesktopAppSnapCapture) => {
      const captureAtMs = captureTimestampMs(capture);
      const resolvedTarget = resolveAppSnapTarget({
        captureAtMs,
        lastInteraction: lastInteractionRef.current,
        lastAppSnap: lastAppSnapRef.current,
        isThreadAvailable,
      });

      let target: AppSnapThreadTarget;
      if (resolvedTarget.kind === "existing") {
        target = resolvedTarget.target;
        await activateExistingTarget(target);
      } else {
        const result = await handleNewChat({ fresh: true });
        if (!result.ok) throw new Error(result.error);
        if (result.threadId) {
          target = { threadId: result.threadId };
          openChatThreadPage(target.threadId);
        } else {
          // A null threadId means a concurrent navigation superseded the
          // fresh-thread creation: the user actively went somewhere else, so
          // follow them there instead of failing the capture.
          const focused = focusedTargetRef.current;
          if (!focused) throw new Error("Synara could not create a task for this AppSnap.");
          target = focused;
          openChatThreadPage(target.threadId);
        }
      }

      const bytes = new Uint8Array(capture.bytes);
      if (bytes.byteLength === 0) throw new Error("The captured AppSnap is empty.");
      const file = new File([bytes], capture.name, {
        type: capture.mimeType,
        lastModified: captureAtMs,
      });
      const draftStore = useComposerDraftStore.getState();
      const draft = draftStore.draftsByThreadId[target.threadId];
      const existingAttachmentCount = effectiveComposerAttachmentCount(draft);
      const { images, error } = await prepareComposerImageAttachmentsFromFiles({
        files: [file],
        existingAttachmentCount,
      });
      const image = images[0];
      if (!image) throw new Error(error ?? "Synara could not attach the captured AppSnap.");

      let imageAddedToDraft = false;
      let blobKey: string | null = null;
      let persistenceResult: "persisted" | "unverified" = "persisted";
      try {
        const source: ComposerAppSnapSource = {
          kind: "appsnap",
          captureId: capture.id,
          capturedAt: capture.capturedAt,
          appName: capture.sourceAppName,
          bundleIdentifier: capture.sourceBundleIdentifier,
          appIconDataUrl: capture.sourceAppIconDataUrl,
          windowTitle: capture.sourceWindowTitle,
        };
        const sourceWithIcon = await sourceWithCachedIcon(source);
        const appSnapImage = { ...image, source: sourceWithIcon };
        blobKey = await persistComposerImageBlob({
          threadId: target.threadId,
          imageId: appSnapImage.id,
          file: appSnapImage.file,
        });

        // Match ordinary composer mutations: recalled prompt-history state no longer owns the draft.
        draftStore.setPromptHistorySavedDraft(target.threadId, null);
        if (!draftStore.addImage(target.threadId, appSnapImage)) {
          throw new Error(
            "The AppSnap was prepared, but this message already has the maximum number of references.",
          );
        }
        imageAddedToDraft = true;
        const currentPersistedAttachments =
          useComposerDraftStore.getState().draftsByThreadId[target.threadId]
            ?.persistedAttachments ?? [];
        const result = await draftStore.syncPersistedAttachments(target.threadId, [
          ...currentPersistedAttachments.filter((attachment) => attachment.id !== appSnapImage.id),
          {
            id: appSnapImage.id,
            name: appSnapImage.name,
            mimeType: appSnapImage.mimeType,
            sizeBytes: appSnapImage.sizeBytes,
            blobKey,
            source: sourceWithIcon,
          },
        ]);
        if (result === "rejected") {
          draftStore.removeImage(target.threadId, appSnapImage.id);
          await deleteComposerImageBlob(blobKey).catch((error) =>
            console.warn("[appsnap] Could not roll back rejected capture", error),
          );
          throw new Error("The AppSnap was captured, but its draft metadata was rejected.");
        }
        persistenceResult = result;
      } catch (error) {
        if (!imageAddedToDraft) {
          URL.revokeObjectURL(image.previewUrl);
          if (blobKey) {
            await deleteComposerImageBlob(blobKey).catch((cleanupError) =>
              console.warn("[appsnap] Could not roll back unattached capture", cleanupError),
            );
          }
        }
        throw error;
      }
      lastAppSnapRef.current = { ...target, atMs: captureAtMs };
      requestComposerFocus(target.threadId);
      toastManager.add({
        type: persistenceResult === "unverified" ? "warning" : "success",
        title:
          persistenceResult === "unverified" ? "AppSnap added with a warning" : "AppSnap added",
        description:
          persistenceResult === "unverified"
            ? "The capture is attached, but Synara could not verify its draft metadata. If it is missing after a reload, Synara will attach it again."
            : capture.sourceAppName
              ? `Captured ${capture.sourceAppName} and added it to the composer.`
              : "The frontmost window was added to the composer.",
        data: { allowCrossThreadVisibility: true },
      });
      return persistenceResult;
    },
    [activateExistingTarget, handleNewChat, openChatThreadPage],
  );
  // Keep the native subscription stable while navigation callbacks change.
  // Pending captures can then never cross a cleanup/re-subscribe dedupe gap.
  // (Mirrored in an effect: capture events only arrive post-commit.)
  useEffect(() => {
    attachCaptureRef.current = attachCapture;
  }, [attachCapture]);

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    let disposed = false;

    const enqueueCapture = (capture: DesktopAppSnapCapture) => {
      if (disposed || !rememberCaptureId(captureIdsRef.current, capture.id)) return;
      captureQueueRef.current = captureQueueRef.current
        .then(async () => {
          const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadId);
          if (hasPersistedAppSnapCapture(drafts, capture.id)) {
            // Draft metadata alone is not proof the screenshot survived: only
            // acknowledge (which deletes the desktop pending file) once the
            // persisted blob bytes are actually readable. Otherwise fall
            // through and attach the capture again from the pending bytes.
            const blobKeys = persistedAppSnapCaptureBlobKeys(drafts, capture.id);
            const blobs = await Promise.all(
              blobKeys.map((blobKey) => readComposerImageBlob(blobKey).catch(() => null)),
            );
            if (blobs.some((file) => file !== null)) {
              // Durable metadata is not enough: wait until its blob has become
              // a visible image chip before deleting the desktop recovery copy.
              await hydratePersistedAppSnapsRef.current(capture.id);
              const hydratedDrafts = Object.values(
                useComposerDraftStore.getState().draftsByThreadId,
              );
              if (hasHydratedAppSnapCapture(hydratedDrafts, capture.id)) {
                await bridge
                  .acknowledgeCapture(capture.id)
                  .catch((error) => console.warn("[appsnap] Could not acknowledge capture", error));
                return;
              }
            }
          }
          let persistence: "persisted" | "unverified";
          try {
            // Missing blob bytes make the old metadata unusable. Purge every
            // row for this capture (including prompt-history snapshots) before
            // rebuilding it from the desktop pending copy.
            useComposerDraftStore.getState().removeAppSnapCapture(capture.id);
            const attach = attachCaptureRef.current;
            if (!attach) throw new Error("The AppSnap composer is not ready yet.");
            persistence = await attach(capture);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "AppSnap could not be added",
              description: error instanceof Error ? error.message : "AppSnap capture failed.",
              actionProps: {
                children: "Retry",
                onClick: () => {
                  captureIdsRef.current.delete(capture.id);
                  enqueueCapture(capture);
                },
              },
              data: { allowCrossThreadVisibility: true },
            });
            return;
          }
          // An unverified draft may vanish on reload; keeping the capture
          // pending lets the next mount re-deliver it.
          if (persistence !== "persisted") return;
          await bridge
            .acknowledgeCapture(capture.id)
            .catch((error) => console.warn("[appsnap] Could not acknowledge capture", error));
        })
        .catch(() => undefined);
    };

    const unsubscribeCaptured = bridge.onCaptured((capture) => {
      // Shutter cue for live captures only; captures restored from the pending
      // store on mount, or replayed after a did-finish-load reload, were
      // already handled and should land silently.
      if (playCaptureSoundRef.current && !captureIdsRef.current.has(capture.id)) {
        void playAppSnapCaptureSound();
      }
      enqueueCapture(capture);
    });
    const unsubscribeError = bridge.onError((error) => {
      toastManager.add({
        type: "error",
        title: "AppSnap failed",
        description: error.message,
        ...(error.code === "helper-stopped"
          ? {
              actionProps: {
                children: "Restart",
                onClick: () => {
                  void bridge
                    .setEnabled(enableAppSnapRef.current)
                    .catch((restartError) =>
                      console.warn("[appsnap] Could not restart native listener", restartError),
                    );
                },
              },
            }
          : {}),
        data: {
          allowCrossThreadVisibility: true,
          copyText: `${error.code}: ${error.message}`,
        },
      });
    });
    void bridge
      .listPendingCaptures()
      .then((captures) => captures.forEach(enqueueCapture))
      .catch((error) => console.warn("[appsnap] Could not restore pending captures", error));

    return () => {
      disposed = true;
      unsubscribeCaptured();
      unsubscribeError();
    };
  }, []);

  return null;
}
