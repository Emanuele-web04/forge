// FILE: bootstrapArtifactManifest.ts
// Purpose: Load release-pinned bootstrap metadata without deriving trust from
//          the local bytes that metadata is supposed to authenticate.
// Layer: Server / remote broker
// Exports: loadBootstrapArtifactSet, BootstrapArtifactManifestTarget

import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BootstrapArtifact, BootstrapArtifactSet } from "./bootstrapArtifacts";
import { normalizeReleaseId, normalizeRemoteFileName } from "./remoteInputs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SERVER_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NODE_RUNTIME_FILE_PATTERN = /^node-v\d+\.\d+\.\d+-((?:linux|darwin)-(?:x64|arm64))$/;

export type BootstrapArtifactManifestTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64";

const MANIFEST_TARGETS: ReadonlySet<string> = new Set<BootstrapArtifactManifestTarget>([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

interface ManifestArtifact {
  readonly fileName: string;
  readonly remoteFileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mode: number;
}

interface BootstrapArtifactManifest {
  readonly schemaVersion: 1;
  readonly target: BootstrapArtifactManifestTarget;
  readonly releaseId: string;
  readonly serverVersion: string;
  readonly serverTarball: ManifestArtifact;
  readonly nodeRuntime: ManifestArtifact;
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid bootstrap artifact manifest: ${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid bootstrap artifact manifest: ${path}.${key} must be a string`);
  }
  return value;
}

function safeFileName(value: string, path: string): string {
  try {
    const normalized = normalizeRemoteFileName(value);
    if (normalized !== value) throw new Error("filename must not contain surrounding whitespace");
    return normalized;
  } catch (cause) {
    throw new Error(`Invalid bootstrap artifact manifest: ${path} is not a safe basename`, {
      cause,
    });
  }
}

function parseManifestArtifact(
  value: unknown,
  path: "nodeRuntime" | "serverTarball",
  expectedMode: number,
): ManifestArtifact {
  const record = recordAt(value, path);
  const fileName = safeFileName(stringAt(record, "fileName", path), `${path}.fileName`);
  const remoteFileName = safeFileName(
    stringAt(record, "remoteFileName", path),
    `${path}.remoteFileName`,
  );
  const sha256 = stringAt(record, "sha256", path);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(
      `Invalid bootstrap artifact manifest: ${path}.sha256 must be lowercase hexadecimal SHA-256`,
    );
  }
  const sizeBytes = record.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) {
    throw new Error(
      `Invalid bootstrap artifact manifest: ${path}.sizeBytes must be a nonnegative safe integer`,
    );
  }
  if (record.mode !== expectedMode) {
    throw new Error(
      `Invalid bootstrap artifact manifest: ${path}.mode must be ${expectedMode.toString(8)}`,
    );
  }
  return { fileName, remoteFileName, sha256, sizeBytes: sizeBytes as number, mode: expectedMode };
}

function parseManifest(value: unknown): BootstrapArtifactManifest {
  const record = recordAt(value, "root");
  if (record.schemaVersion !== 1) {
    throw new Error("Invalid bootstrap artifact manifest: schemaVersion must be 1");
  }
  const rawTarget = record.target;
  if (typeof rawTarget !== "string" || !MANIFEST_TARGETS.has(rawTarget)) {
    throw new Error(
      "Invalid bootstrap artifact manifest: target must be one of linux-x64, linux-arm64, darwin-x64, darwin-arm64",
    );
  }
  // Membership in MANIFEST_TARGETS proves the literal type; Set.has does not narrow.
  const target = rawTarget as BootstrapArtifactManifestTarget;

  const releaseIdValue = stringAt(record, "releaseId", "root");
  let releaseId: string;
  try {
    releaseId = normalizeReleaseId(releaseIdValue);
    if (releaseId !== releaseIdValue) throw new Error("release id contains surrounding whitespace");
  } catch (cause) {
    throw new Error("Invalid bootstrap artifact manifest: releaseId is unsafe", { cause });
  }

  const serverVersion = stringAt(record, "serverVersion", "root");
  if (!SERVER_VERSION_PATTERN.test(serverVersion)) {
    throw new Error("Invalid bootstrap artifact manifest: serverVersion must be semantic version");
  }

  const serverTarball = parseManifestArtifact(record.serverTarball, "serverTarball", 0o600);
  const nodeRuntime = parseManifestArtifact(record.nodeRuntime, "nodeRuntime", 0o700);
  const runtimeTarget = NODE_RUNTIME_FILE_PATTERN.exec(nodeRuntime.fileName)?.[1];
  if (runtimeTarget !== target) {
    throw new Error(
      `Invalid bootstrap artifact manifest: nodeRuntime.fileName does not match target ${target}`,
    );
  }

  return {
    schemaVersion: 1,
    target,
    releaseId,
    serverVersion,
    serverTarball,
    nodeRuntime,
  };
}

async function localArtifact(
  manifestDirectory: string,
  manifest: ManifestArtifact,
  kind: BootstrapArtifact["kind"],
): Promise<BootstrapArtifact> {
  const localPath = resolve(manifestDirectory, manifest.fileName);
  let stats;
  try {
    stats = await lstat(localPath);
  } catch (cause) {
    throw new Error(`Bootstrap artifact manifest ${kind} artifact is unavailable: ${localPath}`, {
      cause,
    });
  }
  if (!stats.isFile()) {
    throw new Error(
      `Bootstrap artifact manifest ${kind} artifact is not a regular file: ${localPath}`,
    );
  }
  return {
    kind,
    localPath,
    remoteFileName: manifest.remoteFileName,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    mode: manifest.mode,
  };
}

export async function loadBootstrapArtifactSet(
  manifestPath: string,
): Promise<BootstrapArtifactSet> {
  const absoluteManifestPath = resolve(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absoluteManifestPath, "utf8")) as unknown;
  } catch (cause) {
    throw new Error(`Failed to read bootstrap artifact manifest: ${absoluteManifestPath}`, {
      cause,
    });
  }
  const manifest = parseManifest(parsed);
  const manifestDirectory = dirname(absoluteManifestPath);
  const [serverTarball, nodeRuntime] = await Promise.all([
    localArtifact(manifestDirectory, manifest.serverTarball, "server-tarball"),
    localArtifact(manifestDirectory, manifest.nodeRuntime, "node-runtime"),
  ]);
  return {
    releaseId: manifest.releaseId,
    serverVersion: manifest.serverVersion,
    serverTarball,
    nodeRuntime,
  };
}
