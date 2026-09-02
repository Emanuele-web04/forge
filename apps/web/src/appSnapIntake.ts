// FILE: appSnapIntake.ts
// Purpose: Turns a desktop AppSnap capture into a persisted composer image attachment.
// Layer: Web composer domain
// Depends on: composer draft store, composer image intake, and AppSnap icon cache.

import type { DesktopAppSnapCapture, ThreadId } from "@synara/contracts";

import { persistAppSnapIcon, readAppSnapIcon } from "./lib/appSnapIconStore";
import { deleteComposerImageBlob, persistComposerImageBlob } from "./lib/composerImageBlobStore";
import { type ComposerAppSnapSource } from "./lib/composerImageSource";
import {
  effectiveComposerAttachmentCount,
  prepareComposerImageAttachmentsFromFiles,
} from "./lib/composerSend";
import { useComposerDraftStore } from "./composerDraftStore";

export async function sourceWithCachedIcon(
  source: ComposerAppSnapSource,
): Promise<ComposerAppSnapSource> {
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

export async function insertAppSnapCaptureIntoDraft(
  threadId: ThreadId,
  capture: DesktopAppSnapCapture,
): Promise<"persisted" | "unverified"> {
  const parsedCaptureAt = Date.parse(capture.capturedAt);
  const captureAtMs = Number.isFinite(parsedCaptureAt) ? parsedCaptureAt : Date.now();
  const bytes = new Uint8Array(capture.bytes);
  if (bytes.byteLength === 0) throw new Error("The captured AppSnap is empty.");
  const file = new File([bytes], capture.name, {
    type: capture.mimeType,
    lastModified: captureAtMs,
  });
  const draftStore = useComposerDraftStore.getState();
  const draft = draftStore.draftsByThreadId[threadId];
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
      threadId,
      imageId: appSnapImage.id,
      file: appSnapImage.file,
    });

    // Match ordinary composer mutations: recalled prompt-history state no longer owns the draft.
    draftStore.setPromptHistorySavedDraft(threadId, null);
    if (!draftStore.addImage(threadId, appSnapImage)) {
      throw new Error(
        "The AppSnap was prepared, but this message already has the maximum number of references.",
      );
    }
    imageAddedToDraft = true;
    const currentPersistedAttachments =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
    const result = await draftStore.syncPersistedAttachments(threadId, [
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
      draftStore.removeImage(threadId, appSnapImage.id);
      await deleteComposerImageBlob(blobKey).catch((cleanupError) =>
        console.warn("[appsnap] Could not roll back rejected capture", cleanupError),
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
  return persistenceResult;
}
