// FILE: create-bootstrap-artifact-manifest.ts
// Purpose: Pin release artifact bytes into a portable manifest consumed later
//          by the server loader without re-deriving its trust expectations.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { nodeRuntimeTarget, type NodeRuntimeTarget } from "./fetch-node-runtime.ts";

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SERVER_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CreateBootstrapArtifactManifestInput {
  readonly releaseId: string;
  readonly serverVersion: string;
  readonly target: NodeRuntimeTarget;
  readonly serverTarballPath: string;
  readonly nodeRuntimePath: string;
  readonly outputPath: string;
}

interface BootstrapArtifactManifestEntry {
  readonly fileName: string;
  readonly remoteFileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mode: number;
}

export interface BootstrapArtifactManifest {
  readonly schemaVersion: 1;
  readonly target: NodeRuntimeTarget;
  readonly releaseId: string;
  readonly serverVersion: string;
  readonly serverTarball: BootstrapArtifactManifestEntry;
  readonly nodeRuntime: BootstrapArtifactManifestEntry;
}

async function describeFile(filePath: string): Promise<{
  readonly sha256: string;
  readonly sizeBytes: number;
}> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) throw new Error(`Bootstrap artifact is not a regular file: ${filePath}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    sizeBytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function validateInput(input: CreateBootstrapArtifactManifestInput): void {
  if (
    !RELEASE_ID_PATTERN.test(input.releaseId) ||
    input.releaseId.includes("..") ||
    /^\.+$/.test(input.releaseId)
  ) {
    throw new Error(`Invalid bootstrap release id: ${input.releaseId}`);
  }
  if (!SERVER_VERSION_PATTERN.test(input.serverVersion)) {
    throw new Error(`Invalid bootstrap server version: ${input.serverVersion}`);
  }
  const [platform, arch] = input.target.split("-");
  nodeRuntimeTarget(platform ?? "", arch ?? "");

  const serverTarballFileName = basename(input.serverTarballPath);
  const nodeRuntimeFileName = basename(input.nodeRuntimePath);
  if (!SAFE_FILE_NAME_PATTERN.test(serverTarballFileName)) {
    throw new Error(`Invalid server tarball filename: ${serverTarballFileName}`);
  }
  if (!SAFE_FILE_NAME_PATTERN.test(nodeRuntimeFileName)) {
    throw new Error(`Invalid Node runtime filename: ${nodeRuntimeFileName}`);
  }
  if (!new RegExp(`^node-v\\d+\\.\\d+\\.\\d+-${input.target}$`).test(nodeRuntimeFileName)) {
    throw new Error(
      `Node runtime filename ${nodeRuntimeFileName} does not match target ${input.target}`,
    );
  }
}

export async function writeBootstrapArtifactManifest(
  input: CreateBootstrapArtifactManifestInput,
): Promise<BootstrapArtifactManifest> {
  validateInput(input);
  const serverTarballPath = resolve(input.serverTarballPath);
  const nodeRuntimePath = resolve(input.nodeRuntimePath);
  const outputPath = resolve(input.outputPath);
  const manifestDirectory = dirname(outputPath);
  if (
    dirname(serverTarballPath) !== manifestDirectory ||
    dirname(nodeRuntimePath) !== manifestDirectory
  ) {
    throw new Error("Bootstrap artifacts and manifest must be in the same directory");
  }
  const [serverTarballDescription, nodeRuntimeDescription] = await Promise.all([
    describeFile(serverTarballPath),
    describeFile(nodeRuntimePath),
  ]);
  const serverTarballFileName = basename(serverTarballPath);
  const nodeRuntimeFileName = basename(nodeRuntimePath);
  const manifest: BootstrapArtifactManifest = {
    schemaVersion: 1,
    target: input.target,
    releaseId: input.releaseId,
    serverVersion: input.serverVersion,
    serverTarball: {
      fileName: serverTarballFileName,
      remoteFileName: serverTarballFileName,
      ...serverTarballDescription,
      mode: 0o600,
    },
    nodeRuntime: {
      fileName: nodeRuntimeFileName,
      remoteFileName: "node",
      ...nodeRuntimeDescription,
      mode: 0o700,
    },
  };

  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return manifest;
}

function parseCommandLine(argv: readonly string[]): CreateBootstrapArtifactManifestInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        "Usage: create-bootstrap-artifact-manifest.ts --release-id <id> --server-version <version> --target <linux-x64|linux-arm64|darwin-x64|darwin-arm64> --server-tarball <path> --node-runtime <path> --out <path>",
      );
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  const allowed = new Set([
    "--release-id",
    "--server-version",
    "--target",
    "--server-tarball",
    "--node-runtime",
    "--out",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${name}`);
  }
  const releaseId = values.get("--release-id");
  const serverVersion = values.get("--server-version");
  const target = values.get("--target");
  const serverTarballPath = values.get("--server-tarball");
  const nodeRuntimePath = values.get("--node-runtime");
  const outputPath = values.get("--out");
  if (
    !releaseId ||
    !serverVersion ||
    (target !== "linux-x64" &&
      target !== "linux-arm64" &&
      target !== "darwin-x64" &&
      target !== "darwin-arm64") ||
    !serverTarballPath ||
    !nodeRuntimePath ||
    !outputPath
  ) {
    throw new Error(
      "Usage: create-bootstrap-artifact-manifest.ts --release-id <id> --server-version <version> --target <linux-x64|linux-arm64|darwin-x64|darwin-arm64> --server-tarball <path> --node-runtime <path> --out <path>",
    );
  }
  return {
    releaseId,
    serverVersion,
    target,
    serverTarballPath,
    nodeRuntimePath,
    outputPath,
  };
}

async function main(): Promise<void> {
  const input = parseCommandLine(process.argv.slice(2));
  await writeBootstrapArtifactManifest(input);
  console.log(`Wrote ${resolve(input.outputPath)}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
