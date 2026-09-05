// FILE: providerBinaryResolution.ts
// Purpose: Resolves provider CLI binaries from PATH and vendor-owned Windows install folders.
// Layer: Server provider runtime

import { existsSync } from "node:fs";
import { win32 } from "node:path";

import { executableCandidates } from "@synara/shared/executable";

export interface ProviderBinaryResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExists?: (path: string) => boolean;
}

interface ResolvedProviderBinaryResolutionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly pathExists: (path: string) => boolean;
}

function resolveOptions(
  options: ProviderBinaryResolutionOptions,
): ResolvedProviderBinaryResolutionOptions {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    pathExists: options.pathExists ?? existsSync,
  };
}

export function commandExistsOnPath(
  command: string,
  options: ProviderBinaryResolutionOptions = {},
): boolean {
  const resolved = resolveOptions(options);
  for (const candidate of executableCandidates(command, resolved)) {
    if (resolved.pathExists(candidate.path)) return true;
  }
  return false;
}

export function resolveWindowsLocalAppDataBinary(
  relativeCandidates: ReadonlyArray<ReadonlyArray<string>>,
  options: ProviderBinaryResolutionOptions = {},
): string | undefined {
  const resolved = resolveOptions(options);
  if (resolved.platform !== "win32") return undefined;

  const localAppData =
    resolved.env.LOCALAPPDATA?.trim() ||
    (resolved.env.USERPROFILE?.trim()
      ? win32.join(resolved.env.USERPROFILE.trim(), "AppData", "Local")
      : undefined);
  if (!localAppData) return undefined;

  for (const relativePath of relativeCandidates) {
    const candidate = win32.join(localAppData, ...relativePath);
    if (resolved.pathExists(candidate)) return candidate;
  }
  return undefined;
}
