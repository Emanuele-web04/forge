import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { resolveAllowedLocalPreviewFile } from "./localImageFiles.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local preview dot-prefixed directories", () => {
  it("allows workspace files below a child directory beginning with two dots", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "synara-dot-preview-"));
    tempDirs.push(workspace);
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const previewDirectory = path.join(workspace, "..assets");
    const previewPath = path.join(previewDirectory, "spec.pdf");
    mkdirSync(previewDirectory);
    writeFileSync(previewPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: previewPath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(previewPath));
  });
});
