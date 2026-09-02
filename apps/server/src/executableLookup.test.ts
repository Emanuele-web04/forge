// FILE: executableLookup.test.ts
// Purpose: Pin the PATH/PATHEXT rules now shared by editor discovery, terminal wrappers,
//          provider maintenance and the Codex version gate. The win32 cases run on any host
//          because the platform is injected and only affects PATH/PATHEXT semantics.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executableCandidates,
  executableIdentity,
  executableNameCandidates,
  hasPathSeparator,
  isExecutableFile,
  pathEntries,
  resolveExecutable,
  windowsPathExtensions,
} from "./executableLookup.ts";

const WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "synara-exec-lookup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pathEntries", () => {
  it("splits on the platform delimiter and drops blanks", () => {
    expect(pathEntries({ PATH: "/a: /b ::/c" }, "darwin")).toEqual(["/a", "/b", "/c"]);
    expect(pathEntries({ PATH: "C:\\a;C:\\b;;" }, "win32")).toEqual(["C:\\a", "C:\\b"]);
  });

  it("unquotes entries, which Windows tolerates in PATH", () => {
    expect(pathEntries({ PATH: '"C:\\Program Files\\x";C:\\b' }, "win32")).toEqual([
      "C:\\Program Files\\x",
      "C:\\b",
    ]);
  });

  it("reads PATH under any capitalization and distinguishes absent from empty on POSIX", () => {
    expect(pathEntries({ Path: "/a" }, "darwin")).toEqual(["/a"]);
    expect(pathEntries({ path: "/a" }, "darwin")).toEqual(["/a"]);
    expect(pathEntries({}, "darwin")).toEqual(["/usr/bin", "/bin"]);
    expect(pathEntries({ PATH: "" }, "darwin")).toEqual([]);
  });
});

describe("windowsPathExtensions", () => {
  it("falls back to the standard set when PATHEXT is absent or unusable", () => {
    expect(windowsPathExtensions({})).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
    expect(windowsPathExtensions({ PATHEXT: ";;" })).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });

  it("normalizes case, whitespace and a missing leading dot", () => {
    expect(windowsPathExtensions({ PATHEXT: ".exe; cmd ;.EXE" })).toEqual([".EXE", ".CMD"]);
  });
});

describe("executableNameCandidates", () => {
  it("leaves the command alone off Windows", () => {
    expect(executableNameCandidates("codex", "darwin", {})).toEqual(["codex"]);
  });

  it("appends PATHEXT in both cases on win32", () => {
    expect(executableNameCandidates("code", "win32", { PATHEXT: ".EXE;.CMD" })).toEqual([
      "code.EXE",
      "code.exe",
      "code.CMD",
      "code.cmd",
    ]);
  });

  it("keeps a command that already carries a known extension", () => {
    expect(executableNameCandidates("code.CMD", "win32", { PATHEXT: WINDOWS_PATHEXT })).toEqual([
      "code.CMD",
      "code.cmd",
    ]);
  });

  it("treats an unknown extension as part of the name", () => {
    expect(executableNameCandidates("my.tool", "win32", { PATHEXT: ".CMD" })).toEqual([
      "my.tool.CMD",
      "my.tool.cmd",
    ]);
  });

  it("offers the bare name first only when the caller opts in", () => {
    expect(executableNameCandidates("codex", "win32", { PATHEXT: ".EXE" }, true)).toEqual([
      "codex",
      "codex.EXE",
      "codex.exe",
    ]);
  });
});

describe("executableCandidates", () => {
  it("walks PATH entries in order, trying every name within each", () => {
    const candidates = [
      ...executableCandidates("code", {
        platform: "win32",
        env: { PATH: `${path.join("/first")};${path.join("/second")}`, PATHEXT: ".EXE" },
      }),
    ];
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      path.join("/first", "code.EXE"),
      path.join("/first", "code.exe"),
      path.join("/second", "code.EXE"),
      path.join("/second", "code.exe"),
    ]);
    expect(candidates[0]?.directory).toBe(path.join("/first"));
  });

  it("ignores PATH entirely for a command that already names a location", () => {
    const candidates = [
      ...executableCandidates("/opt/bin/codex", { platform: "darwin", env: { PATH: "/never" } }),
    ];
    expect(candidates).toEqual([{ directory: "/opt/bin", path: "/opt/bin/codex" }]);
  });

  it("splits a qualified command on whichever separator it uses, not the host's", () => {
    // `node:path`'s dirname would report "." for this on a POSIX host, silently mislabelling the
    // directory the caller is told the binary came from.
    const candidates = [
      ...executableCandidates("C:\\bin\\codex.EXE", {
        platform: "win32",
        env: { PATH: "C:\\never", PATHEXT: WINDOWS_PATHEXT },
      }),
    ];
    expect(candidates.map((candidate) => candidate.directory)).toEqual(["C:\\bin", "C:\\bin"]);
  });

  it("reports the root as the directory for a command directly under it", () => {
    const candidates = [...executableCandidates("/codex", { platform: "darwin", env: {} })];
    expect(candidates).toEqual([{ directory: "/", path: "/codex" }]);
  });

  it("reports the current directory for a relative command", () => {
    const candidates = [...executableCandidates("./codex", { platform: "darwin", env: {} })];
    expect(candidates).toEqual([{ directory: ".", path: "./codex" }]);
  });
});

