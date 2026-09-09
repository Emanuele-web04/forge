// FILE: editorAppDiscovery.ts
// Purpose: Shared helpers for resolving installed editor apps/packages without
//          duplicating platform-specific search rules across launch and icons.
// Layer: Server runtime utility
// Exports: app/package search helpers used by open.ts and editorAppIcons.ts
// Depends on: EDITORS metadata plus filesystem stat checks.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { EDITORS } from "@synara/contracts";

export type EditorDefinition = (typeof EDITORS)[number];

export interface WindowsStorePackageDefinition {
  readonly packageName: string;
  readonly publisherId: string;
}

type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: true;
  },
) => string | Buffer;

interface WindowsStorePowerShellLookupOptions {
  readonly useCache?: boolean;
  readonly now?: () => number;
}

interface CachedPowerShellAppxLookup {
  readonly value: string | null;
  readonly expiresAt: number;
}

const POWERSHELL_APPX_LOOKUP_TIMEOUT_MS = 1_500;
const POWERSHELL_APPX_LOOKUP_CACHE_TTL_MS = 300_000;
const powershellAppxLookupCache = new Map<string, CachedPowerShellAppxLookup>();

export function getEditorMacApplications(editor: EditorDefinition): readonly string[] | undefined {
  return "macApplications" in editor ? editor.macApplications : undefined;
}

export function getEditorWindowsUriScheme(editor: EditorDefinition): string | undefined {
  return "windowsUriScheme" in editor ? editor.windowsUriScheme : undefined;
}

export function getEditorWindowsStorePackages(
  editor: EditorDefinition,
): readonly WindowsStorePackageDefinition[] | undefined {
  return "windowsStorePackages" in editor ? editor.windowsStorePackages : undefined;
}

export function normalizeMacApplicationBundleName(appName: string): string {
  return appName.endsWith(".app") ? appName : `${appName}.app`;
}

// Checks the standard user/system app locations, including JetBrains Toolbox installs.
export function resolveMacApplicationSearchPaths(
  appName: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const bundleName = normalizeMacApplicationBundleName(appName);
  const home = env.HOME?.trim();
  const homeCandidates = home
    ? [
        join(home, "Applications", bundleName),
        join(home, "Applications", "JetBrains Toolbox", bundleName),
      ]
    : [];

  return [
    ...homeCandidates,
    join("/Applications", bundleName),
    join("/Applications", "Utilities", bundleName),
    join("/Applications", "JetBrains Toolbox", bundleName),
    join("/System", "Applications", bundleName),
    join("/System", "Applications", "Utilities", bundleName),
  ];
}

export function resolveMacApplicationBundlePath(
  appNames: readonly string[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !appNames) return null;

  for (const appName of appNames) {
    for (const candidate of resolveMacApplicationSearchPaths(appName, env)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Keep probing the remaining standard locations.
      }
    }
  }

  return null;
}

export function resolveAvailableMacApplication(
  appNames: readonly string[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !appNames) return null;

  return (
    appNames.find((appName) =>
      resolveMacApplicationSearchPaths(appName, env).some((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      }),
    ) ?? null
  );
}

function windowsStorePackageFamilyName(packageDef: WindowsStorePackageDefinition): string {
  return `${packageDef.packageName}_${packageDef.publisherId}`;
}

function uniqueWindowsStorePackageDefinitions(
  packages: readonly WindowsStorePackageDefinition[],
): readonly WindowsStorePackageDefinition[] {
  const byFamily = new Map<string, WindowsStorePackageDefinition>();
  for (const packageDef of packages) {
    byFamily.set(windowsStorePackageFamilyName(packageDef).toLowerCase(), packageDef);
  }
  return Array.from(byFamily.values());
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolvePowerShellCacheKey(
  packages: readonly WindowsStorePackageDefinition[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const families = uniqueWindowsStorePackageDefinitions(packages)
    .map((packageDef) => windowsStorePackageFamilyName(packageDef).toLowerCase())
    .sort();
  return JSON.stringify({
    platform,
    families,
    path: env.PATH ?? env.Path ?? env.path ?? "",
    systemRoot: env.SystemRoot ?? env.WINDIR ?? "",
  });
}

function readPowerShellAppxLookupCache(key: string, now: number): string | null | undefined {
  const cached = powershellAppxLookupCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > now) return cached.value;
  powershellAppxLookupCache.delete(key);
  return undefined;
}

function writePowerShellAppxLookupCache(key: string, value: string | null, now: number): void {
  powershellAppxLookupCache.set(key, {
    value,
    expiresAt: now + POWERSHELL_APPX_LOOKUP_CACHE_TTL_MS,
  });
}

export function clearWindowsStorePackageDiscoveryCache(): void {
  powershellAppxLookupCache.clear();
}

export function resolveWindowsStorePackageDirectoryFromPowerShell(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execFile: ExecFileSyncLike = execFileSync,
  options: WindowsStorePowerShellLookupOptions = {},
): string | null {
  if (platform !== "win32" || !packages) return null;

  const packageDefs = uniqueWindowsStorePackageDefinitions(packages);
  if (packageDefs.length === 0) return null;

  const now = options.now?.() ?? Date.now();
  const useCache = options.useCache ?? execFile === execFileSync;
  const cacheKey = useCache ? resolvePowerShellCacheKey(packageDefs, platform, env) : null;
  if (cacheKey) {
    const cached = readPowerShellAppxLookupCache(cacheKey, now);
    if (cached !== undefined) return cached;
  }

  const packageArray = `@(${packageDefs
    .map(
      (packageDef) =>
        `@{ Name = ${quotePowerShellLiteral(packageDef.packageName)}; Family = ${quotePowerShellLiteral(
          windowsStorePackageFamilyName(packageDef),
        )} }`,
    )
    .join(",")})`;
  const script = [
    `$packages = ${packageArray}`,
    "foreach ($packageDef in $packages) {",
    "  $package = Get-AppxPackage -Name $packageDef.Name -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.PackageFamilyName -ieq $packageDef.Family } | Select-Object -First 1",
    "  if ($null -ne $package -and $package.InstallLocation) {",
    "    Write-Output $package.InstallLocation",
    "    exit 0",
    "  }",
    "}",
    "exit 1",
  ].join("; ");

  try {
    const stdout = execFile("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: POWERSHELL_APPX_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    });
    const result =
      String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null;
    if (cacheKey) writePowerShellAppxLookupCache(cacheKey, result, now);
    return result;
  } catch {
    if (cacheKey) writePowerShellAppxLookupCache(cacheKey, null, now);
    return null;
  }
}

export function resolveWindowsStorePackageInstallLocation(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execFile: ExecFileSyncLike = execFileSync,
  options: WindowsStorePowerShellLookupOptions = {},
): string | null {
  return resolveWindowsStorePackageDirectoryFromPowerShell(
    packages,
    platform,
    env,
    execFile,
    options,
  );
}
