// FILE: openCodeAuthPaths.ts
// Purpose: Candidate auth.json locations for OpenCode-compatible CLIs.
// Official OpenCode stores auth at xdgData/opencode — `XDG_DATA_HOME` or `~/.local/share` —
// on every OS, including Windows and macOS. Some Windows tools still write %APPDATA% or
// %LOCALAPPDATA%; those stay fallbacks so we do not miss a login, but they are never first.

import { readFile } from "node:fs/promises";
import nodePath from "node:path";

export interface OpenCodeAuthPathInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly dataDirectoryName: string;
}

function dataDirectoryOverride(
  env: NodeJS.ProcessEnv | undefined,
  dataDirectoryName: string,
): string | undefined {
  if (dataDirectoryName === "opencode") return env?.OPENCODE_DATA_DIR?.trim();
  return undefined;
}

export function resolveOpenCodeCompatibleAuthPaths(input: OpenCodeAuthPathInput): string[] {
  const env = input.env ?? {};
  const paths: string[] = [];
  const push = (value: string) => {
    if (!paths.includes(value)) paths.push(value);
  };

  const override = dataDirectoryOverride(env, input.dataDirectoryName);
  if (override) push(nodePath.join(override, "auth.json"));

  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) push(nodePath.join(xdg, input.dataDirectoryName, "auth.json"));

  // Canonical OpenCode path on Linux, macOS, and Windows (`xdg-basedir`).
  push(nodePath.join(input.homeDir, ".local", "share", input.dataDirectoryName, "auth.json"));

  if (input.platform === "win32") {
    const roaming = env.APPDATA?.trim() || nodePath.join(input.homeDir, "AppData", "Roaming");
    const local = env.LOCALAPPDATA?.trim() || nodePath.join(input.homeDir, "AppData", "Local");
    push(nodePath.join(roaming, input.dataDirectoryName, "auth.json"));
    push(nodePath.join(local, input.dataDirectoryName, "auth.json"));
  }

  return paths;
}

export async function readOpenCodeAuthFileUtf8(input: OpenCodeAuthPathInput): Promise<string> {
  const paths = resolveOpenCodeCompatibleAuthPaths(input);
  let lastError: unknown;
  for (const filePath of paths) {
    try {
      return await readFile(filePath, "utf8");
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenCode auth.json not found");
}
