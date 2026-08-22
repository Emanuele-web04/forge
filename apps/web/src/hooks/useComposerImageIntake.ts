// FILE: useComposerImageIntake.ts
// Purpose: Serializes image preparation, exposes pending UI state, and cancels stale draft work.
// Layer: Web composer hook

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ComposerImageAttachment } from "../composerDraftStore";
import {
  prepareComposerImageAttachmentsFromFiles,
  type ComposerImageBuildResult,
} from "../lib/composerSend";

const ATTACHMENT_LIMIT_ERROR = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`;

function revokePreparedImages(images: readonly ComposerImageAttachment[]): void {
  if (typeof URL === "undefined") return;
  for (const image of images) {
    if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
  }
}

export interface ComposerImageIntakeJob {
  readonly files: readonly File[];
  readonly existingAttachmentCount: () => number;
  readonly commitImages: (images: ComposerImageAttachment[]) => number;
  readonly onError: (error: string | null) => void;
  readonly prepareFiles?:
    | ((input: {
        files: readonly File[];
        existingAttachmentCount: number;
      }) => Promise<ComposerImageBuildResult>)
    | undefined;
}

export class ComposerImageIntakeQueue {
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #pendingCount = 0;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly pendingCount = (): number => this.#pendingCount;

  enqueue(job: ComposerImageIntakeJob): Promise<void> {
    if (this.#disposed || job.files.length === 0) return Promise.resolve();
    const generation = this.#generation;
    this.#setPendingCount(this.#pendingCount + job.files.length);
    const prepareFiles = job.prepareFiles ?? prepareComposerImageAttachmentsFromFiles;
    const task = this.#tail
      .catch(() => undefined)
      .then(async () => {
        if (this.#isStale(generation)) return;
        const result = await prepareFiles({
          files: job.files,
          existingAttachmentCount: job.existingAttachmentCount(),
        });
        if (this.#isStale(generation)) {
          revokePreparedImages(result.images);
          return;
        }
        const acceptedCount = job.commitImages(result.images);
        const rejectedAtCapacity =
          acceptedCount < result.images.length &&
          job.existingAttachmentCount() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
        const error = rejectedAtCapacity ? ATTACHMENT_LIMIT_ERROR : result.error;
        job.onError(error);
      })
      .catch((cause) => {
        if (this.#isStale(generation)) return;
        job.onError(cause instanceof Error ? cause.message : "Synara could not prepare image.");
      })
      .finally(() => this.#setPendingCount(Math.max(0, this.#pendingCount - job.files.length)));
    this.#tail = task;
    return task;
  }

  async waitForPending(): Promise<void> {
    while (this.#pendingCount > 0) {
      const tail = this.#tail;
      await tail.catch(() => undefined);
      if (tail === this.#tail && this.#pendingCount === 0) return;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#listeners.clear();
  }

  #isStale(generation: number): boolean {
    return this.#disposed || generation !== this.#generation;
  }

  #setPendingCount(nextCount: number): void {
    if (nextCount === this.#pendingCount) return;
    this.#pendingCount = nextCount;
    for (const listener of this.#listeners) listener();
  }
}

export function useComposerImageIntake(input: {
  readonly threadId: ThreadId;
  readonly existingAttachmentCount: () => number;
  readonly commitImages: (images: ComposerImageAttachment[]) => number;
  readonly onError: (error: string | null) => void;
}) {
  const queue = useMemo(() => new ComposerImageIntakeQueue(), [input.threadId]);
  useEffect(() => () => queue.dispose(), [queue]);
  const pendingCount = useSyncExternalStore(
    queue.subscribe,
    queue.pendingCount,
    queue.pendingCount,
  );

  const addImages = useCallback(
    (files: readonly File[]) => {
      void queue.enqueue({
        files,
        existingAttachmentCount: input.existingAttachmentCount,
        commitImages: input.commitImages,
        onError: input.onError,
      });
    },
    [input.commitImages, input.existingAttachmentCount, input.onError, queue],
  );

  const waitForPending = useCallback(() => queue.waitForPending(), [queue]);

  return {
    addImages,
    isPreparingImages: pendingCount > 0,
    pendingImageCount: pendingCount,
    waitForPending,
  };
}
