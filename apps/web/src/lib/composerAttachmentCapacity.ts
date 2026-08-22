// FILE: composerAttachmentCapacity.ts
// Purpose: Defines the composer attachment limit as one shared, commit-time invariant.
// Layer: Web composer domain utility

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";

interface AttachmentIdCarrier {
  readonly id: string;
}

export interface ComposerAttachmentCountDraft {
  readonly images?: ReadonlyArray<AttachmentIdCarrier> | undefined;
  readonly files?: ReadonlyArray<unknown> | undefined;
  readonly assistantSelections?: ReadonlyArray<unknown> | undefined;
  readonly persistedAttachments?: ReadonlyArray<AttachmentIdCarrier> | undefined;
}

/**
 * Counts live references plus persisted images that have not hydrated yet.
 * Hydrating an image with the same id therefore consumes no additional slot.
 */
export function effectiveComposerAttachmentCount(
  draft: ComposerAttachmentCountDraft | undefined,
): number {
  if (!draft) return 0;
  const hydratedImageIds = new Set((draft.images ?? []).map((image) => image.id));
  const pendingPersistedCount = (draft.persistedAttachments ?? []).filter(
    (attachment) => !hydratedImageIds.has(attachment.id),
  ).length;
  return (
    (draft.images?.length ?? 0) +
    (draft.files?.length ?? 0) +
    (draft.assistantSelections?.length ?? 0) +
    pendingPersistedCount
  );
}

export function availableComposerAttachmentSlots(
  draft: ComposerAttachmentCountDraft | undefined,
): number {
  return Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - effectiveComposerAttachmentCount(draft));
}

export function composerImageConsumesAttachmentSlot(
  draft: ComposerAttachmentCountDraft,
  imageId: string,
): boolean {
  return !(draft.persistedAttachments ?? []).some((attachment) => attachment.id === imageId);
}
