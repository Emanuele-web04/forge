import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FetchImplementation,
  fetchNodeRuntime,
  findArchiveSha256,
  NodeRuntimeChecksumMismatchError,
  nodeRuntimeTarget,
} from "./fetch-node-runtime.ts";

const execFileAsync = promisify(execFile);

const VERSION = "24.13.1";
const TARGET = "linux-x64";
const ARCHIVE_FILE_NAME = `node-v${VERSION}-${TARGET}.tar.gz`;

let workspace: string;
let outputDirectory: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-node-runtime-test-"));
  outputDirectory = join(workspace, "output");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeFetchFor(input: {
  readonly archive: Uint8Array;
  readonly archiveSha256?: string;
}): FetchImplementation {
  return async (request) => {
    const url = String(request);
    if (url.endsWith("/SHASUMS256.txt")) {
      const digest = input.archiveSha256 ?? sha256(input.archive);
      return new Response(`${digest}  ${ARCHIVE_FILE_NAME}\n`);
    }
    if (url.endsWith(`/${ARCHIVE_FILE_NAME}`)) {
      return new Response(input.archive);
    }
    return new Response("not found", { status: 404 });
  };
}

describe("nodeRuntimeTarget", () => {
  it.each([
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    // darwin is a first-class remote host (a Mac mini). nodejs.org ships the
    // same `node-v<ver>-<target>.tar.gz`/`bin/node` layout, so it fetches the
    // same way as Linux.
    ["darwin", "x64", "darwin-x64"],
    ["darwin", "arm64", "darwin-arm64"],
  ])("accepts %s-%s", (platform, arch, expected) => {
    expect(nodeRuntimeTarget(platform, arch)).toBe(expected);
  });

  it.each([
    ["win32", "x64"],
    ["linux", "riscv64"],
    ["freebsd", "x64"],
  ])("rejects unsupported target %s-%s", (platform, arch) => {
    expect(() => nodeRuntimeTarget(platform, arch)).toThrow(/Unsupported Node runtime target/);
  });
});

describe("findArchiveSha256", () => {
  it("requires one exact archive filename match", () => {
    const expected = "a".repeat(64);
    expect(
      findArchiveSha256(
        `${"b".repeat(64)}  node-v${VERSION}-linux-arm64.tar.gz\n${expected}  ${ARCHIVE_FILE_NAME}\n`,
        ARCHIVE_FILE_NAME,
      ),
    ).toBe(expected);
  });

  it("rejects missing, partial, uppercase, and duplicate matches", () => {
    const digest = "a".repeat(64);
    expect(() =>
      findArchiveSha256(`${digest}  ${ARCHIVE_FILE_NAME}.sig\n`, ARCHIVE_FILE_NAME),
    ).toThrow(/exactly one checksum/);
    expect(() =>
      findArchiveSha256(`${digest.toUpperCase()}  ${ARCHIVE_FILE_NAME}\n`, ARCHIVE_FILE_NAME),
    ).toThrow(/exactly one checksum/);
    expect(() =>
      findArchiveSha256(
        `${digest}  ${ARCHIVE_FILE_NAME}\n${digest} *${ARCHIVE_FILE_NAME}\n`,
        ARCHIVE_FILE_NAME,
      ),
    ).toThrow(/exactly one checksum/);
  });
});

describe("fetchNodeRuntime", () => {
  it("verifies the archive before extraction and leaves no partial output on mismatch", async () => {
    const archive = Buffer.from("not a tar archive");
    let extractionStarted = false;

    await expect(
      fetchNodeRuntime(
        { nodeVersion: VERSION, platform: "linux", arch: "x64", outputDirectory },
        {
          fetch: fakeFetchFor({ archive, archiveSha256: "0".repeat(64) }),
          extractNodeBinary: async () => {
            extractionStarted = true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(NodeRuntimeChecksumMismatchError);

    expect(extractionStarted).toBe(false);
    await expect(readdir(outputDirectory)).resolves.toEqual([]);
  });

  it("fails loudly on an unsuccessful SHASUMS response", async () => {
    const failingFetch: FetchImplementation = async () =>
      new Response("upstream failed", { status: 503 });
    await expect(
      fetchNodeRuntime(
        { nodeVersion: VERSION, platform: "linux", arch: "x64", outputDirectory },
        { fetch: failingFetch },
      ),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("extracts bin/node atomically and writes the binary's own sha256", async () => {
    const archiveRoot = join(workspace, `node-v${VERSION}-${TARGET}`);
    const nodeBytes = Buffer.from("#!/bin/sh\necho tiny-node\n");
    await mkdir(join(archiveRoot, "bin"), { recursive: true });
    await writeFile(join(archiveRoot, "bin", "node"), nodeBytes);
    await chmod(join(archiveRoot, "bin", "node"), 0o755);
    const archivePath = join(workspace, ARCHIVE_FILE_NAME);
    await execFileAsync("tar", ["-czf", archivePath, `node-v${VERSION}-${TARGET}`], {
      cwd: workspace,
    });
    const archive = await readFile(archivePath);

    const result = await fetchNodeRuntime(
      { nodeVersion: `v${VERSION}`, platform: "linux", arch: "x64", outputDirectory },
      { fetch: fakeFetchFor({ archive }) },
    );

    expect(result.target).toBe(TARGET);
    expect(result.nodeVersion).toBe(VERSION);
    expect(result.runtimeFileName).toBe(`node-v${VERSION}-${TARGET}`);
    await expect(readFile(result.runtimePath)).resolves.toEqual(nodeBytes);
    expect((await stat(result.runtimePath)).mode & 0o777).toBe(0o700);
    expect(result.sha256).toBe(sha256(nodeBytes));
    await expect(readFile(result.sha256Path, "utf8")).resolves.toBe(
      `${sha256(nodeBytes)}  node-v${VERSION}-${TARGET}\n`,
    );
    expect((await readdir(outputDirectory)).toSorted()).toEqual([
      `node-v${VERSION}-${TARGET}`,
      `node-v${VERSION}-${TARGET}.sha256`,
    ]);
  });
});
