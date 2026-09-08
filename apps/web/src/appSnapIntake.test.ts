import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopAppSnapCapture } from "@synara/contracts";

import { insertAppSnapCaptureIntoDraft } from "./appSnapIntake";
import { useComposerDraftStore } from "./composerDraftStore";

const prepareComposerImageAttachmentsFromFiles = vi.fn();
const effectiveComposerAttachmentCount = vi.fn(() => 0);
const persistComposerImageBlob = vi.fn();
const deleteComposerImageBlob = vi.fn();
const persistAppSnapIcon = vi.fn();
const readAppSnapIcon = vi.fn();

vi.mock("./lib/composerSend", () => ({
  effectiveComposerAttachmentCount: (...args: unknown[]) =>
    effectiveComposerAttachmentCount(...(args as [])),
  prepareComposerImageAttachmentsFromFiles: (...args: unknown[]) =>
    prepareComposerImageAttachmentsFromFiles(...(args as [])),
}));
vi.mock("./lib/composerImageBlobStore", () => ({
  persistComposerImageBlob: (...args: unknown[]) => persistComposerImageBlob(...(args as [])),
  deleteComposerImageBlob: (...args: unknown[]) => deleteComposerImageBlob(...(args as [])),
  readComposerImageBlob: vi.fn(),
}));
vi.mock("./lib/appSnapIconStore", () => ({
  persistAppSnapIcon: (...args: unknown[]) => persistAppSnapIcon(...(args as [])),
  readAppSnapIcon: (...args: unknown[]) => readAppSnapIcon(...(args as [])),
}));

function preparedImage(id: string) {
  const file = new File(["image"], `${id}.png`, { type: "image/png" });
  return {
    type: "image" as const,
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function captureFixture(overrides: Partial<DesktopAppSnapCapture> = {}): DesktopAppSnapCapture {
  return {
    id: "capture-1",
    capturedAt: "2026-09-02T10:00:00.000Z",
    name: "AppSnap-capture-1.png",
    mimeType: "image/png",
    sizeBytes: 5,
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]),
    sourceAppName: "Ghostty",
    sourceBundleIdentifier: "com.mitchellh.ghostty",
    sourceAppIconDataUrl: null,
    sourceWindowTitle: "dev",
    ...overrides,
  };
}

const threadId = "thread-1" as never;

describe("insertAppSnapCaptureIntoDraft", () => {
  const setPromptHistorySavedDraft = vi.fn();
  const addImage = vi.fn((_threadId: unknown, _image: unknown) => true);
  const syncPersistedAttachments = vi.fn();
  const removeImage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    prepareComposerImageAttachmentsFromFiles.mockResolvedValue({
      images: [preparedImage("image-1")],
      error: null,
    });
    persistComposerImageBlob.mockResolvedValue("blob-key-1");
    deleteComposerImageBlob.mockResolvedValue(undefined);
    persistAppSnapIcon.mockResolvedValue(undefined);
    readAppSnapIcon.mockResolvedValue(null);
    syncPersistedAttachments.mockResolvedValue("persisted");
    vi.spyOn(useComposerDraftStore, "getState").mockReturnValue({
      draftsByThreadId: {},
      setPromptHistorySavedDraft,
      addImage,
      syncPersistedAttachments,
      removeImage,
    } as never);
  });

  it("persists the capture into the thread draft with appsnap provenance", async () => {
    await expect(insertAppSnapCaptureIntoDraft(threadId, captureFixture())).resolves.toBe(
      "persisted",
    );
    expect(addImage).toHaveBeenCalledOnce();
    expect(addImage.mock.calls[0]?.[1]).toMatchObject({
      id: "image-1",
      source: {
        kind: "appsnap",
        captureId: "capture-1",
        appName: "Ghostty",
        windowTitle: "dev",
      },
    });
    expect(syncPersistedAttachments).toHaveBeenCalledOnce();
    expect(setPromptHistorySavedDraft).toHaveBeenCalledWith(threadId, null);
  });

  it("rolls back the image and blob when the draft rejects the attachment", async () => {
    syncPersistedAttachments.mockResolvedValue("rejected");
    await expect(insertAppSnapCaptureIntoDraft(threadId, captureFixture())).rejects.toThrow(
      "draft metadata was rejected",
    );
    expect(addImage).toHaveBeenCalledWith(threadId, expect.anything());
    expect(setPromptHistorySavedDraft).toHaveBeenCalledWith(threadId, null);
    expect(removeImage).toHaveBeenCalledWith(threadId, "image-1");
    expect(deleteComposerImageBlob).toHaveBeenCalledWith("blob-key-1");
  });

  it("rolls back the prepared image when the draft is already full", async () => {
    addImage.mockReturnValue(false);
    const revokeObjectUrl = vi.fn();
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = revokeObjectUrl;
    try {
      await expect(insertAppSnapCaptureIntoDraft(threadId, captureFixture())).rejects.toThrow(
        "maximum number of references",
      );
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:image-1");
      expect(deleteComposerImageBlob).toHaveBeenCalledWith("blob-key-1");
      expect(setPromptHistorySavedDraft).not.toHaveBeenCalled();
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
