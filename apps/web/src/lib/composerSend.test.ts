import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../composerDraftStore";
import * as composerImageBlobStore from "./composerImageBlobStore";
import {
  buildComposerFileAttachmentsFromFiles,
  buildUploadComposerAttachments,
  stageUploadComposerAttachments,
  effectiveComposerAttachmentCount,
  findPendingBlobComposerAttachments,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
  prepareComposerImageAttachmentsFromFiles,
} from "./composerSend";

describe("composerSend attachment builders", () => {
  const originalCreateObjectUrl = URL.createObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    vi.unstubAllGlobals();
  });

  it("keeps image-specific unsupported-file errors while sharing cap handling", async () => {
    const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });

    const result = await prepareComposerImageAttachmentsFromFiles({
      files: [textFile, imageFile],
      existingAttachmentCount: 0,
    });

    expect(result.error).toBe(
      "Unsupported file type for 'notes.txt'. Please attach image files only.",
    );
    expect(result.images).toEqual([
      expect.objectContaining({
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        previewUrl: "blob:screen.png",
      }),
    ]);
  });

  it("builds generic file attachments and skips images without an error", () => {
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });
    const unknownFile = new File(["data"], "payload.bin", { type: "" });

    const result = buildComposerFileAttachmentsFromFiles({
      files: [imageFile, unknownFile],
      existingAttachmentCount: 0,
    });

    expect(result.error).toBeNull();
    expect(result.files).toEqual([
      expect.objectContaining({
        type: "file",
        name: "payload.bin",
        mimeType: "application/octet-stream",
        sizeBytes: unknownFile.size,
        file: unknownFile,
      }),
    ]);
  });

  it("enforces the shared attachment count cap for generic files", () => {
    const result = buildComposerFileAttachmentsFromFiles({
      files: [new File(["data"], "notes.txt", { type: "text/plain" })],
      existingAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });

    expect(result.files).toEqual([]);
    expect(result.error).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
    );
  });

  it("does not consume an attachment slot when oversized image preparation fails", async () => {
    const unsupported = new File(["gif"], "animation.gif", { type: "image/gif" });
    Object.defineProperty(unsupported, "size", {
      configurable: true,
      value: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    });
    const valid = new File(["png"], "screen.png", { type: "image/png" });

    const result = await prepareComposerImageAttachmentsFromFiles({
      files: [unsupported, valid],
      existingAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.file).toBe(valid);
    expect(result.error).toContain("cannot be optimized automatically");
  });

  it("reads genuine empty files instead of treating them as folders", async () => {
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        error: Error | null = null;
        private readonly listeners = new Map<string, Array<() => void>>();

        addEventListener(type: string, listener: () => void) {
          const listeners = this.listeners.get(type) ?? [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }

        readAsDataURL() {
          this.result = "data:application/octet-stream;base64,";
          for (const listener of this.listeners.get("load") ?? []) {
            listener();
          }
        }
      },
    );

    await expect(readFileAsDataUrl(new File([], ".gitkeep"))).resolves.toBe(
      "data:application/octet-stream;base64,",
    );
  });

  it("uploads binary files outside RPC and returns persisted attachment ids", async () => {
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "image",
          id: "thread-1-11111111-1111-4111-8111-111111111111",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: imageFile.size,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const attachments = await buildUploadComposerAttachments({
      threadId: "thread-1",
      images: [
        {
          type: "image",
          id: "draft-image",
          name: imageFile.name,
          mimeType: imageFile.type,
          sizeBytes: imageFile.size,
          previewUrl: "blob:screen.png",
          file: imageFile,
        },
      ],
      files: [],
      assistantSelections: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/attachments/upload?"),
      expect.objectContaining({ method: "POST", body: imageFile }),
    );
    expect(attachments).toEqual([
      expect.objectContaining({ id: "thread-1-11111111-1111-4111-8111-111111111111" }),
    ]);
  });

  it("cancels an earlier staged attachment when a later sequential upload fails", async () => {
    const firstFile = new File(["one"], "one.png", { type: "image/png" });
    const secondFile = new File(["two"], "two.png", { type: "image/png" });
    const firstId = "thread-1-11111111-1111-4111-8111-111111111111";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            type: "image",
            id: firstId,
            name: firstFile.name,
            mimeType: firstFile.type,
            sizeBytes: firstFile.size,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ error: "Second upload failed." }, { status: 507 }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      stageUploadComposerAttachments({
        threadId: "thread-1",
        images: [
          {
            type: "image",
            id: "draft-one",
            name: firstFile.name,
            mimeType: firstFile.type,
            sizeBytes: firstFile.size,
            previewUrl: "blob:one.png",
            file: firstFile,
          },
          {
            type: "image",
            id: "draft-two",
            name: secondFile.name,
            mimeType: secondFile.type,
            sizeBytes: secondFile.size,
            previewUrl: "blob:two.png",
            file: secondFile,
          },
        ],
        files: [],
        assistantSelections: [],
      }),
    ).rejects.toThrow("Second upload failed.");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]).toEqual([
      expect.stringContaining("/api/attachments/cancel"),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ attachmentId: firstId }),
      }),
    ]);
  });

  it("preserves the upload failure when best-effort cancellation also fails", async () => {
    const firstFile = new File(["one"], "one.png", { type: "image/png" });
    const secondFile = new File(["two"], "two.png", { type: "image/png" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            type: "image",
            id: "thread-1-11111111-1111-4111-8111-111111111111",
            name: firstFile.name,
            mimeType: firstFile.type,
            sizeBytes: firstFile.size,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ error: "Original upload failure." }, { status: 500 }))
      .mockRejectedValueOnce(new Error("Cancellation transport failed."));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      stageUploadComposerAttachments({
        threadId: "thread-1",
        images: [
          {
            type: "image",
            id: "draft-one",
            name: firstFile.name,
            mimeType: firstFile.type,
            sizeBytes: firstFile.size,
            previewUrl: "blob:one.png",
            file: firstFile,
          },
          {
            type: "image",
            id: "draft-two",
            name: secondFile.name,
            mimeType: secondFile.type,
            sizeBytes: secondFile.size,
            previewUrl: "blob:two.png",
            file: secondFile,
          },
        ],
        files: [],
        assistantSelections: [],
      }),
    ).rejects.toThrow("Original upload failure.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels every staged managed attachment when dispatch rejects", async () => {
    const files = [
      new File(["one"], "one.png", { type: "image/png" }),
      new File(["two"], "two.png", { type: "image/png" }),
    ];
    const ids = [
      "thread-1-11111111-1111-4111-8111-111111111111",
      "thread-1-22222222-2222-4222-8222-222222222222",
    ];
    const fetchMock = vi.fn<typeof fetch>();
    for (const [index, file] of files.entries()) {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          {
            type: "image",
            id: ids[index],
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
          },
          { status: 201 },
        ),
      );
    }
    fetchMock
      .mockResolvedValueOnce(Response.json({ cancelled: true }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const staged = await stageUploadComposerAttachments({
      threadId: "thread-1",
      images: files.map((file, index) => ({
        type: "image" as const,
        id: `draft-${index}`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: `blob:${file.name}`,
        file,
      })),
      files: [],
      assistantSelections: [],
    });
    const dispatchError = new Error("Dispatch rejected.");

    await expect(staged.runWithDispatch(async () => Promise.reject(dispatchError))).rejects.toBe(
      dispatchError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const cancelledIds = fetchMock.mock.calls
      .slice(2)
      .map(([, options]) => JSON.parse(String(options?.body)).attachmentId)
      .sort();
    expect(cancelledIds).toEqual(ids.toSorted());
  });

  it("commits successful dispatches so later cleanup does not cancel", async () => {
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          type: "image",
          id: "thread-1-11111111-1111-4111-8111-111111111111",
          name: imageFile.name,
          mimeType: imageFile.type,
          sizeBytes: imageFile.size,
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const staged = await stageUploadComposerAttachments({
      threadId: "thread-1",
      images: [
        {
          type: "image",
          id: "draft-image",
          name: imageFile.name,
          mimeType: imageFile.type,
          sizeBytes: imageFile.size,
          previewUrl: "blob:screen.png",
          file: imageFile,
        },
      ],
      files: [],
      assistantSelections: [],
    });

    await expect(staged.runWithDispatch(async () => "accepted")).resolves.toBe("accepted");
    await staged.cleanup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("effectiveComposerAttachmentCount", () => {
  it("returns 0 when the draft is missing", () => {
    expect(effectiveComposerAttachmentCount(undefined)).toBe(0);
  });

  it("counts live images, files, and assistant selections", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [{ id: "image-1" }, { id: "image-2" }],
        files: [{}],
        assistantSelections: [{}],
        persistedAttachments: [],
      }),
    ).toBe(4);
  });

  it("counts a persisted attachment that has not yet hydrated into images", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [],
        files: [],
        assistantSelections: [],
        persistedAttachments: [{ id: "pending-1" }],
      }),
    ).toBe(1);
  });

  it("does not double-count a persisted attachment already hydrated into images", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [{ id: "image-1" }],
        files: [],
        assistantSelections: [],
        persistedAttachments: [{ id: "image-1" }],
      }),
    ).toBe(1);
  });

  it("mixes hydrated and pending persisted attachments correctly", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [{ id: "image-1" }],
        files: [{}],
        assistantSelections: [],
        persistedAttachments: [{ id: "image-1" }, { id: "pending-2" }],
      }),
    ).toBe(3);
  });
});

