// FILE: useComposerDropzone.test.ts
// Purpose: Covers file capability decisions for shared composer paste/drop handling.
// Layer: Web hook tests

import { describe, expect, it, test } from "vitest";

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
    const image = (name = "image.png") => new File(["image"], name, { type: "image/png" });

    test.each([
      ["files-only existing path", [image()], [], ["image.png"]],
      ["items-only regression", [], [fileItem(() => image())], ["image.png"]],
      ["null file item", [], [fileItem(() => null)], []],
      ["non-file/text-only item", [], [fileItem(() => null, "string")], []],
    ])("collects %s", (_case, files, items, expectedNames) => {
      expect(
        collectComposerClipboardFiles(clipboard(files, items)).map(({ name }) => name),
      ).toEqual(expectedNames);
    });

    it("deduplicates duplicate file representations", () => {
      const listed = new File(["same"], "image.png", { type: "image/png", lastModified: 123 });
      const itemFile = new File(["same"], "image.png", { type: "image/png", lastModified: 123 });

      expect(
        collectComposerClipboardFiles(clipboard([listed], [fileItem(() => itemFile)])),
      ).toEqual([listed]);
    });

    it("keeps listed files when getAsFile throws", () => {
      const listed = image("listed.png");
      const throwingItem = fileItem(() => {
        throw new Error("clipboard access denied");
      });

      expect(collectComposerClipboardFiles(clipboard([listed], [throwingItem]))).toEqual([listed]);
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

  test.each([
    ["accept", true],
    ["reject", true],
    ["fallthrough", false],
  ] as const)("applies %s policy to generic-only files", (mode, expected) => {
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(shouldHandleComposerDropzoneFiles(splitComposerDropzoneFiles([generic]), mode)).toBe(
      expected,
    );
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
