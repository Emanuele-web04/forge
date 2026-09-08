import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { ComputerBackendError } from "./ComputerBackend.ts";

/**
 * Filesystem reads the resolver needs, narrowed to three questions so tests can
 * simulate a flatpak or XDG layout without touching the host.
 */
export interface AppLaunchFileSystem {
  isExecutableFile(path: string): boolean;
  isFile(path: string): boolean;
  readTextFile(path: string): string | undefined;
}

/** The subset of the environment that decides where a launchable name lives. */
export interface AppLaunchEnvironment {
  readonly path?: string;
  readonly home?: string;
  readonly xdgDataHome?: string;
  readonly xdgDataDirs?: string;
}

export interface AppLaunchResolutionDeps {
  readonly fs?: AppLaunchFileSystem;
  readonly env?: AppLaunchEnvironment;
}

export type AppLaunchResolutionSource =
  | "absolute-path"
  | "path"
  | "flatpak-export"
  | "desktop-entry-exec"
  | "desktop-entry-gio";

export interface AppLaunchResolution {
  /** Absolute program path handed to spawn. */
  readonly command: string;
  readonly args: readonly string[];
  readonly via: AppLaunchResolutionSource;
  /** Desktop entry the command came from, when one did. */
  readonly desktopFile?: string;
}

export type AppLaunchResolver = (app: string, args: readonly string[]) => AppLaunchResolution;

/**
 * Raised when a name cannot be turned into something spawnable. Carries a code
 * so the gateway classifies it, and a message that names every place that was
 * searched: the model's next call has to be a corrected one, not another guess
 * at the same string.
 */
export class AppLaunchResolutionError extends ComputerBackendError {
  readonly code = "computer_app_not_found";

  constructor(message: string) {
    super(message);
    this.name = "AppLaunchResolutionError";
  }
}

const SYSTEM_FLATPAK_ROOT = "/var/lib/flatpak";
const FALLBACK_DATA_DIRS = "/usr/local/share:/usr/share";

/**
 * Desktop-entry field codes plus the flatpak file-forwarding markers that wrap
 * them. Both stand for files the caller did not pass, so every one is dropped
 * rather than forwarded as a literal argument.
 */
const FIELD_CODE = /(^|[^%])%[fFuUdDnNickvm]/;
const FORWARDING_MARKER = /^@@[uU]?$/;

const HOST_FS: AppLaunchFileSystem = {
  isExecutableFile(path) {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readTextFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** Resolver bound to the real host, used by every backend that spawns locally. */
export const resolveAppLaunchOnHost: AppLaunchResolver = (app, args) => resolveAppLaunch(app, args);

/**
 * Turn a launch request into an absolute command plus arguments.
 *
 * Order is absolute path, `$PATH`, flatpak export bins, then desktop entry,
 * because each later step is a less direct route to the same binary: a flatpak
 * export bin is a real executable that forwards its arguments, while a desktop
 * entry is a description of one. Resolving to the executable is what keeps
 * caller arguments (`--new-window <url>`) working, so a desktop entry whose
 * `Exec` resolves is preferred over handing the file to `gio launch`, which
 * only forwards file arguments substituted into the entry's own field codes.
 */
export function resolveAppLaunch(
  app: string,
  args: readonly string[],
  deps: AppLaunchResolutionDeps = {},
): AppLaunchResolution {
  const fs = deps.fs ?? HOST_FS;
  const env = deps.env ?? hostEnvironment();
  const requested = app.trim();
  if (requested.length === 0) {
    throw new AppLaunchResolutionError(
      "computer_launch_app needs a program name. Pass an absolute path, a command on $PATH, " +
        "a flatpak app id, or a .desktop id.",
    );
  }

  if (requested.includes("/")) return resolvePathLike(requested, args, fs);

  const direct = findExecutable(requested, fs, env);
  if (direct) return { command: direct.command, args: [...args], via: direct.via };

  const desktop = findDesktopEntry(requested, fs, env);
  if (desktop) return resolveDesktopEntry(desktop, requested, args, fs, env);

  throw notFoundError(requested, env);
}

function resolvePathLike(
  requested: string,
  args: readonly string[],
  fs: AppLaunchFileSystem,
): AppLaunchResolution {
  if (!isAbsolute(requested)) {
    throw new AppLaunchResolutionError(
      `computer_launch_app cannot launch the relative path ${JSON.stringify(requested)}: the ` +
        "desktop session has no working directory of yours. Pass an absolute path, a command on " +
        "$PATH, a flatpak app id, or a .desktop id.",
    );
  }
  if (fs.isExecutableFile(requested)) {
    return { command: requested, args: [...args], via: "absolute-path" };
  }
  throw new AppLaunchResolutionError(
    `computer_launch_app found no executable at ${JSON.stringify(requested)}. Pass the path of a ` +
      "file that exists and is executable, or pass a bare command, flatpak app id, or .desktop id " +
      "and let Synara resolve it.",
  );
}

function findExecutable(
  name: string,
  fs: AppLaunchFileSystem,
  env: AppLaunchEnvironment,
): { readonly command: string; readonly via: AppLaunchResolutionSource } | undefined {
  for (const directory of pathDirectories(env)) {
    const candidate = join(directory, name);
    if (fs.isExecutableFile(candidate)) return { command: candidate, via: "path" };
  }
  for (const directory of flatpakBinDirectories(env)) {
    const candidate = join(directory, name);
    if (fs.isExecutableFile(candidate)) return { command: candidate, via: "flatpak-export" };
  }
  return undefined;
}

function findDesktopEntry(
  name: string,
  fs: AppLaunchFileSystem,
  env: AppLaunchEnvironment,
): string | undefined {
  const fileName = name.endsWith(".desktop") ? name : `${name}.desktop`;
  for (const directory of applicationDirectories(env)) {
    const candidate = join(directory, fileName);
    if (fs.isFile(candidate)) return candidate;
  }
  return undefined;
}

function resolveDesktopEntry(
  desktopFile: string,
  requested: string,
  args: readonly string[],
  fs: AppLaunchFileSystem,
  env: AppLaunchEnvironment,
): AppLaunchResolution {
  const exec = readDesktopExec(desktopFile, fs);
  const program = exec?.[0];
  const resolved = program
    ? program.includes("/")
      ? fs.isExecutableFile(program)
        ? { command: program, via: "absolute-path" as AppLaunchResolutionSource }
        : undefined
      : findExecutable(program, fs, env)
    : undefined;

  if (resolved && exec) {
    return {
      command: resolved.command,
      args: [...exec.slice(1), ...args],
      via: "desktop-entry-exec",
      desktopFile,
    };
  }

  const gio = findExecutable("gio", fs, env);
  if (gio && args.length === 0) {
    return { command: gio.command, args: ["launch", desktopFile], via: "desktop-entry-gio" };
  }
  if (gio) {
    throw new AppLaunchResolutionError(
      `computer_launch_app resolved ${JSON.stringify(requested)} to the desktop entry ` +
        `${desktopFile}, whose Exec line names no executable this host has, so the arguments you ` +
        "passed cannot be forwarded. Retry with the absolute path of the program you want, or " +
        "retry without arguments to launch the desktop entry as configured.",
    );
  }
  throw new AppLaunchResolutionError(
    `computer_launch_app resolved ${JSON.stringify(requested)} to the desktop entry ` +
      `${desktopFile}, but its Exec line names no executable this host has. Retry with the ` +
      "absolute path of the program you want.",
  );
}

/** `Exec` of the `[Desktop Entry]` group, tokenized with field codes removed. */
function readDesktopExec(
  desktopFile: string,
  fs: AppLaunchFileSystem,
): readonly string[] | undefined {
  const contents = fs.readTextFile(desktopFile);
  if (contents === undefined) return undefined;
  let inEntry = false;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || !line.startsWith("Exec=")) continue;
    const tokens = tokenizeExec(line.slice("Exec=".length));
    return tokens.length > 0 ? tokens : undefined;
  }
  return undefined;
}

