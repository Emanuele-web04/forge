import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";

describe("attachmentPaths", () => {
  it("allows child names that merely begin with two dots", () => {
    assert.equal(normalizeAttachmentRelativePath("..assets/image.png"), "..assets/image.png");
    assert.equal(
      resolveAttachmentRelativePath({
        attachmentsDir: "/tmp/synara-attachments",
        relativePath: "..assets/image.png",
      }),
      path.resolve("/tmp/synara-attachments", "..assets/image.png"),
    );
  });

  it("rejects parent traversal with either path separator", () => {
    assert.equal(normalizeAttachmentRelativePath(".."), null);
    assert.equal(normalizeAttachmentRelativePath("../outside.bin"), null);
    assert.equal(normalizeAttachmentRelativePath("..\\outside.bin"), null);
  });
});
