// FILE: windowsWslProcess.test.ts
// Purpose: Verifies WSL workspace process routing stays shell-free and distro-scoped.
// Layer: Shared Node runtime utility tests

import { describe, expect, it, vi } from "vitest";

import {
  parseWindowsWslUncPath,
  prepareWindowsSafeProcess,
  resolveWindowsWslExe,
} from "./windowsProcess";

describe("windowsProcess WSL routing", () => {
  it("parses modern wsl.localhost UNC workspace paths", () => {
    expect(parseWindowsWslUncPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\repo")).toEqual({
      distribution: "Ubuntu-24.04",
      linuxPath: "/home/dev/repo",
    });
  });

  it("parses legacy wsl$ UNC workspace paths", () => {
    expect(parseWindowsWslUncPath("\\\\wsl$\\Debian\\home\\dev\\repo with spaces")).toEqual({
      distribution: "Debian",
      linuxPath: "/home/dev/repo with spaces",
    });
  });

  it("maps a distro root to the Linux filesystem root", () => {
    expect(parseWindowsWslUncPath("\\\\wsl.localhost\\Ubuntu")).toEqual({
      distribution: "Ubuntu",
      linuxPath: "/",
    });
  });

  it("does not classify unrelated UNC shares as WSL workspaces", () => {
    expect(parseWindowsWslUncPath("\\\\server\\share\\repo")).toBeNull();
  });

  it("resolves wsl.exe from SystemRoot", () => {
    expect(resolveWindowsWslExe({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\wsl.exe",
    );
  });

  it("routes commands in WSL workspaces through wsl.exe without where.exe or a shell", () => {
    const spawnSync = vi.fn();

    expect(
      prepareWindowsSafeProcess("copilot", ["--acp", "--stdio"], {
        platform: "win32",
        cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\repo",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\wsl.exe",
      args: [
        "--distribution",
        "Ubuntu-24.04",
        "--cd",
        "/home/dev/repo",
        "--exec",
        "copilot",
        "--acp",
        "--stdio",
      ],
      shell: false,
      windowsHide: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("preserves command arguments literally instead of invoking a Linux shell", () => {
    const prepared = prepareWindowsSafeProcess("tool", ["one&two", "$(touch nope)", "café"], {
      platform: "win32",
      cwd: "\\\\wsl$\\Ubuntu\\home\\dev\\repo",
      env: { SystemRoot: "C:\\Windows" },
      spawnSync: vi.fn(),
    });

    expect(prepared.args.slice(-4)).toEqual(["tool", "one&two", "$(touch nope)", "café"]);
    expect(prepared.shell).toBe(false);
    expect(prepared.windowsVerbatimArguments).toBeUndefined();
  });
});
