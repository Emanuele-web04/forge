import { describe, expect, it } from "vitest";

import { inferAttachmentExtension, inferImageExtension, parseBase64DataUrl } from "./imageMime.ts";

describe("imageMime", () => {
  it("parses base64 data URL with mime type", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses base64 data URL with mime parameters", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects non-base64 data URL", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8,hello")).toBeNull();
  });

  it("rejects missing mime type", () => {
    expect(parseBase64DataUrl("data:;base64,SGVsbG8=")).toBeNull();
  });

  it("parses base64 data URL with spaces in payload", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs bG8=\n")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

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
