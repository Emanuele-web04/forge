import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChecksumMismatchError, verifyLocalArtifact } from "./bootstrapArtifacts";
import { loadBootstrapArtifactSet } from "./bootstrapArtifactManifest";

const SERVER_BYTES = "server archive";
const MUTATED_SERVER_BYTES = "tamper archive";
const NODE_BYTES = "node binary";
const SERVER_DIGEST = createHash("sha256").update(SERVER_BYTES).digest("hex");
const NODE_DIGEST = createHash("sha256").update(NODE_BYTES).digest("hex");

let workspace: string;
let manifestPath: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-bootstrap-manifest-"));
  manifestPath = join(workspace, "bootstrap-artifacts.json");
  await writeFile(join(workspace, "synara-server-0.6.4.tar.gz"), SERVER_BYTES);
  await writeFile(join(workspace, "node-v24.13.1-linux-x64"), NODE_BYTES);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function serverTarball(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileName: "synara-server-0.6.4.tar.gz",
    remoteFileName: "synara-server-0.6.4.tar.gz",
    sha256: SERVER_DIGEST,
    sizeBytes: Buffer.byteLength(SERVER_BYTES),
    mode: 0o600,
    ...overrides,
  };
}

function nodeRuntime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileName: "node-v24.13.1-linux-x64",
    remoteFileName: "node",
    sha256: NODE_DIGEST,
    sizeBytes: Buffer.byteLength(NODE_BYTES),
    mode: 0o700,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    target: "linux-x64",
    releaseId: "0.6.4",
    serverVersion: "0.6.4",
    serverTarball: serverTarball(),
    nodeRuntime: nodeRuntime(),
    ...overrides,
  };
}

async function writeManifest(value: Record<string, unknown> = manifest()): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("loadBootstrapArtifactSet", () => {
  it("resolves both artifact paths against the manifest directory", async () => {
    await writeManifest();
    const relativeManifestPath = relative(process.cwd(), manifestPath);
    const loaded = await loadBootstrapArtifactSet(relativeManifestPath);

    expect(loaded).toEqual({
      releaseId: "0.6.4",
      serverVersion: "0.6.4",
      serverTarball: {
        kind: "server-tarball",
        localPath: resolve(workspace, "synara-server-0.6.4.tar.gz"),
        remoteFileName: "synara-server-0.6.4.tar.gz",
        sha256: SERVER_DIGEST,
        sizeBytes: Buffer.byteLength(SERVER_BYTES),
        mode: 0o600,
      },
      nodeRuntime: {
        kind: "node-runtime",
        localPath: resolve(workspace, "node-v24.13.1-linux-x64"),
        remoteFileName: "node",
        sha256: NODE_DIGEST,
        sizeBytes: Buffer.byteLength(NODE_BYTES),
        mode: 0o700,
      },
    });
  });

  it("keeps the manifest digest after bytes mutate so local verification remains meaningful", async () => {
    await writeManifest();
    expect(Buffer.byteLength(MUTATED_SERVER_BYTES)).toBe(Buffer.byteLength(SERVER_BYTES));
    await writeFile(join(workspace, "synara-server-0.6.4.tar.gz"), MUTATED_SERVER_BYTES);

    const loaded = await loadBootstrapArtifactSet(manifestPath);

    expect(loaded.serverTarball.sha256).toBe(SERVER_DIGEST);
    await expect(verifyLocalArtifact(loaded.serverTarball)).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
  });

  it.each([
    ["unknown schema", { schemaVersion: 2 }],
    ["unsupported target", { target: "darwin-arm64" }],
    ["malformed digest", { serverTarball: serverTarball({ sha256: "A".repeat(64) }) }],
    ["unsafe size", { nodeRuntime: nodeRuntime({ sizeBytes: Number.MAX_SAFE_INTEGER + 1 }) }],
    ["wrong tarball mode", { serverTarball: serverTarball({ mode: 0o644 }) }],
    ["wrong runtime mode", { nodeRuntime: nodeRuntime({ mode: 0o755 }) }],
    [
      "absolute local filename",
      { serverTarball: serverTarball({ fileName: "/tmp/server.tar.gz" }) },
    ],
    ["traversing local filename", { nodeRuntime: nodeRuntime({ fileName: "../node" }) }],
    ["unsafe remote filename", { nodeRuntime: nodeRuntime({ remoteFileName: "../node" }) }],
    [
      "target/runtime disagreement",
      { nodeRuntime: nodeRuntime({ fileName: "node-v24.13.1-linux-arm64" }) },
    ],
  ])("rejects %s", async (_label, override) => {
    await writeManifest(manifest(override));
    await expect(loadBootstrapArtifactSet(manifestPath)).rejects.toThrow(/manifest/i);
  });

  it("rejects missing artifacts and non-regular artifact paths", async () => {
    await writeManifest();
    await rm(join(workspace, "node-v24.13.1-linux-x64"));
    await expect(loadBootstrapArtifactSet(manifestPath)).rejects.toThrow(/node-runtime artifact/i);

    await mkdir(join(workspace, "node-v24.13.1-linux-x64"));
    await expect(loadBootstrapArtifactSet(manifestPath)).rejects.toThrow(/regular file/i);
  });
});
