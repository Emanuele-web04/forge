/**
 * CursorAcpCommand tests - regression coverage for Cursor CLI executable/env resolution.
 *
 * Protects the Cursor/Grok collision where the bare `agent` name can belong to
 * Grok while Cursor's current ACP-capable executable is `cursor-agent`, and
 * keeps auth/status subprocesses browserless.
 *
 * @module CursorAcpCommand.test
 */
import { describe, expect, it } from "vitest";

import {
  buildCursorAgentCommand,
  buildCursorAgentHeadlessEnv,
  resolveCursorAgentBinaryPath,
} from "./CursorAcpCommand.ts";

describe("resolveCursorAgentBinaryPath", () => {
  it("defaults to cursor-agent when no binary is configured", () => {
    expect(resolveCursorAgentBinaryPath(undefined)).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath(null)).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("   ")).toBe("cursor-agent");
  });

  it("maps the old ambiguous agent default to cursor-agent", () => {
    expect(resolveCursorAgentBinaryPath("agent")).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("  agent  ")).toBe("cursor-agent");
  });

  it("honors explicit custom Cursor binary paths", () => {
    expect(resolveCursorAgentBinaryPath("cursor-agent")).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("/usr/local/bin/agent")).toBe("/usr/local/bin/agent");
  });

  it("discovers native Windows Cursor Agent installs outside PATH", () => {
    const installedPath = "C:\\Users\\me\\AppData\\Local\\cursor-agent\\agent.exe";
    expect(
      resolveCursorAgentBinaryPath(undefined, {
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "C:\\Windows" },
        pathExists: (path) => path === installedPath,
      }),
    ).toBe(installedPath);
  });

  it("keeps PATH precedence over the native Windows fallback", () => {
    expect(
      resolveCursorAgentBinaryPath(undefined, {
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "C:\\Tools" },
        pathExists: (path) =>
          path.replaceAll("/", "\\") === "C:\\Tools\\cursor-agent.CMD" ||
          path === "C:\\Users\\me\\AppData\\Local\\cursor-agent\\agent.exe",
      }),
    ).toBe("cursor-agent");
  });
});

describe("buildCursorAgentCommand", () => {
  it("runs default Cursor Agent commands directly", () => {
    expect(buildCursorAgentCommand(undefined, ["acp"])).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(buildCursorAgentCommand("agent", ["models"])).toEqual({
      command: "cursor-agent",
      args: ["models"],
    });
  });

  it("normalizes Cursor editor launchers before appending agent args", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor-agent",
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(
      buildCursorAgentCommand(
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        ["models"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      args: ["agent", "models"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["--version"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
      args: ["agent", "--version"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["--version"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.exe",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.exe",
      args: ["--version"],
    });
  });

  it("does not use adjacent generic agent commands for bare cursor launchers", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor" || path === "/tools/agent",
      }),
    ).toEqual({
      command: "cursor",
      args: ["agent", "acp"],
    });
  });

  it("falls back through Cursor editor launchers when no agent command can be resolved", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor",
      }),
    ).toEqual({
      command: "cursor",
      args: ["agent", "acp"],
    });
  });

  it("falls back to PATH cursor-agent before inventing an agent sibling", () => {
    expect(
      buildCursorAgentCommand("/missing/bin/cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor-agent",
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
  });

  it("prefers PATH cursor-agent over sibling legacy agent commands", () => {
    expect(
      buildCursorAgentCommand("/usr/local/bin/cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/usr/local/bin/agent" || path === "/tools/cursor-agent",
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
  });

  it("uses bundled sibling agent commands for Cursor-owned editor paths", () => {
    const cursorPath = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const agentPath = "/Applications/Cursor.app/Contents/Resources/app/bin/agent";
    const cursorSymlinkPath = "/usr/local/bin/cursor";
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/Applications/Cursor.app/Contents/Resources/app/bin" },
        pathExists: (path) => path === cursorPath || path === agentPath,
      }),
    ).toEqual({
      command: agentPath,
      args: ["acp"],
    });

    expect(
      buildCursorAgentCommand("cursor", ["models"], {
        env: { PATH: "/usr/local/bin" },
        pathExists: (path) => path === cursorSymlinkPath || path === agentPath,
        realpath: (path) => (path === cursorSymlinkPath ? cursorPath : path),
      }),
    ).toEqual({
      command: agentPath,
      args: ["models"],
    });

    expect(
      buildCursorAgentCommand(cursorPath, ["acp"], {
        env: { PATH: "" },
        pathExists: (path) => path === agentPath,
      }),
    ).toEqual({
      command: agentPath,
      args: ["acp"],
    });

    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["status"],
        {
          env: { PATH: "" },
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.cmd",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.cmd",
      args: ["status"],
    });
  });

  it("ignores adjacent generic agent commands for configured Cursor editor paths", () => {
    expect(
      buildCursorAgentCommand("/usr/local/bin/cursor", ["acp"], {
        env: { PATH: "" },
        pathExists: (path) => path === "/usr/local/bin/agent",
      }),
    ).toEqual({
      command: "/usr/local/bin/cursor",
      args: ["agent", "acp"],
    });
  });

  it("prefers safer Windows shims but accepts PowerShell-only Cursor agent siblings", () => {
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["acp"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.ps1" ||
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.cmd",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.cmd",
      args: ["acp"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["status"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.ps1",
        },
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.ps1",
        "status",
      ],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["models"],
        {
          env: { PATH: "" },
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.ps1",
        },
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.ps1",
        "models",
      ],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        ["status"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.ps1",
        "agent",
        "status",
      ],
    });
  });

  it("prefers a sibling cursor-agent when a Cursor shim path is configured", () => {
    expect(
      buildCursorAgentCommand("/Users/me/.local/bin/cursor", ["acp"], {
        pathExists: (path) => path === "/Users/me/.local/bin/cursor-agent",
      }),
    ).toEqual({
      command: "/Users/me/.local/bin/cursor-agent",
      args: ["acp"],
    });
  });

  it("honors explicit agent paths without adding another subcommand", () => {
    expect(buildCursorAgentCommand("/Users/me/.local/bin/agent", ["acp"])).toEqual({
      command: "/Users/me/.local/bin/agent",
      args: ["acp"],
    });
    expect(buildCursorAgentCommand("/Users/me/.local/bin/cursor-agent", ["acp"])).toEqual({
      command: "/Users/me/.local/bin/cursor-agent",
      args: ["acp"],
    });
  });
});

describe("buildCursorAgentHeadlessEnv", () => {
  it("forces Cursor probe subprocesses into headless mode while preserving the base env", () => {
    expect(buildCursorAgentHeadlessEnv({ PATH: "/bin", BROWSER: "open" })).toMatchObject({
      PATH: "/bin",
      NO_BROWSER: "true",
      BROWSER: "www-browser",
      CI: "true",
      DEBIAN_FRONTEND: "noninteractive",
    });
  });
});
