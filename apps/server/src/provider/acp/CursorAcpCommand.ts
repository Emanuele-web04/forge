/**
 * CursorAcpCommand - shared command resolution for Cursor's ACP-capable CLI.
 *
 * Keeps the ambiguous legacy `agent` default from colliding with Grok's `agent`
 * executable while still honoring explicit custom Cursor binary paths.
 *
 * @module CursorAcpCommand
 */
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

import { executableCandidates, executableNameCandidates } from "@synara/shared/executable";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";

export const DEFAULT_CURSOR_AGENT_BINARY = "cursor-agent";
export const LEGACY_CURSOR_AGENT_BINARY = "agent";
export const CURSOR_EDITOR_BINARY = "cursor";
export const CURSOR_AGENT_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const satisfies Readonly<Record<string, string>>;
export const CURSOR_AGENT_HEADLESS_PROBE_ENV = {
  ...CURSOR_AGENT_BROWSERLESS_ENV,
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
} as const satisfies Readonly<Record<string, string>>;

export interface CursorAgentCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface CursorAgentCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExists?: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

interface ResolvedCursorAgentCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly pathExists: (path: string) => boolean;
  readonly realpath: (path: string) => string;
}

interface CursorCommandPathParts {
  readonly directory: string;
  readonly extension: string;
  readonly hasDirectory: boolean;
  readonly stem: string;
}

const POWERSHELL_EXECUTABLE = "powershell.exe";
const WINDOWS_CURSOR_SIBLING_EXTENSIONS = [".exe", ".cmd", ".bat", ".ps1"] as const;

function splitCursorCommandPath(command: string): CursorCommandPathParts {
  const trimmed = command.trim();
  const forwardSlash = trimmed.lastIndexOf("/");
  const backslash = trimmed.lastIndexOf("\\");
  const separatorIndex = Math.max(forwardSlash, backslash);
  const hasDirectory = separatorIndex >= 0;
  const directory = hasDirectory ? trimmed.slice(0, separatorIndex + 1) : "";
  const filename = hasDirectory ? trimmed.slice(separatorIndex + 1) : trimmed;
  const extension = path.extname(filename);
  const stem = (extension ? filename.slice(0, -extension.length) : filename).toLowerCase();
  return { directory, extension, hasDirectory, stem };
}

function resolveCursorEditorLauncherCommand(
  command: string,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  const parts = splitCursorCommandPath(command);
  if (parts.stem !== CURSOR_EDITOR_BINARY) {
    return undefined;
  }

  if (!parts.hasDirectory) {
    if (findCommandOnPath(DEFAULT_CURSOR_AGENT_BINARY, options)) {
      return { command: DEFAULT_CURSOR_AGENT_BINARY, args: [] };
    }
    const cursorPath = findCommandOnPath(command, options);
    if (cursorPath) {
      const cursorPathParts = splitCursorCommandPath(
        resolveRealPathForSiblingProbe(cursorPath, options),
      );
      const siblingAgent =
        resolveCursorSiblingAgentCommand(cursorPathParts, options) ??
        resolveTrustedCursorLegacySiblingCommand(cursorPathParts, options);
      if (siblingAgent) {
        return siblingAgent;
      }
    }
    return { command, args: [LEGACY_CURSOR_AGENT_BINARY] };
  }

  const siblingProbeParts = splitCursorCommandPath(
    resolveRealPathForSiblingProbe(command, options),
  );
  const siblingAgent = resolveCursorSiblingCommand(
    siblingProbeParts,
    DEFAULT_CURSOR_AGENT_BINARY,
    options,
  );
  if (siblingAgent) {
    return siblingAgent;
  }
  if (findCommandOnPath(DEFAULT_CURSOR_AGENT_BINARY, options)) {
    return { command: DEFAULT_CURSOR_AGENT_BINARY, args: [] };
  }
  const siblingLegacyAgent = resolveTrustedCursorLegacySiblingCommand(siblingProbeParts, options);
  if (siblingLegacyAgent) {
    return siblingLegacyAgent;
  }
  return { command, args: [LEGACY_CURSOR_AGENT_BINARY] };
}

function resolveCursorSiblingAgentCommand(
  parts: CursorCommandPathParts,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  // Only trust Cursor's named agent binary when deriving from an editor launcher path.
  return resolveCursorSiblingCommand(parts, DEFAULT_CURSOR_AGENT_BINARY, options);
}