function tokenizeExec(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\" && quote === '"') {
      const next = value[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
        continue;
      }
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens
    .filter((token) => !FORWARDING_MARKER.test(token) && !FIELD_CODE.test(token))
    .map((token) => token.replaceAll("%%", "%"));
}

function pathDirectories(env: AppLaunchEnvironment): readonly string[] {
  return splitList(env.path);
}

function flatpakBinDirectories(env: AppLaunchEnvironment): readonly string[] {
  return dedupe([
    join(SYSTEM_FLATPAK_ROOT, "exports", "bin"),
    join(dataHome(env), "flatpak", "exports", "bin"),
  ]);
}

function applicationDirectories(env: AppLaunchEnvironment): readonly string[] {
  const dataDirs = splitList(env.xdgDataDirs ?? FALLBACK_DATA_DIRS);
  return dedupe([
    join(dataHome(env), "applications"),
    ...dataDirs.map((directory) => join(directory, "applications")),
    "/usr/local/share/applications",
    "/usr/share/applications",
    join(SYSTEM_FLATPAK_ROOT, "exports", "share", "applications"),
    join(dataHome(env), "flatpak", "exports", "share", "applications"),
  ]);
}

function dataHome(env: AppLaunchEnvironment): string {
  const configured = env.xdgDataHome?.trim();
  if (configured) return configured;
  return join(env.home?.trim() || "/root", ".local", "share");
}

function splitList(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function notFoundError(requested: string, env: AppLaunchEnvironment): AppLaunchResolutionError {
  // Kinds, not paths: the searched directories include the user's home, and
  // echoing absolute paths into a model-facing error leaks the filesystem
  // layout to whoever reads the tool result.
  const searched = dedupe([
    "the PATH",
    ...(flatpakBinDirectories(env).length > 0 ? ["installed flatpak apps"] : []),
    ...(applicationDirectories(env).length > 0 ? [".desktop entries"] : []),
  ]);
  return new AppLaunchResolutionError(
    `computer_launch_app found nothing named ${JSON.stringify(requested)}. Searched ` +
      `${searched.join(", ")}. Retry with an absolute path to the executable, a command on $PATH, ` +
      "an installed flatpak app id, or a .desktop id. Call computer_list_windows first if the app " +
      "may already be running.",
  );
}

function hostEnvironment(): AppLaunchEnvironment {
  return {
    ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
    home: process.env.HOME ?? homedir(),
    ...(process.env.XDG_DATA_HOME === undefined ? {} : { xdgDataHome: process.env.XDG_DATA_HOME }),
    ...(process.env.XDG_DATA_DIRS === undefined ? {} : { xdgDataDirs: process.env.XDG_DATA_DIRS }),
  };
}
