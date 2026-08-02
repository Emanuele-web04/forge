import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeDeterministicTarGzip } from "./deterministicTar";

const execFileAsync = promisify(execFile);

let workspace: string;
let sourceDirectory: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-deterministic-tar-"));
  sourceDirectory = join(workspace, "stage");
  await mkdir(join(sourceDirectory, "dist", "nested"), { recursive: true });
  await writeFile(join(sourceDirectory, "dist", "index.mjs"), "#!/usr/bin/env node\nmain();\n");
  await chmod(join(sourceDirectory, "dist", "index.mjs"), 0o755);
  await writeFile(join(sourceDirectory, "dist", "nested", "asset.txt"), "asset\n");
  await writeFile(join(sourceDirectory, "package.json"), '{"name":"@synara/cli"}\n');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("writeDeterministicTarGzip", () => {
  it("packs identical input into byte-identical, standard-readable archives", async () => {
    const firstArchive = join(workspace, "first.tar.gz");
    const secondArchive = join(workspace, "second.tar.gz");

    await writeDeterministicTarGzip({
      sourceDirectory,
      entryNames: ["dist", "package.json"],
      outputPath: firstArchive,
    });

    // Source mtimes are environmental metadata, not release content. Changing
    // them between packs proves they cannot leak into either tar or gzip.
    const later = new Date("2040-01-02T03:04:05.000Z");
    await utimes(join(sourceDirectory, "dist", "index.mjs"), later, later);
    await utimes(join(sourceDirectory, "package.json"), later, later);

    await writeDeterministicTarGzip({
      sourceDirectory,
      entryNames: ["package.json", "dist"],
      outputPath: secondArchive,
    });

    const first = await readFile(firstArchive);
    const second = await readFile(secondArchive);
    expect(second).toEqual(first);
    expect(createHash("sha256").update(second).digest("hex")).toBe(
      createHash("sha256").update(first).digest("hex"),
    );
    expect(first.subarray(4, 8)).toEqual(Buffer.alloc(4));

    const firstTarHeader = gunzipSync(first).subarray(0, 512);
    expect(firstTarHeader.subarray(108, 116).toString("ascii")).toBe("0000000\0");
    expect(firstTarHeader.subarray(116, 124).toString("ascii")).toBe("0000000\0");
    expect(firstTarHeader.subarray(136, 148).toString("ascii")).toBe("00000000000\0");
    expect(firstTarHeader.subarray(265, 297).toString("utf8").replaceAll("\0", "")).toBe("root");
    expect(firstTarHeader.subarray(297, 329).toString("utf8").replaceAll("\0", "")).toBe("root");

    const { stdout } = await execFileAsync("tar", ["-tzf", firstArchive], {
      encoding: "utf8",
    });
    expect(stdout.trim().split("\n")).toEqual([
      "dist/",
      "dist/index.mjs",
      "dist/nested/",
      "dist/nested/asset.txt",
      "package.json",
    ]);

    const extracted = join(workspace, "extracted");
    await mkdir(extracted);
    await execFileAsync("tar", ["-xzf", firstArchive, "-C", extracted]);
    await expect(readFile(join(extracted, "dist", "nested", "asset.txt"), "utf8")).resolves.toBe(
      "asset\n",
    );
    expect((await stat(join(extracted, "dist", "index.mjs"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(extracted, "package.json"))).mode & 0o777).toBe(0o644);
  });
});
