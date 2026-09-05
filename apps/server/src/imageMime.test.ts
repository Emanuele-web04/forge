import { describe, expect, it } from "vitest";

import { inferAttachmentExtension, inferImageExtension } from "./imageMime.ts";

describe("imageMime", () => {
  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });

  it("infers generic attachment extensions from mime type", () => {
    expect(inferAttachmentExtension({ mimeType: "application/pdf" })).toBe(".pdf");
    expect(inferAttachmentExtension({ mimeType: "text/plain" })).toBe(".txt");
  });

  it("preserves the final extension from multi-dot attachment filenames", () => {
    expect(
      inferAttachmentExtension({
        mimeType: "application/octet-stream",
        fileName: "archive.tar.gz",
      }),
    ).toBe(".gz");
  });

  it("does not treat a dotfile name as an attachment extension", () => {
    expect(
      inferAttachmentExtension({
        mimeType: "application/octet-stream",
        fileName: ".env",
      }),
    ).toBe(".bin");
  });
});