function resolveTrustedCursorLegacySiblingCommand(
  parts: CursorCommandPathParts,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  if (!isCursorOwnedLauncherDirectory(parts.directory)) {
    return undefined;
  }
  return resolveCursorSiblingCommand(parts, LEGACY_CURSOR_AGENT_BINARY, options);
}

function resolveRealPathForSiblingProbe(
  command: string,
  options: ResolvedCursorAgentCommandOptions,
): string {
  try {
    return options.realpath(command);
  } catch {
    return command;
  }
}

function isCursorOwnedLauncherDirectory(directory: string): boolean {
  const normalizedDirectory = directory.replaceAll("\\", "/").toLowerCase();
  return (
    normalizedDirectory.includes("/cursor.app/") ||
    normalizedDirectory.includes("/programs/cursor/") ||
    normalizedDirectory.includes("/cursor/resources/app/") ||
    normalizedDirectory.includes("/cursor-agent/")
  );
}

function resolveCursorSiblingCommand(
  parts: CursorCommandPathParts,
  binary: string,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  for (const name of cursorSiblingNameCandidates(parts, binary, options)) {
    const siblingAgent = `${parts.directory}${name}`;
    if (options.pathExists(siblingAgent)) {
      return { command: siblingAgent, args: [] };
    }
  }
  return undefined;
}

function cursorSiblingNameCandidates(
  parts: CursorCommandPathParts,
  binary: string,
  options: ResolvedCursorAgentCommandOptions,
): ReadonlyArray<string> {
  if (shouldProbeWindowsCursorSiblings(parts, options)) {
    return WINDOWS_CURSOR_SIBLING_EXTENSIONS.map((extension) => `${binary}${extension}`);
  }

  const preferred = parts.extension ? [`${binary}${parts.extension}`] : [];
  const names = executableNameCandidates(binary, options.platform, options.env, true);
  return [...new Set([...preferred, ...names])];
}

function shouldProbeWindowsCursorSiblings(
  parts: CursorCommandPathParts,
  options: ResolvedCursorAgentCommandOptions,
): boolean {
  const extension = parts.extension.toLowerCase();
  return (
    options.platform === "win32" ||
    parts.directory.includes("\\") ||
    WINDOWS_CURSOR_SIBLING_EXTENSIONS.includes(
      extension as (typeof WINDOWS_CURSOR_SIBLING_EXTENSIONS)[number],
    )
  );
}

function findCommandOnPath(
  command: string,
  options: ResolvedCursorAgentCommandOptions,
): string | undefined {
  for (const candidate of executableCandidates(command, {
    platform: options.platform,
    env: options.env,
  })) {
    if (options.pathExists(candidate.path)) {
      return candidate.path;
    }
  }
  return undefined;
}

function wrapPowerShellCommand(command: string, args: ReadonlyArray<string>): CursorAgentCommand {
  if (!/\.ps1$/iu.test(command)) {
    return { command, args: [...args] };
  }
  return {
    command: POWERSHELL_EXECUTABLE,
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
  };
}

// Resolves persisted/default Cursor binary settings into the executable Synara should spawn.
export function resolveCursorAgentBinaryPath(binaryPath: string | null | undefined): string {
  const configuredBinaryPath = binaryPath?.trim();
  return !configuredBinaryPath || configuredBinaryPath === LEGACY_CURSOR_AGENT_BINARY
    ? DEFAULT_CURSOR_AGENT_BINARY
    : configuredBinaryPath;
}

// Builds Cursor Agent invocations from either `cursor-agent` or the `cursor` editor launcher.
export function buildCursorAgentCommand(
  binaryPath: string | null | undefined,
  args: ReadonlyArray<string>,
  options: CursorAgentCommandOptions = {},
): CursorAgentCommand {
  const command = resolveCursorAgentBinaryPath(binaryPath);
  const commandOptions = {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    pathExists: options.pathExists ?? existsSync,
    realpath: options.realpath ?? realpathSync.native,
  };
  const editorLauncher = resolveCursorEditorLauncherCommand(command, commandOptions);
  const resolvedCommand = editorLauncher
    ? { command: editorLauncher.command, args: [...editorLauncher.args, ...args] }
    : { command, args: [...args] };
  return wrapPowerShellCommand(resolvedCommand.command, resolvedCommand.args);
}

// Cursor auth/status probes must stay headless so provider refreshes never open login browsers.
export function buildCursorAgentHeadlessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    provider: "cursor",
    baseEnv: env,
    overrides: CURSOR_AGENT_HEADLESS_PROBE_ENV,
  });
}
