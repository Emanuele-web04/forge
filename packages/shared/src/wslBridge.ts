// FILE: wslBridge.ts
// Purpose: Isolates optional Windows-to-WSL path translation from providers.
// Layer: Shared platform runtime

import { parseWindowsWslUncPath } from "./windowsProcess";

export interface WslWorkspace {
  readonly distribution: string;
  readonly linuxPath: string;
}

/** Returns WSL metadata only for the supported \\wsl$ and \\wsl.localhost boundaries. */
export function resolveWslWorkspace(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): WslWorkspace | null {
  return platform === "win32" ? parseWindowsWslUncPath(cwd) : null;
}

/** Protocol payloads receive the backend-native cwd, while native Windows paths pass through. */
export function resolveExecutionWorkingDirectory(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveWslWorkspace(cwd, platform)?.linuxPath ?? cwd;
}
