// FILE: windowsProcess.ts
// Purpose: Prepares Windows child-process launches without Node's `shell: true`.
// Layer: Shared Node runtime utility
// Exports: command resolution plus safe spawn/spawnSync argument preparation.

import { spawnSync } from "node:child_process";
import * as Path from "node:path";

type SpawnSyncLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    encoding: "utf8";
    shell: false;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: true;
  },
) => { stdout?: string | null; status?: number | null; error?: Error | undefined };

export interface WindowsSafeProcessInput {
  readonly platform?: NodeJS.Platform | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly spawnSync?: SpawnSyncLike | undefined;
}

export interface WindowsSafeProcessCommand {
  readonly command: string;
  readonly args: string[];
  readonly shell: false;
  readonly windowsHide?: true;
  readonly windowsVerbatimArguments?: true;
}

export interface WindowsWslUncPath {
  readonly distribution: string;
  readonly linuxPath: string;
}

const WINDOWS_BATCH_EXTENSION_PATTERN = /\.(?:cmd|bat)$/i;
const WINDOWS_SPAWN_SAFE_EXTENSION_PATTERN = /\.(?:exe|com|cmd|bat)$/i;
const WINDOWS_PATH_SEPARATOR_PATTERN = /[\\/]/;
const WINDOWS_BATCH_UNSAFE_TOKEN_PATTERN = /[\r\n&|<>^%]/;
const WINDOWS_WSL_UNC_PATTERN = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i;
const WHERE_TIMEOUT_MS = 2_000;

function trimNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmpty(env.SystemRoot) ?? trimNonEmpty(env.SYSTEMROOT) ?? "C:\\Windows";
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
  return (
    trimNonEmpty(env.ComSpec) ??
    trimNonEmpty(env.COMSPEC) ??
    Path.win32.join(resolveWindowsSystemRoot(env), "System32", "cmd.exe")
  );
}

export function resolveWindowsWslExe(env: NodeJS.ProcessEnv = process.env): string {
  return Path.win32.join(resolveWindowsSystemRoot(env), "System32", "wsl.exe");
}

function resolveWindowsWhereExe(env: NodeJS.ProcessEnv = process.env): string {
  return Path.win32.join(resolveWindowsSystemRoot(env), "System32", "where.exe");
}

export function parseWindowsWslUncPath(value: string): WindowsWslUncPath | null {
  const match = WINDOWS_WSL_UNC_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const distribution = match[1]?.trim() ?? "";
  if (!distribution) {
    return null;
  }

  const suffix = match[2] ?? "";
  const linuxPath = `/${suffix
    .split("\\")
    .filter((segment) => segment.length > 0)
    .join("/")}`;
  return {
    distribution,
    linuxPath: linuxPath === "/" ? "/" : linuxPath,
  };
}

export function isWindowsBatchCommand(command: string): boolean {
  return WINDOWS_BATCH_EXTENSION_PATTERN.test(command);
}

function quoteWindowsBatchToken(token: string, label: string): string {
  if (WINDOWS_BATCH_UNSAFE_TOKEN_PATTERN.test(token)) {
    throw new Error(
      `Cannot safely execute Windows batch ${label} containing cmd.exe control characters.`,
    );
  }
  return `"${token.replaceAll('"', '""')}"`;
}

export function buildWindowsBatchCommandArgs(
  command: string,
  args: ReadonlyArray<string>,
): string[] {
  // Keep cmd.exe's semantic command line together so quote-bearing arguments
  // are encoded for cmd instead of independently escaped as C-runtime argv.
  // The call prefix also keeps /s from stripping the executable's outer quotes.
  const commandLine = [
    "call",
    quoteWindowsBatchToken(command, "command"),
    ...args.map((arg) => quoteWindowsBatchToken(arg, "argument")),
  ].join(" ");
  return ["/d", "/s", "/v:off", "/c", commandLine];
}

function isPathLikeCommand(command: string): boolean {
  return WINDOWS_PATH_SEPARATOR_PATTERN.test(command) || Path.win32.isAbsolute(command);
}

function hasWindowsExecutableExtension(command: string): boolean {
  return Path.win32.extname(command).length > 0;
}

function isFromCurrentDirectory(candidate: string, cwd: string | undefined): boolean {
  if (!cwd) {
    return false;
  }
  const candidateDir = Path.win32.resolve(Path.win32.dirname(candidate)).toLowerCase();
  const currentDir = Path.win32.resolve(cwd).toLowerCase();
  return candidateDir === currentDir;
}

function isWindowsSpawnSafeResolvedCommand(command: string): boolean {
  return WINDOWS_SPAWN_SAFE_EXTENSION_PATTERN.test(command);
}

function selectWindowsCommandCandidate(
  candidates: ReadonlyArray<string>,
  cwd: string | undefined,
  pathLikeCommand: boolean,
): string | undefined {
  const allowedCandidates = pathLikeCommand
    ? candidates
    : candidates.filter((candidate) => !isFromCurrentDirectory(candidate, cwd));
  return allowedCandidates.find(isWindowsSpawnSafeResolvedCommand) ?? allowedCandidates[0];
}

// Resolve PATH/PATHEXT commands through where.exe so `.cmd` shims can be wrapped
// explicitly. Prefer candidates that native spawn can execute or that we can
// wrap, and skip current-directory hits for PATH commands to avoid restoring
// shell-style CWD command hijacking.
export function resolveWindowsCommandPath(
  command: string,
  input: WindowsSafeProcessInput = {},
): string {
  const pathLikeCommand = isPathLikeCommand(command);
  if (pathLikeCommand && hasWindowsExecutableExtension(command)) {
    return command;
  }

  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const result = (input.spawnSync ?? spawnSync)(resolveWindowsWhereExe(env), [command], {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: WHERE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return command;
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return selectWindowsCommandCandidate(candidates, cwd, pathLikeCommand) ?? command;
}

export function prepareWindowsSafeProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: WindowsSafeProcessInput = {},
): WindowsSafeProcessCommand {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const env = input.env ?? process.env;
  const wslWorkspace = input.cwd ? parseWindowsWslUncPath(input.cwd) : null;
  if (wslWorkspace) {
    return {
      command: resolveWindowsWslExe(env),
      args: [
        "--distribution",
        wslWorkspace.distribution,
        "--cd",
        wslWorkspace.linuxPath,
        "--exec",
        command,
        ...args,
      ],
      shell: false,
      windowsHide: true,
    };
  }

  const resolvedCommand = resolveWindowsCommandPath(command, input);
  if (!isWindowsBatchCommand(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args: [...args],
      shell: false,
      windowsHide: true,
    };
  }

  return {
    command: resolveWindowsComSpec(env),
    args: buildWindowsBatchCommandArgs(resolvedCommand, args),
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  };
}
