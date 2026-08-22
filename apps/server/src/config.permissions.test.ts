import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  deriveServerPaths,
  preparePrivateServerPaths,
  PRIVATE_STATE_REPAIR_MARKER,
  ServerConfig,
} from "./config";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  repairPrivateFile,
  repairPrivateFileSync,
} from "./privatePathPermissions";
import { writeFileStringAtomically } from "./atomicWrite";
import {
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./provider/providerStatusCache";

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-private-state-"));
  tempDirs.add(tempDir);
  return tempDir;
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function derivePaths(baseDir: string) {
  return Effect.runSync(
    deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
  );
}

afterEach(() => {
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe.skipIf(process.platform === "win32")("private server state permissions", () => {
  it("creates a fresh home with private state directories", () => {
    const paths = derivePaths(makeTempDir());

    preparePrivateServerPaths(paths);

    for (const directoryPath of [
      paths.stateDir,
      paths.secretsDir,
      paths.attachmentsDir,
      paths.logsDir,
      paths.providerLogsDir,
      paths.terminalLogsDir,
    ]) {
      expect(mode(directoryPath)).toBe(PRIVATE_DIRECTORY_MODE);
    }
    expect(mode(path.join(paths.stateDir, PRIVATE_STATE_REPAIR_MARKER))).toBe(PRIVATE_FILE_MODE);
    expect(mode(paths.dbPath)).toBe(PRIVATE_FILE_MODE);
  });

  it("creates representative fresh state files with owner-only permissions", async () => {
    const paths = derivePaths(makeTempDir());
    preparePrivateServerPaths(paths);
    const providerCachePath = resolveProviderStatusCachePath({
      stateDir: paths.stateDir,
      provider: "codex",
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        for (const filePath of [
          paths.settingsPath,
          paths.serverRuntimeStatePath,
          paths.environmentIdPath,
        ]) {
          yield* writeFileStringAtomically({ filePath, contents: "private\n" });
        }
        yield* writeProviderStatusCache({
          filePath: providerCachePath,
          provider: {
            provider: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: new Date().toISOString(),
          },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    for (const filePath of [
      paths.dbPath,
      paths.settingsPath,
      paths.serverRuntimeStatePath,
      paths.environmentIdPath,
      providerCachePath,
    ]) {
      expect(mode(filePath)).toBe(PRIVATE_FILE_MODE);
    }
    expect(mode(path.dirname(providerCachePath))).toBe(PRIVATE_DIRECTORY_MODE);
  });

  it("repairs an upgraded home without following symlinks", () => {
    const baseDir = makeTempDir();
    const paths = derivePaths(baseDir);
    fs.mkdirSync(paths.attachmentsDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(paths.terminalLogsDir, { recursive: true, mode: 0o755 });
    const stateFile = path.join(paths.stateDir, "state.sqlite");
    const attachmentFile = path.join(paths.attachmentsDir, "attachment.bin");
    const executableFile = path.join(paths.terminalLogsDir, "managed-hook.sh");
    fs.writeFileSync(stateFile, "state", { mode: 0o644 });
    fs.writeFileSync(attachmentFile, "attachment", { mode: 0o644 });
    fs.writeFileSync(executableFile, "#!/bin/sh\n", { mode: 0o755 });
    fs.chmodSync(paths.stateDir, 0o755);
    fs.chmodSync(paths.attachmentsDir, 0o755);
    fs.chmodSync(paths.terminalLogsDir, 0o755);

    const outsideFile = path.join(baseDir, "outside.txt");
    const linkedFile = path.join(paths.stateDir, "outside-link");
    fs.writeFileSync(outsideFile, "outside", { mode: 0o644 });
    fs.symlinkSync(outsideFile, linkedFile);

    preparePrivateServerPaths(paths);

    expect(mode(paths.stateDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(paths.attachmentsDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(paths.terminalLogsDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(stateFile)).toBe(PRIVATE_FILE_MODE);
    expect(mode(attachmentFile)).toBe(PRIVATE_FILE_MODE);
    expect(mode(executableFile)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(outsideFile)).toBe(0o644);
  });

  it("rejects a symlinked state root without changing its outside target", () => {
    const baseDir = makeTempDir();
    const paths = derivePaths(baseDir);
    const outsideDir = makeTempDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    fs.writeFileSync(outsideFile, "outside", { mode: 0o644 });
    fs.chmodSync(outsideDir, 0o755);
    fs.symlinkSync(outsideDir, paths.stateDir);

    expect(() => preparePrivateServerPaths(paths)).toThrow(paths.stateDir);
    expect(mode(outsideDir)).toBe(0o755);
    expect(mode(outsideFile)).toBe(0o644);
  });

  it("rejects standalone file-repair symlinks without changing their outside targets", async () => {
    const tempDir = makeTempDir();
    const outsideFile = path.join(tempDir, "outside.txt");
    const syncLink = path.join(tempDir, "sync-link");
    const asyncLink = path.join(tempDir, "async-link");
    fs.writeFileSync(outsideFile, "outside", { mode: 0o644 });
    fs.symlinkSync(outsideFile, syncLink);
    fs.symlinkSync(outsideFile, asyncLink);

    expect(() => repairPrivateFileSync(syncLink)).toThrow(syncLink);
    await expect(repairPrivateFile(asyncLink)).rejects.toThrow(asyncLink);
    expect(mode(outsideFile)).toBe(0o644);
  });

  it("runs the recursive legacy repair only once while always repairing managed directories", () => {
    const paths = derivePaths(makeTempDir());
    preparePrivateServerPaths(paths);
    const laterUnmanagedFile = path.join(paths.stateDir, "later-unmanaged.txt");
    fs.writeFileSync(laterUnmanagedFile, "later", { mode: 0o644 });
    fs.chmodSync(paths.attachmentsDir, 0o755);

    preparePrivateServerPaths(paths);

    expect(mode(paths.attachmentsDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(laterUnmanagedFile)).toBe(0o644);
  });
});

it("does not assume POSIX chmod support on Windows", () => {
  const paths = derivePaths(makeTempDir());
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o755 });
  if (process.platform !== "win32") fs.chmodSync(paths.stateDir, 0o755);

  preparePrivateServerPaths(paths, "win32");

  expect(fs.existsSync(paths.terminalLogsDir)).toBe(true);
  if (process.platform !== "win32") expect(mode(paths.stateDir)).toBe(0o755);
});

it("keeps layerTest state out of the source tree when passed the cwd", async () => {
  const config = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* ServerConfig;
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  expect(path.resolve(config.baseDir)).not.toBe(path.resolve(process.cwd()));
  expect(config.stateDir.startsWith(path.join(process.cwd(), "userdata"))).toBe(false);
});
