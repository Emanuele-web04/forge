import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeReleaseArtifactProvenance } from "./release-artifact-provenance.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-artifact-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Synara-1.2.3-x64.AppImage"), "app-image-bytes");
  writeFileSync(join(root, "latest-linux.yml"), "version: 1.2.3\n");
  return root;
}

function createWindowsAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-windows-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Synara-1.2.3-x64.exe"), "unsigned-windows-bytes");
  writeFileSync(join(root, "latest.yml"), "version: 1.2.3\n");
  return root;
}

describe("release artifact provenance", () => {
  it("hashes the exact collected Linux assets into a deterministic manifest", async () => {
    const assetsDirectory = createAssets();
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory,
      platform: "linux",
      arch: "x64",
      target: "AppImage",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: null,
      lockfileSha256: "b".repeat(64),
      publication: false,
      signed: false,
    });

    expect(result.path).toBe(join(assetsDirectory, "artifact-linux-x64.provenance.json"));
    expect(result.manifest.target).toBe("AppImage");
    expect(result.manifest.signing).toEqual({
      status: "not-applicable",
      scheme: "none",
      identity: null,
      checks: ["AppImage payload present"],
    });
    expect(result.manifest.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "latest-linux.yml",
      "Synara-1.2.3-x64.AppImage",
    ]);
    expect(
      result.manifest.artifacts.find(
        (artifact) => artifact.fileName === "Synara-1.2.3-x64.AppImage",
      )?.sha256,
    ).toBe(createHash("sha256").update("app-image-bytes").digest("hex"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.manifest);
  });

  it("rejects publication without an exact source tag", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createAssets(),
        platform: "linux",
        arch: "x64",
        target: "AppImage",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: null,
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires an exact source tag");
  });

  it("records an explicit version-scoped unsigned Windows publication", async () => {
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory: createWindowsAssets(),
      platform: "win",
      arch: "x64",
      target: "nsis",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: "v1.2.3",
      lockfileSha256: "b".repeat(64),
      publication: true,
      signed: false,
      allowUnsignedWindowsPublication: true,
    });

    expect(result.manifest.signing).toEqual({
      status: "unsigned-explicit-release",
      scheme: "none",
      identity: null,
      checks: ["explicit version-scoped Windows release exception"],
    });
  });

  it("still rejects unsigned Windows publication without the explicit exception", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createWindowsAssets(),
        platform: "win",
        arch: "x64",
        target: "nsis",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: "v1.2.3",
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires verified signing");
  });
});
