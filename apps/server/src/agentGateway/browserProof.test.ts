import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveBrowserProof } from "./browserProof.ts";
import { resolveAllowedLocalPreviewFile } from "../localImageFiles.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

describe("browser proof artifacts", () => {
  it("stores unique private PNGs, does not trust a thread id as a path, and serves them to chat", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-proof-test-"));
    try {
      const first = await saveBrowserProof("../../outside", PNG, root);
      const second = await saveBrowserProof("../../outside", PNG, root);
      expect(first).not.toBe(second);
      expect(path.relative(root, first).startsWith("..")).toBe(false);
      expect(await readFile(first)).toEqual(Buffer.from(PNG, "base64"));
      if (process.platform !== "win32") expect((await stat(first)).mode & 0o777).toBe(0o600);
      expect(
        await resolveAllowedLocalPreviewFile({ requestedPath: first, cwd: null }),
      ).toMatchObject({ path: await realpath(first), fileName: path.basename(first) });
      await expect(
        saveBrowserProof("thread", Buffer.from("not an image").toString("base64"), root),
      ).rejects.toThrow("Invalid proof image");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