describe("isExecutableFile", () => {
  it("requires the executable bit off Windows", () => {
    const runnable = path.join(dir, "runnable");
    const plain = path.join(dir, "plain");
    writeFileSync(runnable, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(plain, "data", { mode: 0o644 });

    expect(isExecutableFile(runnable, { platform: "darwin" })).toBe(true);
    expect(isExecutableFile(plain, { platform: "darwin" })).toBe(false);
    expect(isExecutableFile(dir, { platform: "darwin" })).toBe(false);
    expect(isExecutableFile(path.join(dir, "absent"), { platform: "darwin" })).toBe(false);
  });

  it("requires a PATHEXT extension on win32, where every file is readable-executable", () => {
    const script = path.join(dir, "tool.CMD");
    const bare = path.join(dir, "tool");
    writeFileSync(script, "@echo off\r\n", { mode: 0o644 });
    writeFileSync(bare, "@echo off\r\n", { mode: 0o755 });

    const env = { PATHEXT: WINDOWS_PATHEXT };
    expect(isExecutableFile(script, { platform: "win32", env })).toBe(true);
    expect(isExecutableFile(bare, { platform: "win32", env })).toBe(false);
  });
});

describe("resolveExecutable", () => {
  it("returns the first PATH hit", () => {
    const second = mkdtempSync(path.join(os.tmpdir(), "synara-exec-lookup-2-"));
    try {
      writeFileSync(path.join(second, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      expect(
        resolveExecutable("codex", {
          platform: "darwin",
          env: { PATH: `${dir}:${second}` },
        }),
      ).toBe(path.join(second, "codex"));

      writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      expect(
        resolveExecutable("codex", {
          platform: "darwin",
          env: { PATH: `${dir}:${second}` },
        }),
      ).toBe(path.join(dir, "codex"));
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("resolves a PATHEXT variant on win32", () => {
    writeFileSync(path.join(dir, "code.CMD"), "@echo off\r\n", { mode: 0o644 });
    expect(
      resolveExecutable("code", {
        platform: "win32",
        env: { PATH: dir, PATHEXT: WINDOWS_PATHEXT },
      }),
    ).toBe(path.join(dir, "code.CMD"));
  });

  it("returns null when nothing on PATH matches", () => {
    expect(resolveExecutable("absent", { platform: "darwin", env: { PATH: dir } })).toBeNull();
  });
});

describe("executableIdentity", () => {
  it("changes when the file behind a stable path is replaced", () => {
    const target = path.join(dir, "codex");
    writeFileSync(target, "one", { mode: 0o755 });
    const before = executableIdentity(target);

    writeFileSync(target, "two-but-longer", { mode: 0o755 });
    expect(executableIdentity(target)).not.toBe(before);
  });

  it("changes on a same-size rewrite, because mtime moves", () => {
    const target = path.join(dir, "codex");
    writeFileSync(target, "one", { mode: 0o755 });
    const before = executableIdentity(target);

    writeFileSync(target, "two", { mode: 0o755 });
    utimesSync(target, new Date(0), new Date(1_700_000_000_000));
    expect(executableIdentity(target)).not.toBe(before);
  });

  it("is null for a path that cannot be stat'ed", () => {
    expect(executableIdentity(path.join(dir, "absent"))).toBeNull();
  });
});

describe("hasPathSeparator", () => {
  it("recognizes both separators regardless of host", () => {
    expect(hasPathSeparator("codex")).toBe(false);
    expect(hasPathSeparator("./codex")).toBe(true);
    expect(hasPathSeparator("C:\\bin\\codex.exe")).toBe(true);
  });
});
