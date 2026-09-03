// FILE: platformProcess.ts
// Purpose: Plans shell-free child-process launches behind one cross-platform boundary.
// Layer: Shared platform runtime

import { statSync } from "node:fs";
import { win32 } from "node:path";

import { hasPathSeparator, resolveExecutable } from "./executable";
import { resolveWindowsPowerShellExecutable } from "./platformEnvironment";
import {
  parseWindowsWslUncPath,
  prepareWindowsSafeProcess,
  type WindowsSafeProcessCommand,
} from "./windowsProcess";

export type ProcessExecutionBackend = "native" | "wsl";

export interface ProcessLaunchInput {
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Fail before spawn when the native executable cannot be resolved. */
  readonly requireExecutable?: boolean;
}

export interface ProcessLaunchPlan extends WindowsSafeProcessCommand {
  readonly requestedCommand: string;
  readonly resolvedCommand: string;
  readonly executionBackend: ProcessExecutionBackend;
}

export class ExecutableNotFoundError extends Error {
  readonly _tag = "ExecutableNotFoundError";
  readonly command: string;

  constructor(command: string) {
    super(`Command not found: ${command}`);
    this.name = "ExecutableNotFoundError";
    this.command = command;
  }
}

const WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE = 9009;
const WINDOWS_COMMAND_NOT_FOUND_PATTERN = /is not recognized as an internal or external command/iu;

/**
 * True when a finished process reported "command not found" through its exit
 * rather than a spawn error. cmd.exe does this for a `.cmd` shim whose target
 * is missing, so a batch-wrapped launch can only be diagnosed after exit.
 */
export function isCommandNotFoundExit(input: {
  readonly code: number | null;
  readonly stderr: string;
  readonly platform?: NodeJS.Platform;
}): boolean {
  if ((input.platform ?? process.platform) !== "win32") return false;
  if (input.code === WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE) return true;
  return WINDOWS_COMMAND_NOT_FOUND_PATTERN.test(input.stderr);
}

function explicitPowerShellScript(
  command: string,
  platform: NodeJS.Platform,
  cwd: string | undefined,
): string | null {
  if (platform !== "win32" || !hasPathSeparator(command) || !/\.ps1$/iu.test(command)) {
    return null;
  }
  const scriptPath = win32.isAbsolute(command)
    ? command
    : win32.resolve(cwd ?? process.cwd(), command);
  try {
    return statSync(scriptPath).isFile() ? command : null;
  } catch {
    return null;
  }
}

function nativeExecutable(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string | null {
  return (
    explicitPowerShellScript(command, platform, cwd) ??
    resolveExecutable(command, { platform, env, ...(cwd !== undefined ? { cwd } : {}) })
  );
}

/**
 * Converts one logical command into the exact executable/argv pair the host
 * runtime must use. Application and provider code must not reproduce the
 * Windows `.cmd`, `cmd.exe`, PATHEXT, or WSL rules represented here.
 */
export function prepareProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: ProcessLaunchInput = {},
): ProcessLaunchPlan {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const wslWorkspace = platform === "win32" && input.cwd ? parseWindowsWslUncPath(input.cwd) : null;

  if (wslWorkspace) {
    const prepared = prepareWindowsSafeProcess(command, args, {
      platform,
      cwd: input.cwd,
      env,
    });
    return {
      ...prepared,
      requestedCommand: command,
      resolvedCommand: command,
      executionBackend: "wsl",
    };
  }

  const resolved = nativeExecutable(command, platform, env, input.cwd);
  if (input.requireExecutable && resolved === null) {
    throw new ExecutableNotFoundError(command);
  }
  const resolvedCommand = resolved ?? command;

  if (platform !== "win32") {
    return {
      command: resolvedCommand,
      args: [...args],
      shell: false,
      requestedCommand: command,
      resolvedCommand,
      executionBackend: "native",
    };
  }

  if (/\.ps1$/iu.test(resolvedCommand)) {
    return {
      command: resolveWindowsPowerShellExecutable(env),
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedCommand, ...args],
      shell: false,
      windowsHide: true,
      requestedCommand: command,
      resolvedCommand,
      executionBackend: "native",
    };
  }

  const prepared = prepareWindowsSafeProcess(resolvedCommand, args, {
    platform,
    cwd: input.cwd,
    env,
  });
  return {
    ...prepared,
    requestedCommand: command,
    resolvedCommand,
    executionBackend: "native",
  };
}
