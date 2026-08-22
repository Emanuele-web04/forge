import { describe, expect, it, vi } from "vitest";

import type { ComposerImageAttachment } from "../composerDraftStore";
import { ComposerImageIntakeQueue } from "./useComposerImageIntake";

function preparedImage(id: string): ComposerImageAttachment {
  const file = new File([id], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

describe("ComposerImageIntakeQueue", () => {
  it("waits for preparation and commits before reporting an empty queue", async () => {
    const queue = new ComposerImageIntakeQueue();
    let releasePreparation:
      | ((value: { images: ComposerImageAttachment[]; error: null }) => void)
      | undefined;
    const prepareFiles = vi.fn(
      () =>
        new Promise<{ images: ComposerImageAttachment[]; error: null }>((resolve) => {
          releasePreparation = resolve;
        }),
    );
    const commitImages = vi.fn(() => 1);
    const job = queue.enqueue({
      files: [new File(["image"], "image.png", { type: "image/png" })],
      existingAttachmentCount: () => 0,
      commitImages,
      onError: vi.fn(),
      prepareFiles,
    });

    expect(queue.pendingCount()).toBe(1);
    const waiting = queue.waitForPending();
    await Promise.resolve();
    await Promise.resolve();
    releasePreparation?.({ images: [preparedImage("ready")], error: null });
    await Promise.all([job, waiting]);

    expect(commitImages).toHaveBeenCalledOnce();
    expect(queue.pendingCount()).toBe(0);
  });

  it("revokes prepared previews and skips commit after disposal", async () => {
    const queue = new ComposerImageIntakeQueue();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;
    let releasePreparation:
      | ((value: { images: ComposerImageAttachment[]; error: null }) => void)
      | undefined;
    const commitImages = vi.fn(() => 1);
    const job = queue.enqueue({
      files: [new File(["image"], "image.png", { type: "image/png" })],
      existingAttachmentCount: () => 0,
      commitImages,
      onError: vi.fn(),
      prepareFiles: () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    });
    await Promise.resolve();
    await Promise.resolve();
    queue.dispose();
    releasePreparation?.({ images: [preparedImage("stale")], error: null });
    await job;

    expect(commitImages).not.toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:stale");
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });
});
