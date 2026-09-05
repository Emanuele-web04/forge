// FILE: windowsProcess.test.ts
// Purpose: Verifies Windows process preparation avoids Node shell-mode deprecations.
// Layer: Shared Node runtime utility tests

import { spawnSync as spawnChildSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildWindowsBatchCommandArgs,
  isWindowsBatchCommand,
  prepareWindowsSafeProcess,
  resolveWindowsCommandPath,
  resolveWindowsComSpec,
} from "./windowsProcess";

describe("windowsProcess", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(Path.join(tmpdir(), "synara-windows-resolution-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves non-Windows commands shell-free and otherwise unchanged", () => {
    expect(
      prepareWindowsSafeProcess("codex", ["app-server"], {
        platform: "darwin",
      }),
    ).toEqual({ command: "codex", args: ["app-server"], shell: false });
  });

  it("resolves PATH shims and skips extensionless npm scripts", () => {
    const commandPath = Path.join(root, "codex.CMD");
    writeFileSync(Path.join(root, "codex"), "#!/bin/sh\n");
    writeFileSync(commandPath, "@echo off\r\n");
    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        env: { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }),
    ).toBe(commandPath);
  });

  it("does not search the working directory unless it is on PATH", () => {
    const workingDirectory = Path.join(root, "working");
    const pathDirectory = Path.join(root, "bin");
    mkdirSync(workingDirectory);
    mkdirSync(pathDirectory);
    writeFileSync(Path.join(workingDirectory, "codex.CMD"), "@echo off\r\n");
    const commandPath = Path.join(pathDirectory, "codex.CMD");
    writeFileSync(commandPath, "@echo off\r\n");
    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: workingDirectory,
        env: { PATH: pathDirectory, PATHEXT: ".CMD" },
      }),
    ).toBe(commandPath);
  });

  it("resolves extensionless qualified shims through the same filesystem lookup", () => {
    const command = Path.join(root, "codex");
    writeFileSync(command, "#!/bin/sh\n");
    writeFileSync(`${command}.CMD`, "@echo off\r\n");
    expect(
      resolveWindowsCommandPath(command, {
        platform: "win32",
        env: { PATH: "", PATHEXT: ".CMD" },
      }),
    ).toBe(`${command}.CMD`);
  });

  it("keeps explicit path-like Windows executables without resolving", () => {

    expect(
      resolveWindowsCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(
      resolveWindowsCommandPath("C:\\Program Files\\Codex\\codex.exe", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
      }),
    ).toBe("C:\\Program Files\\Codex\\codex.exe");
  });

  it("wraps filesystem-resolved .cmd shims through cmd.exe without shell true", () => {
    const commandPath = Path.join(root, "codex.CMD");
    writeFileSync(commandPath, "@echo off\r\n");
    for (const command of ["codex", Path.join(root, "codex")]) {
      expect(
        prepareWindowsSafeProcess(command, ["app-server"], {
          platform: "win32",
          env: { PATH: root, PATHEXT: ".CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        }),
      ).toEqual({
        command: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/v:off", "/c", `call "${commandPath}" "app-server"`],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    }
  });

  it("wraps a configured .cmd Codex path without truncating it", () => {
    const customPath = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      prepareWindowsSafeProcess(customPath, ["app-server"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it("encodes one cmd.exe command line with quoted command and argument tokens", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\Users\\Test User\\npm\\tool.cmd", [
        "path with spaces",
        "flag=value",
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\Users\\Test User\\npm\\tool.cmd" "path with spaces" "flag=value"',
    ]);
  });

  it("preserves literal quotes in existing Codex config arguments", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", [
        "exec",
        "--config",
        'approval_policy="never"',
        "--config",
        'model_reasoning_effort="high"',
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools\\codex.cmd" "exec" "--config" "approval_policy=""never""" "--config" "model_reasoning_effort=""high"""',
    ]);
  });

  it("rejects batch tokens with cmd.exe control characters", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\bad%path\\codex.cmd", [])).toThrow(
      /Cannot safely execute Windows batch command/,
    );
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["one&two"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });

  it("allows batch paths with spaces and parentheses", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\Program Files (x86)\\Tool\\tool.cmd", ["--version"]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\Program Files (x86)\\Tool\\tool.cmd" "--version"',
    ]);
  });

  it("quotes batch paths containing parentheses even without spaces", () => {
    expect(buildWindowsBatchCommandArgs("C:\\tools(x86)\\codex.cmd", ["--version"])).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools(x86)\\codex.cmd" "--version"',
    ]);
  });

  it.runIf(process.platform === "win32")(
    "preserves quoted Codex arguments through a real cmd.exe batch launch",
    () => {
      const root = mkdtempSync(Path.join(tmpdir(), "synara-windows-process-"));
      const commandDir = Path.join(root, "tools(x86)");
      const scriptPath = Path.join(commandDir, "capture.mjs");
      const commandPath = Path.join(commandDir, "codex.cmd");
      const expectedArgs = [
        "exec",
        "--config",
        'approval_policy="never"',
        "--config",
        'model_reasoning_effort="high"',
      ];

      try {
        mkdirSync(commandDir);
        writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
        writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0capture.mjs" %*\r\n`);

        const prepared = prepareWindowsSafeProcess(commandPath, expectedArgs, {
          platform: "win32",
          env: process.env,
        });
        const result = spawnChildSync(prepared.command, prepared.args, {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(expectedArgs);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("rejects batch tokens with line breaks", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["line\nbreak"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });

  it("keeps resolved .exe commands direct", () => {
    const commandPath = Path.join(root, "codex.EXE");
    writeFileSync(commandPath, "native");

    expect(
      prepareWindowsSafeProcess("codex", ["--version"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { PATH: root, PATHEXT: ".EXE", SystemRoot: "C:\\Windows" },
      }),
    ).toEqual({
      command: commandPath,
      args: ["--version"],
      shell: false,
      windowsHide: true,
    });
  });

  it("keeps a configured native Codex executable path intact", () => {

    expect(
      prepareWindowsSafeProcess(
        "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
        ["app-server"],
        {
          platform: "win32",
          cwd: "C:\\projects\\synara",
          env: { SystemRoot: "C:\\Windows" },
        },
      ),
    ).toEqual({
      command: "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      args: ["app-server"],
      shell: false,
      windowsHide: true,
    });
  });

  it("resolves ComSpec from environment before falling back", () => {
    expect(resolveWindowsComSpec({ ComSpec: "D:\\cmd.exe" })).toBe("D:\\cmd.exe");
    expect(resolveWindowsComSpec({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
  });

  it("detects batch shims by extension", () => {
    expect(isWindowsBatchCommand("codex.cmd")).toBe(true);
    expect(isWindowsBatchCommand("tool.bat")).toBe(true);
    expect(isWindowsBatchCommand("tool.exe")).toBe(false);
  });
});
