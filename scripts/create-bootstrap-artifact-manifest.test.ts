import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBootstrapArtifactManifest } from "./create-bootstrap-artifact-manifest.ts";

let workspace: string;
let serverTarballPath: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-create-bootstrap-manifest-"));
  serverTarballPath = join(workspace, "synara-server-0.6.4.tar.gz");
  await writeFile(serverTarballPath, "server tarball bytes");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("writeBootstrapArtifactManifest", () => {
  it("describes the shared server tarball and target-specific runtime", async () => {
    const runtimePath = join(workspace, "node-v24.13.1-linux-x64");
    const outputPath = join(workspace, "bootstrap-artifacts.json");
    await writeFile(runtimePath, "x64 node bytes");

    const written = await writeBootstrapArtifactManifest({
      releaseId: "0.6.4",
      serverVersion: "0.6.4",
      target: "linux-x64",
      serverTarballPath,
      nodeRuntimePath: runtimePath,
      outputPath,
    });

    expect(written).toEqual({
      schemaVersion: 1,
      target: "linux-x64",
      releaseId: "0.6.4",
      serverVersion: "0.6.4",
      serverTarball: {
        fileName: "synara-server-0.6.4.tar.gz",
        remoteFileName: "synara-server-0.6.4.tar.gz",
        sha256: digest("server tarball bytes"),
        sizeBytes: Buffer.byteLength("server tarball bytes"),
        mode: 0o600,
      },
      nodeRuntime: {
        fileName: "node-v24.13.1-linux-x64",
        remoteFileName: "node",
        sha256: digest("x64 node bytes"),
        sizeBytes: Buffer.byteLength("x64 node bytes"),
        mode: 0o700,
      },
    });
    await expect(readFile(outputPath, "utf8")).resolves.toBe(
      `${JSON.stringify(written, null, 2)}\n`,
    );
  });

  it("produces non-overwriting manifests for both Linux architectures", async () => {
    const manifests = [];
    for (const [target, contents] of [
      ["linux-x64", "x64 node bytes"],
      ["linux-arm64", "arm64 node bytes"],
    ] as const) {
      const runtimePath = join(workspace, `node-v24.13.1-${target}`);
      await writeFile(runtimePath, contents);
      manifests.push(
        await writeBootstrapArtifactManifest({
          releaseId: "0.6.4",
          serverVersion: "0.6.4",
          target,
          serverTarballPath,
          nodeRuntimePath: runtimePath,
          outputPath: join(workspace, `bootstrap-artifacts-${target}.json`),
        }),
      );
    }

    expect(manifests[0]?.serverTarball).toEqual(manifests[1]?.serverTarball);
    expect(manifests.map((value) => value.nodeRuntime.fileName)).toEqual([
      "node-v24.13.1-linux-x64",
      "node-v24.13.1-linux-arm64",
    ]);
  });

  it("rejects a runtime filename that disagrees with the selected target", async () => {
    const runtimePath = join(workspace, "node-v24.13.1-linux-arm64");
    await writeFile(runtimePath, "arm node bytes");
    await expect(
      writeBootstrapArtifactManifest({
        releaseId: "0.6.4",
        serverVersion: "0.6.4",
        target: "linux-x64",
        serverTarballPath,
        nodeRuntimePath: runtimePath,
        outputPath: join(workspace, "bootstrap-artifacts.json"),
      }),
    ).rejects.toThrow(/linux-x64/);
  });

  it("rejects artifacts outside the manifest directory", async () => {
    const runtimePath = join(workspace, "node-v24.13.1-linux-x64");
    await writeFile(runtimePath, "x64 node bytes");
    await expect(
      writeBootstrapArtifactManifest({
        releaseId: "0.6.4",
        serverVersion: "0.6.4",
        target: "linux-x64",
        serverTarballPath,
        nodeRuntimePath: runtimePath,
        outputPath: join(workspace, "manifests", "bootstrap-artifacts.json"),
      }),
    ).rejects.toThrow(/same directory/);
  });
});
