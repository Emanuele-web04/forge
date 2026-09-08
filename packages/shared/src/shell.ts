// FILE: shell.ts
// Purpose: Shared helpers for probing login-shell environment values safely.
// Exports: shell candidate resolution plus PATH/environment capture utilities.

import * as OS from "node:os";
import { execFileSync } from "node:child_process";

const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number; windowsHide?: boolean },
) => string;

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Marks an environment whose PATH was already resolved from the user's real
 * environment (login shell, launchctl, or the Windows registry) by a parent process.
 *
 * Probing a login shell costs ~1s because `-ilc` sources the user's full interactive
 * rc (nvm, pyenv, conda, oh-my-zsh, direnv). The desktop shell pays that once before
 * it spawns the backend, and the backend inherits the result — so without this marker
 * the same probe is serialized a second time before the server ever starts listening.
 */
export const SHELL_ENVIRONMENT_HYDRATED_ENV_NAME = "SYNARA_PATH_HYDRATED";
export const SHELL_ENVIRONMENT_HYDRATED_ENV_VALUE = "1";

/**
 * A populated PATH proves nothing on its own — every process inherits one, including
 * the truncated `/usr/bin:/bin` a GUI launch starts with. Only an explicit marker from
 * a process that actually ran the probe may suppress it.
 */
export function isShellEnvironmentHydrated(env: NodeJS.ProcessEnv): boolean {
  return (
    env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME] === SHELL_ENVIRONMENT_HYDRATED_ENV_VALUE &&
    trimNonEmpty(env.PATH) !== undefined
  );
}

/**
 * Stamps (or clears) the hydration marker on an environment handed to a child process.
 * Always written explicitly: an inherited marker from an unrelated parent must never
 * suppress a probe this process did not actually perform.
 */
export function applyShellEnvironmentHydrationMarker(
  env: NodeJS.ProcessEnv,
  hydrated: boolean,
): NodeJS.ProcessEnv {
  if (hydrated) {
    env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME] = SHELL_ENVIRONMENT_HYDRATED_ENV_VALUE;
  } else {
    delete env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME];
  }
  return env;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(OS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function resolveLoginShell(
  platform: NodeJS.Platform,
  shell: string | undefined,
): string | undefined {
  return listLoginShellCandidates(platform, shell)[0];
}

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile).PATH;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const isWindows = platform === "win32";
  const merged: string[] = [];
  const seen = new Set<string>();

  // Windows paths are case-insensitive and tolerate a trailing separator, so the
  // registry PATH and the inherited PATH overlap with the same entry in different
  // casing or with/without a trailing slash. Normalize the dedup key on win32 to
  // collapse those near-duplicates (the first-seen spelling is preserved); posix
  // stays an exact match.
  const dedupKey = (entry: string): string =>
    isWindows ? entry.toLowerCase().replace(/[\\/]+$/, "") : entry;

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) {
        continue;
      }
      const key = dedupKey(trimmedEntry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__SYNARA_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__SYNARA_ENV_${name}_END__`;
}

function buildEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  let value = output.slice(valueStartIndex, endIndex);
  if (value.startsWith("\n")) {
    value = value.slice(1);
  }
  if (value.endsWith("\n")) {
    value = value.slice(0, -1);
  }

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(names)], {
    encoding: "utf8",
    timeout: 5000,
  });

  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

// Windows has no login-shell to probe; the user's persisted environment lives in the
// registry (HKCU + HKLM). A GUI process launched from a stale Explorer inherits an
// outdated environment block, so we read the registry directly to pick up current values.

export function isPathName(name: string): boolean {
  return name.toUpperCase() === "PATH";
}

// Merge the Machine and User registry scopes the way Windows composes the environment:
// User scope wins for ordinary variables, and PATH is Machine entries followed by User entries.
export function mergeWindowsScopes(
  machine: Partial<Record<string, string>>,
  user: Partial<Record<string, string>>,
): Partial<Record<string, string>> {
  const merged: Partial<Record<string, string>> = {};

  // Windows environment variable names are case-insensitive, so a Machine `Foo` and
  // a User `FOO` are the same variable. Track the stored key per lowercased name so a
  // later (User) scope overrides the earlier (Machine) value instead of leaving both.
  const keyByLowerName = new Map<string, string>();
  const assignNonPath = (source: Partial<Record<string, string>>): void => {
    for (const [name, value] of Object.entries(source)) {
      if (isPathName(name)) continue;
      const trimmed = trimNonEmpty(value);
      if (!trimmed) continue;
      const lowerName = name.toLowerCase();
      const existingKey = keyByLowerName.get(lowerName);
      if (existingKey !== undefined && existingKey !== name) {
        delete merged[existingKey];
      }
      merged[name] = trimmed;
      keyByLowerName.set(lowerName, name);
    }
  };
  assignNonPath(machine);
  assignNonPath(user);

  const scopePath = (source: Partial<Record<string, string>>): string | undefined => {
    for (const [name, value] of Object.entries(source)) {
      if (isPathName(name)) return trimNonEmpty(value);
    }
    return undefined;
  };
  const combinedPath = [scopePath(machine), scopePath(user)]
    .filter((value): value is string => Boolean(value))
    .join(";");
  if (combinedPath) {
    merged.PATH = combinedPath;
  }

  return merged;
}

export type WindowsEnvironmentReader = (
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

// NOTE: keep this on Windows PowerShell 5.1 (`powershell.exe`), not `pwsh`. WinPS 5.1's
// `ConvertTo-Json` escapes non-ASCII as `\uXXXX`, so the stdout stays pure ASCII and
// survives the OEM-codepage console encoding. `pwsh` emits raw UTF-8 and would corrupt
// non-ASCII paths read back here.
const WINDOWS_ENVIRONMENT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "function dump($s){$m=[ordered]@{};$v=[Environment]::GetEnvironmentVariables($s);",
  "foreach($k in $v.Keys){$m[[string]$k]=[Environment]::ExpandEnvironmentVariables([string]$v[$k])};$m}",
  "$o=[ordered]@{machine=(dump 'Machine');user=(dump 'User')};",
  "[Console]::Out.Write(($o|ConvertTo-Json -Compress -Depth 3))",
].join("");

// Resolve the absolute interpreter path instead of relying on PATH lookup, so a
// malicious `powershell.exe` planted earlier on PATH cannot be executed here.
function resolveWindowsPowerShellPath(): string {
  const systemRoot = trimNonEmpty(process.env.SystemRoot) ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export const readWindowsPersistentEnvironment: WindowsEnvironmentReader = (
  execFile = execFileSync,
) => {
  const output = execFile(
    resolveWindowsPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENVIRONMENT_SCRIPT],
    { encoding: "utf8", timeout: 5000, windowsHide: true },
  );

  let parsed: {
    machine?: Partial<Record<string, string>>;
    user?: Partial<Record<string, string>>;
  };
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return {};
  }

  return mergeWindowsScopes(parsed.machine ?? {}, parsed.user ?? {});
};
