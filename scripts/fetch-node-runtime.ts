// FILE: fetch-node-runtime.ts
// Purpose: Fetch a pinned official Linux Node distribution, authenticate the
//          archive against that release's SHASUMS256, and publish only bin/node.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const NODE_DOWNLOAD_BASE_URL = "https://nodejs.org/dist";
const TAR_BLOCK_SIZE = 512;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NODE_VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type NodeRuntimeTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export interface FetchNodeRuntimeInput {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly outputDirectory: string;
}

export interface FetchNodeRuntimeResult {
  readonly nodeVersion: string;
  readonly target: NodeRuntimeTarget;
  readonly runtimeFileName: string;
  readonly runtimePath: string;
  readonly sha256: string;
  readonly sha256Path: string;
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ExtractNodeBinary = (input: {
  readonly archivePath: string;
  readonly archiveEntryPath: string;
  readonly outputPath: string;
}) => Promise<void>;

export interface FetchNodeRuntimeDependencies {
  readonly fetch?: FetchImplementation;
  readonly extractNodeBinary?: ExtractNodeBinary;
}

export class NodeRuntimeChecksumMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly archiveFileName: string;

  constructor(input: {
    readonly expected: string;
    readonly actual: string;
    readonly archiveFileName: string;
  }) {
    super(
      `Node archive checksum mismatch for ${input.archiveFileName}: expected ${input.expected}, got ${input.actual}. Refusing to extract.`,
    );
    this.name = "NodeRuntimeChecksumMismatchError";
    this.expected = input.expected;
    this.actual = input.actual;
    this.archiveFileName = input.archiveFileName;
  }
}

export function nodeRuntimeTarget(platform: string, arch: string): NodeRuntimeTarget {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  // darwin publishes the same `node-v<ver>-<target>.tar.gz` with `bin/node`, so
  // a Mac remote host (a Mac mini, say) fetches its runtime the same way.
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  throw new Error(
    `Unsupported Node runtime target: ${platform}-${arch}. ` +
      `Supported targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64.`,
  );
}

function normalizeNodeVersion(value: string): string {
  const match = NODE_VERSION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Node version must be an exact stable version (for example 24.13.1): ${value}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function findArchiveSha256(shasums: string, archiveFileName: string): string {
  const matches: string[] = [];
  for (const line of shasums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})[ \t]+[*]?([^\s]+)$/.exec(line);
    if (match?.[1] && match[2] === archiveFileName) matches.push(match[1]);
  }
  if (matches.length !== 1) {
    throw new Error(
      `Official SHASUMS256 must contain exactly one checksum for ${archiveFileName}; found ${matches.length}.`,
    );
  }
  return matches[0] as string;
}

async function fetchChecked(
  fetchImplementation: FetchImplementation,
  url: string,
): Promise<Response> {
  const response = await fetchImplementation(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`Node download failed with HTTP ${response.status} for ${url}`);
  }
  return response;
}

