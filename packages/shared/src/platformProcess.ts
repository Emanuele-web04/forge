// FILE: platformProcess.ts
// Purpose: Plans shell-free child-process launches behind one cross-platform boundary.
// Layer: Shared platform runtime

import { statSync } from "node:fs";

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

function explicitPowerShellScript(command: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32" || !hasPathSeparator(command) || !/\.ps1$/iu.test(command)) {
    return null;
  }
  try {
    return statSync(command).isFile() ? command : null;
  } catch {
    return null;
  }
}

function nativeExecutable(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  return (
    explicitPowerShellScript(command, platform) ?? resolveExecutable(command, { platform, env })
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

  const resolved = nativeExecutable(command, platform, env);
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
