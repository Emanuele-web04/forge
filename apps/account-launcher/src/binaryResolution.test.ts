import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRealBinary } from "./binaryResolution.ts";

let base: string;
let shimDir: string;
let realDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "synara-binres-test-"));
  shimDir = path.join(base, "shims");
  realDir = path.join(base, "real");
  fs.mkdirSync(shimDir);
  fs.mkdirSync(realDir);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function writeExecutable(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "#!/bin/sh\n");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

describe("resolveRealBinary", () => {
  it("skips the shim directory and finds the real binary", () => {
    writeExecutable(shimDir, "codex");
    const real = writeExecutable(realDir, "codex");
    const resolved = resolveRealBinary({
      command: "codex",
      pathEnv: [shimDir, realDir].join(path.delimiter),
      shimDir,
    });
    expect(resolved).toBe(fs.realpathSync(real));
  });

  it("rejects candidates that canonicalize into the shim directory", () => {
    const shim = writeExecutable(shimDir, "codex");
    const linkDir = path.join(base, "links");
    fs.mkdirSync(linkDir);
    fs.symlinkSync(shim, path.join(linkDir, "codex"));
    const resolved = resolveRealBinary({ command: "codex", pathEnv: linkDir, shimDir });
    expect(resolved).toBeNull();
  });

  it("excludes every listed shim directory", () => {
    const installedDir = path.join(base, "installed-shims");
    fs.mkdirSync(installedDir);
    writeExecutable(shimDir, "codex");
    writeExecutable(installedDir, "codex");
    const real = writeExecutable(realDir, "codex");
    const resolved = resolveRealBinary({
      command: "codex",
      pathEnv: [installedDir, shimDir, realDir].join(path.delimiter),
      shimDir: [shimDir, installedDir],
    });
    expect(resolved).toBe(fs.realpathSync(real));
  });

  it("skips non-executable files on unix", () => {
    fs.writeFileSync(path.join(realDir, "codex"), "not executable");
    fs.chmodSync(path.join(realDir, "codex"), 0o644);
    const resolved = resolveRealBinary({
      command: "codex",
      pathEnv: realDir,
      shimDir,
      platform: "linux",
    });
    expect(resolved).toBeNull();
  });

  it("returns null when the binary is missing", () => {
    expect(resolveRealBinary({ command: "codex", pathEnv: realDir, shimDir })).toBeNull();
  });

  describe("windows semantics", () => {
    it("splits PATH on ';' and matches PATHEXT extensions", () => {
      const real = writeExecutable(realDir, "codex.exe");
      const resolved = resolveRealBinary({
        command: "codex",
        pathEnv: [shimDir, realDir].join(";"),
        shimDir,
        platform: "win32",
        pathExtEnv: ".COM;.EXE",
      });
      // Windows filesystems are case-insensitive: the resolver may return the
      // PATHEXT entry's case rather than the on-disk case. Compare
      // case-insensitively so this also passes on macOS/Windows checkouts.
      expect(resolved?.toLowerCase()).toBe(fs.realpathSync(real).toLowerCase());
    });

    it("matches lowercase extensions for uppercase PATHEXT entries", () => {
      const real = writeExecutable(realDir, "codex.cmd");
      const resolved = resolveRealBinary({
        command: "codex",
        pathEnv: realDir,
        shimDir,
        platform: "win32",
        pathExtEnv: ".EXE;.CMD",
      });
      expect(resolved?.toLowerCase()).toBe(fs.realpathSync(real).toLowerCase());
    });

    it("does not treat ':' as a PATH separator on win32", () => {
      writeExecutable(realDir, "codex.exe");
      const resolved = resolveRealBinary({
        command: "codex",
        // A single (invalid) entry on win32; would be two entries on posix.
        pathEnv: [realDir, realDir].join(":"),
        shimDir,
        platform: "win32",
        pathExtEnv: ".EXE",
      });
      expect(resolved).toBeNull();
    });

    it("still excludes the shim directory on win32", () => {
      writeExecutable(shimDir, "codex.exe");
      const resolved = resolveRealBinary({
        command: "codex",
        pathEnv: shimDir,
        shimDir,
        platform: "win32",
        pathExtEnv: ".EXE",
      });
      expect(resolved).toBeNull();
    });

    it("returns files without the executable bit on win32 (PATHEXT is the check)", () => {
      const filePath = path.join(realDir, "codex.exe");
      fs.writeFileSync(filePath, "MZ");
      fs.chmodSync(filePath, 0o644);
      const resolved = resolveRealBinary({
        command: "codex",
        pathEnv: realDir,
        shimDir,
        platform: "win32",
        pathExtEnv: ".EXE",
      });
      expect(resolved?.toLowerCase()).toBe(fs.realpathSync(filePath).toLowerCase());
    });
  });
});
