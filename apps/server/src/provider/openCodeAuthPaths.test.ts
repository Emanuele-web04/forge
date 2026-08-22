// FILE: openCodeAuthPaths.test.ts
// Purpose: Locks OpenCode/Kilo auth.json discovery so Windows does not prefer %APPDATA%
// over the XDG path OpenCode actually uses, and so Linux/macOS never consult AppData.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOpenCodeAuthFileUtf8, resolveOpenCodeCompatibleAuthPaths } from "./openCodeAuthPaths";

describe("resolveOpenCodeCompatibleAuthPaths", () => {
  it("uses ~/.local/share on Linux and does not consult AppData", () => {
    const homeDir = "/home/tester";
    const paths = resolveOpenCodeCompatibleAuthPaths({
      homeDir,
      env: {},
      platform: "linux",
      dataDirectoryName: "opencode",
    });
    expect(paths).toEqual([nodePath.join(homeDir, ".local", "share", "opencode", "auth.json")]);
    expect(paths.some((value) => /appdata/i.test(value))).toBe(false);
  });

  it("uses ~/.local/share on macOS, not Library/Application Support", () => {
    const homeDir = "/Users/tester";
    const paths = resolveOpenCodeCompatibleAuthPaths({
      homeDir,
      env: {},
      platform: "darwin",
      dataDirectoryName: "opencode",
    });
    expect(paths).toEqual([nodePath.join(homeDir, ".local", "share", "opencode", "auth.json")]);
    expect(paths.some((value) => value.includes("Application Support"))).toBe(false);
  });

  it("prefers the Windows XDG path, then APPDATA and LOCALAPPDATA fallbacks", () => {
    const homeDir = "C:\\Users\\tester";
    const roaming = nodePath.join(homeDir, "AppData", "Roaming");
    const local = nodePath.join(homeDir, "AppData", "Local");
    const paths = resolveOpenCodeCompatibleAuthPaths({
      homeDir,
      env: { APPDATA: roaming, LOCALAPPDATA: local },
      platform: "win32",
      dataDirectoryName: "opencode",
    });
    expect(paths).toEqual([
      nodePath.join(homeDir, ".local", "share", "opencode", "auth.json"),
      nodePath.join(roaming, "opencode", "auth.json"),
      nodePath.join(local, "opencode", "auth.json"),
    ]);
  });

  it("honors XDG_DATA_HOME on every platform before the default ~/.local/share path", () => {
    const homeDir = "/Users/tester";
    const paths = resolveOpenCodeCompatibleAuthPaths({
      homeDir,
      env: { XDG_DATA_HOME: "/tmp/xdg-data" },
      platform: "darwin",
      dataDirectoryName: "kilo",
    });
    expect(paths).toEqual([
      nodePath.join("/tmp/xdg-data", "kilo", "auth.json"),
      nodePath.join(homeDir, ".local", "share", "kilo", "auth.json"),
    ]);
  });

  it("honors OPENCODE_DATA_DIR and KILO_DATA_DIR overrides first", () => {
    expect(
      resolveOpenCodeCompatibleAuthPaths({
        homeDir: "/home/tester",
        env: { OPENCODE_DATA_DIR: "/custom/opencode-data" },
        platform: "linux",
        dataDirectoryName: "opencode",
      })[0],
    ).toBe(nodePath.join("/custom/opencode-data", "auth.json"));
    expect(
      resolveOpenCodeCompatibleAuthPaths({
        homeDir: "/home/tester",
        env: { KILO_DATA_DIR: "/custom/kilo-data" },
        platform: "linux",
        dataDirectoryName: "kilo",
      })[0],
    ).toBe(nodePath.join("/custom/kilo-data", "auth.json"));
  });
});

describe("readOpenCodeAuthFileUtf8", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads ~/.local/share even when a Windows APPDATA candidate is also configured", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-opencode-auth-"));
    tempDirs.push(homeDir);
    const xdgPath = nodePath.join(homeDir, ".local", "share", "opencode", "auth.json");
    mkdirSync(nodePath.dirname(xdgPath), { recursive: true });
    writeFileSync(xdgPath, '{"opencode-go":{"type":"api"}}', "utf8");

    const content = await readOpenCodeAuthFileUtf8({
      homeDir,
      env: { APPDATA: nodePath.join(homeDir, "AppData", "Roaming") },
      platform: "win32",
      dataDirectoryName: "opencode",
    });
    expect(content).toContain("opencode-go");
  });
});