function persistedImageAttachment(
  overrides: Partial<PersistedComposerImageAttachment> = {},
): PersistedComposerImageAttachment {
  return {
    id: "appsnap-1",
    name: "capture.png",
    mimeType: "image/png",
    sizeBytes: 4,
    blobKey: "thread-1:appsnap-1",
    ...overrides,
  };
}

function composerImageAttachment(
  overrides: Partial<ComposerImageAttachment> = {},
): ComposerImageAttachment {
  const file = new File(["png"], "capture.png", { type: "image/png" });
  return {
    type: "image",
    id: "appsnap-1",
    name: "capture.png",
    mimeType: "image/png",
    sizeBytes: 4,
    previewUrl: "blob:capture.png",
    file,
    ...overrides,
  };
}

describe("findPendingBlobComposerAttachments", () => {
  it("returns blob-backed persisted attachments not yet hydrated into images", () => {
    const pending = persistedImageAttachment({ id: "pending-1" });
    const hydrated = persistedImageAttachment({ id: "hydrated-1" });

    const result = findPendingBlobComposerAttachments({
      persistedAttachments: [pending, hydrated],
      images: [composerImageAttachment({ id: "hydrated-1" })],
    });

    expect(result).toEqual([pending]);
  });

  it("ignores dataUrl-backed persisted attachments (no blobKey)", () => {
    const inlineAttachment: PersistedComposerImageAttachment = {
      id: "inline-1",
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 4,
      dataUrl: "data:x",
    };

    const result = findPendingBlobComposerAttachments({
      persistedAttachments: [inlineAttachment],
      images: [],
    });

    expect(result).toEqual([]);
  });
});

