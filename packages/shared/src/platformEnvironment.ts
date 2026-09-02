// FILE: platformEnvironment.ts
// Purpose: Resolves platform-owned executable locations from an already hydrated environment.
// Layer: Shared platform runtime

import * as Path from "node:path";

function trimNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmpty(env.SystemRoot) ?? trimNonEmpty(env.SYSTEMROOT) ?? "C:\\Windows";
}

export function resolveWindowsSystemExecutable(
  relativeSegments: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return Path.win32.join(resolveWindowsSystemRoot(env), ...relativeSegments);
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
  return (
    trimNonEmpty(env.ComSpec) ??
    trimNonEmpty(env.COMSPEC) ??
    resolveWindowsSystemExecutable(["System32", "cmd.exe"], env)
  );
}

export function resolveWindowsWslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(["System32", "wsl.exe"], env);
}

export function resolveWindowsWhereExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(["System32", "where.exe"], env);
}

export function resolveWindowsPowerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    env,
  );
}
