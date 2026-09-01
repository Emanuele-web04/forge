// FILE: executable.ts
// Purpose: Defines how a command name becomes a concrete executable on every platform.
// Layer: Shared platform runtime
// Depends on: node:fs and node:path only.

import { accessSync, constants, statSync } from "node:fs";
import { extname, join, posix, win32 } from "node:path";

export interface ExecutableLookupOptions {
  /** Defaults to `process.platform`. Injectable for cross-platform tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.env`. Callers should pass the already-hydrated runtime environment. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Working directory the launch will use. Qualified relative commands such as
   * `./bin/tool` resolve against it, matching what the spawned child sees.
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string;
  /**
   * win32 only: also yield the command with no extension appended.
   *
   * Off by default because Windows native process creation will not execute an
   * extensionless npm-style shim. Discovery and launch must agree about that.
   */
  readonly allowExtensionlessOnWindows?: boolean;
}

export interface ExecutableCandidate {
  /** The PATH entry this candidate came from, or the command's own directory when qualified. */
  readonly directory: string;
  readonly path: string;
}

/** Windows' default PATHEXT prefix in native precedence order. */
const DEFAULT_WINDOWS_PATH_EXTENSIONS: readonly string[] = [".COM", ".EXE", ".BAT", ".CMD"];
const DEFAULT_POSIX_PATH_ENTRIES: readonly string[] = ["/usr/bin", "/bin"];
const WINDOWS_DIRECT_LAUNCH_EXTENSIONS = new Set(DEFAULT_WINDOWS_PATH_EXTENSIONS);

/** Windows exposes PATH under any capitalization; the first key present is the live one. */
export function envPathKeyFor(env: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if ("PATH" in env) return "PATH";
  if ("Path" in env) return "Path";
  return "path";
}

/** True when the command already names a location, in which case PATH is not consulted. */
export function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

export function windowsPathExtensions(env: NodeJS.ProcessEnv): readonly string[] {
  const rawValue = env.PATHEXT;
  if (!rawValue) return DEFAULT_WINDOWS_PATH_EXTENSIONS;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

/** PATH split into directories, in search order. */
export function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (pathValue === undefined) {
    return platform === "win32" ? [] : [...DEFAULT_POSIX_PATH_ENTRIES];
  }
  if (pathValue.length === 0) return [];
  return pathValue
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter((entry) => entry.length > 0);
}

/** File names to try for `command`, in platform-native order. */
export function executableNameCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  allowExtensionless = false,
): readonly string[] {
  if (platform !== "win32") return [command];

  const pathExtensions = windowsPathExtensions(env);
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (
    extension.length > 0 &&
    (pathExtensions.includes(normalizedExtension) ||
      WINDOWS_DIRECT_LAUNCH_EXTENSIONS.has(normalizedExtension))
  ) {
    const stem = command.slice(0, -extension.length);
    return [
      ...new Set([
        command,
        `${stem}${normalizedExtension}`,
        `${stem}${normalizedExtension.toLowerCase()}`,
      ]),
    ];
  }

  const candidates = allowExtensionless ? [command] : [];
  for (const pathExtension of pathExtensions) {
    candidates.push(`${command}${pathExtension}`, `${command}${pathExtension.toLowerCase()}`);
  }
  return [...new Set(candidates)];
}

/** Directory part of a path, honoring both separators regardless of the test host. */
function directoryOf(commandPath: string): string {
  const lastIndex = Math.max(commandPath.lastIndexOf("/"), commandPath.lastIndexOf("\\"));
  if (lastIndex < 0) return ".";
  if (lastIndex === 0) return commandPath.slice(0, 1);
  return commandPath.slice(0, lastIndex);
}

interface ExecutableLookupContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly pathExtensions: readonly string[];
}

function resolveLookupContext(options: ExecutableLookupOptions): ExecutableLookupContext {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return {
    platform,
    env,
    cwd: options.cwd,
    pathExtensions: platform === "win32" ? windowsPathExtensions(env) : [],
  };
}

/**
 * The filesystem location a candidate is checked at. Candidates keep their
 * launch-facing form (a relative `./bin/tool` stays relative so the child
 * resolves it itself), but existence is checked against the launch cwd, not
 * wherever the server happens to be running.
 */
function candidateStatPath(filePath: string, context: ExecutableLookupContext): string {
  const pathModule = context.platform === "win32" ? win32 : posix;
  if (pathModule.isAbsolute(filePath)) return filePath;
  return pathModule.resolve(context.cwd ?? process.cwd(), filePath);
}

function* candidatesIn(
  command: string,
  context: ExecutableLookupContext,
  allowExtensionless: boolean,
): Generator<ExecutableCandidate> {
  const names = executableNameCandidates(
    command,
    context.platform,
    context.env,
    allowExtensionless,
  );

  if (hasPathSeparator(command)) {
    for (const name of names) {
      yield { directory: directoryOf(name), path: name };
    }
    return;
  }

  for (const directory of pathEntries(context.env, context.platform)) {
    for (const name of names) {
      yield { directory, path: join(directory, name) };
    }
  }
}

/** Every path a launch of `command` may resolve to, in native search order. */
export function executableCandidates(
  command: string,
  options: ExecutableLookupOptions = {},
): Generator<ExecutableCandidate> {
  return candidatesIn(
    command,
    resolveLookupContext(options),
    options.allowExtensionlessOnWindows ?? false,
  );
}

function isExecutableFileIn(filePath: string, context: ExecutableLookupContext): boolean {
  const statPath = candidateStatPath(filePath, context);
  try {
    if (!statSync(statPath).isFile()) return false;
    if (context.platform === "win32") {
      const extension = extname(filePath).toUpperCase();
      return (
        extension.length > 0 &&
        (context.pathExtensions.includes(extension) ||
          WINDOWS_DIRECT_LAUNCH_EXTENSIONS.has(extension))
      );
    }
    accessSync(statPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isExecutableFile(filePath: string, options: ExecutableLookupOptions = {}): boolean {
  return isExecutableFileIn(filePath, resolveLookupContext(options));
}

/** The executable a launch of `command` should run, or null when no candidate matches. */
export function resolveExecutable(
  command: string,
  options: ExecutableLookupOptions = {},
): string | null {
  const context = resolveLookupContext(options);
  for (const candidate of candidatesIn(
    command,
    context,
    options.allowExtensionlessOnWindows ?? false,
  )) {
    if (isExecutableFileIn(candidate.path, context)) {
      return candidate.path;
    }
  }
  return null;
}

/** Cheap file identity used to invalidate per-executable caches. */
export function executableIdentity(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}
