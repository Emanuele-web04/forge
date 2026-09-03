// FILE: effectProcessRuntime.test.ts
// Purpose: Verifies shared Windows launch decisions reach Effect child-process commands.
// Layer: Server platform runtime test

import { describe, expect, it } from "vitest";

import { makeEffectProcessCommand } from "./effectProcessRuntime";

describe("makeEffectProcessCommand", () => {
  it("keeps PowerShell provider probes hidden on Windows", () => {
    const command = makeEffectProcessCommand("cursor-agent.ps1", ["--version"], {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(command).toMatchObject({
      _tag: "StandardCommand",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "cursor-agent.ps1",
        "--version",
      ],
      options: {
        shell: false,
        windowsHide: true,
      },
    });
  });
});