describe("hydratePendingBlobComposerAttachments", () => {
  const originalCreateObjectUrl = URL.createObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    vi.restoreAllMocks();
  });

  it("reconstructs a ComposerImageAttachment from the stored blob", async () => {
    const blobFile = new File(["png"], "capture.png", { type: "image/png" });
    vi.spyOn(composerImageBlobStore, "readComposerImageBlob").mockResolvedValue(blobFile);

    const result = await hydratePendingBlobComposerAttachments([
      persistedImageAttachment({
        source: {
          kind: "appsnap",
          captureId: "capture-1",
          capturedAt: "2026-07-14T00:00:00.000Z",
          appName: "Notes",
          windowTitle: null,
        },
      }),
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        type: "image",
        id: "appsnap-1",
        previewUrl: "blob:capture.png",
        file: blobFile,
        source: expect.objectContaining({ kind: "appsnap", captureId: "capture-1" }),
      }),
    ]);
  });

  it("skips an attachment whose blob is missing without throwing", async () => {
    vi.spyOn(composerImageBlobStore, "readComposerImageBlob").mockResolvedValue(null);

    const result = await hydratePendingBlobComposerAttachments([persistedImageAttachment()]);

    expect(result).toEqual([]);
  });

  it("skips an attachment whose blob read rejects, without blocking the rest", async () => {
    vi.spyOn(composerImageBlobStore, "readComposerImageBlob")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new File(["png"], "ok.png", { type: "image/png" }));

    const result = await hydratePendingBlobComposerAttachments([
      persistedImageAttachment({ id: "broken" }),
      persistedImageAttachment({ id: "ok", blobKey: "thread-1:ok" }),
    ]);

    expect(result).toEqual([expect.objectContaining({ id: "ok" })]);
  });
});
