// FILE: providerUsage/providers/cursor.test.ts
// Purpose: Cursor usage looks up state.vscdb with each OS's real Cursor user-data path.

import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { cursorStateDbPaths } from "./cursor";

describe("cursorStateDbPaths", () => {
  it("uses Application Support on macOS", () => {
    expect(
      cursorStateDbPaths({
        homeDir: "/Users/tester",
        env: {},
        platform: "darwin",
      }),
    ).toEqual([
      nodePath.join(
        "/Users/tester",
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]);
  });

  it("uses %APPDATA% on Windows, and falls back to ~/AppData/Roaming when unset", () => {
    const homeDir = "C:\\Users\\tester";
    expect(
      cursorStateDbPaths({
        homeDir,
        env: { APPDATA: nodePath.join(homeDir, "AppData", "Roaming") },
        platform: "win32",
      }),
    ).toEqual([
      nodePath.join(
        homeDir,
        "AppData",
        "Roaming",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]);
    expect(
      cursorStateDbPaths({
        homeDir,
        env: {},
        platform: "win32",
      }),
    ).toEqual([
      nodePath.join(
        homeDir,
        "AppData",
        "Roaming",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]);
  });

  it("honors XDG_CONFIG_HOME on Linux", () => {
    expect(
      cursorStateDbPaths({
        homeDir: "/home/tester",
        env: { XDG_CONFIG_HOME: "/tmp/xdg-config" },
        platform: "linux",
      }),
    ).toEqual([nodePath.join("/tmp/xdg-config", "Cursor", "User", "globalStorage", "state.vscdb")]);
  });
});