async function downloadResponse(response: Response, outputPath: string): Promise<void> {
  if (response.body === null) {
    throw new Error(
      `Node download returned no response body for ${response.url || "requested URL"}`,
    );
  }
  const readable = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  await pipeline(readable, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function tarOctal(header: Buffer, offset: number, length: number, label: string): number {
  const raw = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`Invalid ${label} in Node tar archive`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unsafe ${label} in Node tar archive`);
  }
  return value;
}

function validateTarHeader(header: Buffer): void {
  const expected = tarOctal(header, 148, 8, "header checksum");
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of checksumHeader) actual += byte;
  if (actual !== expected) {
    throw new Error(`Invalid Node tar header checksum: expected ${expected}, got ${actual}`);
  }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, contents: Buffer): Promise<void> {
  let offset = 0;
  while (offset < contents.byteLength) {
    const { bytesWritten } = await file.write(contents, offset, contents.byteLength - offset);
    if (bytesWritten === 0)
      throw new Error("Failed to make progress writing extracted Node binary");
    offset += bytesWritten;
  }
}

export const extractNodeBinaryFromTarGzip: ExtractNodeBinary = async (input) => {
  const output = await open(input.outputPath, "wx", 0o700);
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let extractingTarget = false;
  let foundTarget = false;
  let reachedEnd = false;

  try {
    archive: for await (const chunk of createReadStream(input.archivePath).pipe(createGunzip())) {
      const buffer = chunk as Buffer<ArrayBufferLike>;
      pending = pending.byteLength === 0 ? buffer : Buffer.concat([pending, buffer]);

      while (true) {
        if (remaining > 0) {
          if (pending.byteLength === 0) break;
          const consumed = Math.min(remaining, pending.byteLength);
          if (extractingTarget) await writeAll(output, pending.subarray(0, consumed));
          pending = pending.subarray(consumed);
          remaining -= consumed;
          continue;
        }

        if (padding > 0) {
          if (pending.byteLength === 0) break;
          const consumed = Math.min(padding, pending.byteLength);
          pending = pending.subarray(consumed);
          padding -= consumed;
          continue;
        }

        extractingTarget = false;
        if (pending.byteLength < TAR_BLOCK_SIZE) break;

        const header = pending.subarray(0, TAR_BLOCK_SIZE);
        pending = pending.subarray(TAR_BLOCK_SIZE);
        if (header.every((byte) => byte === 0)) {
          reachedEnd = true;
          break archive;
        }
        validateTarHeader(header);

        const name = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 155);
        const entryPath = prefix.length === 0 ? name : `${prefix}/${name}`;
        const sizeBytes = tarOctal(header, 124, 12, "entry size");
        const type = header[156] ?? 0;

        if (entryPath === input.archiveEntryPath) {
          if (foundTarget)
            throw new Error(`Node archive contains duplicate ${input.archiveEntryPath}`);
          if (type !== 0 && type !== "0".charCodeAt(0)) {
            throw new Error(`Node archive ${input.archiveEntryPath} is not a regular file`);
          }
          if (sizeBytes === 0) throw new Error(`Node archive ${input.archiveEntryPath} is empty`);
          foundTarget = true;
          extractingTarget = true;
        }

        remaining = sizeBytes;
        padding = (TAR_BLOCK_SIZE - (sizeBytes % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      }
    }

    if (!reachedEnd) throw new Error("Node tar archive ended without the required end marker");
    if (!foundTarget) throw new Error(`Node archive is missing ${input.archiveEntryPath}`);
    await output.sync();
  } finally {
    await output.close();
  }
};

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await access(outputPath);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite existing Node runtime artifact: ${outputPath}`);
}

export async function fetchNodeRuntime(
  input: FetchNodeRuntimeInput,
  dependencies: FetchNodeRuntimeDependencies = {},
): Promise<FetchNodeRuntimeResult> {
  const nodeVersion = normalizeNodeVersion(input.nodeVersion);
  const target = nodeRuntimeTarget(input.platform, input.arch);
  const archiveFileName = `node-v${nodeVersion}-${target}.tar.gz`;
  const runtimeFileName = `node-v${nodeVersion}-${target}`;
  const outputDirectory = resolve(input.outputDirectory);
  const runtimePath = join(outputDirectory, runtimeFileName);
  const sha256Path = `${runtimePath}.sha256`;
  const releaseUrl = `${NODE_DOWNLOAD_BASE_URL}/v${nodeVersion}`;
  const fetchImplementation = dependencies.fetch ?? fetch;
  const extractNodeBinary = dependencies.extractNodeBinary ?? extractNodeBinaryFromTarGzip;

  await mkdir(outputDirectory, { recursive: true });
  await assertOutputDoesNotExist(runtimePath);
  await assertOutputDoesNotExist(sha256Path);

  const downloadDirectory = await mkdtemp(join(tmpdir(), "synara-node-download-"));
  try {
    const shasumsResponse = await fetchChecked(fetchImplementation, `${releaseUrl}/SHASUMS256.txt`);
    const shasums = await shasumsResponse.text();
    const expectedArchiveSha256 = findArchiveSha256(shasums, archiveFileName);

    const archivePath = join(downloadDirectory, archiveFileName);
    const archiveResponse = await fetchChecked(
      fetchImplementation,
      `${releaseUrl}/${archiveFileName}`,
    );
    await downloadResponse(archiveResponse, archivePath);
    const actualArchiveSha256 = await hashFile(archivePath);
    if (actualArchiveSha256 !== expectedArchiveSha256) {
      throw new NodeRuntimeChecksumMismatchError({
        expected: expectedArchiveSha256,
        actual: actualArchiveSha256,
        archiveFileName,
      });
    }

    // No extraction path is reached until the complete downloaded archive has
    // matched the release checksum above.
    const stagingDirectory = await mkdtemp(join(outputDirectory, ".node-runtime-"));
    const stagedRuntimePath = join(stagingDirectory, runtimeFileName);
    const stagedSha256Path = `${stagedRuntimePath}.sha256`;
    try {
      await extractNodeBinary({
        archivePath,
        archiveEntryPath: `node-v${nodeVersion}-${target}/bin/node`,
        outputPath: stagedRuntimePath,
      });
      const runtimeStats = await stat(stagedRuntimePath);
      if (!runtimeStats.isFile() || runtimeStats.size === 0) {
        throw new Error(
          `Extracted Node runtime is not a non-empty regular file: ${stagedRuntimePath}`,
        );
      }
      await chmod(stagedRuntimePath, 0o700);
      const sha256 = await hashFile(stagedRuntimePath);
      if (!SHA256_PATTERN.test(sha256)) throw new Error("Extracted Node runtime hash is malformed");
      await writeFile(stagedSha256Path, `${sha256}  ${basename(runtimePath)}\n`, {
        encoding: "utf8",
        mode: 0o644,
        flag: "wx",
      });

      // Both paths live under outputDirectory, so these are atomic same-filesystem
      // renames. The runtime lands last and acts as the completion marker.
      await rename(stagedSha256Path, sha256Path);
      try {
        await rename(stagedRuntimePath, runtimePath);
      } catch (cause) {
        await rm(sha256Path, { force: true });
        throw cause;
      }

      return { nodeVersion, target, runtimeFileName, runtimePath, sha256, sha256Path };
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
}

interface CommandLineArguments {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly outputDirectory: string;
}

function parseCommandLine(argv: readonly string[]): CommandLineArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        "Usage: fetch-node-runtime.ts --node-version <version> --platform <linux|darwin> --arch <x64|arm64> --out <directory>",
      );
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  const allowed = new Set(["--node-version", "--platform", "--arch", "--out"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${name}`);
  }
  const nodeVersion = values.get("--node-version");
  const platform = values.get("--platform");
  const arch = values.get("--arch");
  const outputDirectory = values.get("--out");
  if (!nodeVersion || !platform || !arch || !outputDirectory) {
    throw new Error(
      "Usage: fetch-node-runtime.ts --node-version <version> --platform <linux|darwin> --arch <x64|arm64> --out <directory>",
    );
  }
  return { nodeVersion, platform, arch, outputDirectory };
}

async function main(): Promise<void> {
  const input = parseCommandLine(process.argv.slice(2));
  const result = await fetchNodeRuntime(input);
  console.log(`Wrote ${result.runtimePath}`);
  console.log(`Wrote ${result.sha256Path}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
