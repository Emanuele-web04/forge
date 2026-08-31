// FILE: useComposerDropzone.test.ts
// Purpose: Covers file capability decisions for shared composer paste/drop handling.
// Layer: Web hook tests

import { describe, expect, it } from "vitest";

import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";

import {
  collectComposerClipboardFiles,
  isComposerDropzoneInternalDragTransition,
  shouldBlockDisabledComposerDropzoneTransfer,
  shouldPreventDefaultForUnhandledFileDrop,
  shouldResetComposerDropzoneAfterUnhandledFileDrop,
  shouldHandleComposerDropzoneFiles,
  splitComposerDropzoneFiles,
} from "./useComposerDropzone";

describe("useComposerDropzone file capability helpers", () => {
  describe("clipboard file collection", () => {
    const clipboard = (files: File[], items: Array<Partial<DataTransferItem>>) =>
      ({ files, items }) as unknown as Pick<DataTransfer, "files" | "items">;

    const fileItem = (getAsFile: () => File | null, kind = "file") =>
      ({ kind, getAsFile }) as DataTransferItem;

    it("collects files exposed through the files list", () => {
      const file = new File(["image"], "image.png", { type: "image/png" });

      expect(collectComposerClipboardFiles(clipboard([file], []))).toEqual([file]);
    });

    it("collects file-kind clipboard items", () => {
      const file = new File(["image"], "image.png", { type: "image/png" });

      expect(collectComposerClipboardFiles(clipboard([], [fileItem(() => file)]))).toEqual([file]);
    });

    it("ignores null and non-file clipboard items", () => {
      expect(
        collectComposerClipboardFiles(
          clipboard([], [fileItem(() => null), fileItem(() => null, "string")]),
        ),
      ).toEqual([]);
    });

    it("deduplicates the same stable file identity across both sources", () => {
      const listed = new File(["same"], "image.png", {
        type: "image/png",
        lastModified: 123,
      });
      const itemFile = new File(["same"], "image.png", {
        type: "image/png",
        lastModified: 123,
      });

      expect(
        collectComposerClipboardFiles(clipboard([listed], [fileItem(() => itemFile)])),
      ).toEqual([listed]);
    });

    it("ignores clipboard items whose getAsFile throws", () => {
      const listed = new File(["image"], "listed.png", { type: "image/png" });
      const throwingItem = fileItem(() => {
        throw new Error("clipboard access denied");
      });

      expect(collectComposerClipboardFiles(clipboard([listed], [throwingItem]))).toEqual([listed]);
    });

    it("returns no files for text-only clipboard data", () => {
      expect(
        collectComposerClipboardFiles(clipboard([], [fileItem(() => null, "string")])),
      ).toEqual([]);
    });

    it("preserves image and generic classification for collected files", () => {
      const image = new File(["image"], "image.png", { type: "image/png" });
      const generic = new File(["text"], "notes.txt", { type: "text/plain" });
      const collected = collectComposerClipboardFiles(
        clipboard([image], [fileItem(() => generic)]),
      );

      expect(splitComposerDropzoneFiles(collected)).toEqual({
        imageFiles: [image],
        genericFiles: [generic],
      });
      expect(
        shouldHandleComposerDropzoneFiles(splitComposerDropzoneFiles(collected), "accept"),
      ).toBe(true);
      expect(
        shouldHandleComposerDropzoneFiles(splitComposerDropzoneFiles([generic]), "fallthrough"),
      ).toBe(false);
    });
  });

  it("splits image files from generic files", () => {
    const image = new File(["image"], "image.png", { type: "image/png" });
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(splitComposerDropzoneFiles([image, generic])).toEqual({
      imageFiles: [image],
      genericFiles: [generic],
    });
  });

  it("lets unsupported generic-only files fall through when requested", () => {
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });
    const files = splitComposerDropzoneFiles([generic]);

    expect(shouldHandleComposerDropzoneFiles(files, "fallthrough")).toBe(false);
  });

  it("handles generic-only files when the consumer rejects them visibly", () => {
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });
    const files = splitComposerDropzoneFiles([generic]);

    expect(shouldHandleComposerDropzoneFiles(files, "reject")).toBe(true);
  });

  it("resets drag state for unusable file drops", () => {
    const files = splitComposerDropzoneFiles([]);

    expect(shouldResetComposerDropzoneAfterUnhandledFileDrop(files, "accept")).toBe(true);
  });

  it("prevents default for claimed unusable file drops", () => {
    const files = splitComposerDropzoneFiles([]);

    expect(shouldPreventDefaultForUnhandledFileDrop(files, "accept")).toBe(true);
    expect(shouldPreventDefaultForUnhandledFileDrop(files, "reject")).toBe(true);
    expect(shouldPreventDefaultForUnhandledFileDrop(files, "fallthrough")).toBe(false);
  });

  it("identifies child drag transitions as internal to the dropzone", () => {
    const child = {};
    const outside = {};
    const currentTarget = {
      contains: (target: unknown) => target === child,
    };

    expect(isComposerDropzoneInternalDragTransition(currentTarget, child)).toBe(true);
    expect(isComposerDropzoneInternalDragTransition(currentTarget, outside)).toBe(false);
    expect(isComposerDropzoneInternalDragTransition(currentTarget, null)).toBe(false);
  });

  it("blocks attachment and reference drops while the dropzone is disabled", () => {
    expect(shouldBlockDisabledComposerDropzoneTransfer(true, ["Files"])).toBe(true);
    expect(shouldBlockDisabledComposerDropzoneTransfer(true, [CHAT_FILE_REFERENCE_DRAG_TYPE])).toBe(
      true,
    );
    expect(shouldBlockDisabledComposerDropzoneTransfer(false, ["Files"])).toBe(false);
    expect(shouldBlockDisabledComposerDropzoneTransfer(true, ["text/plain"])).toBe(false);
  });
});
