import { homedir } from "node:os";
import { join } from "node:path";

import type { AccountSurface, SupportedAccountProvider } from "@synara/contracts";
import { accountDirName, activePointerFileName, secretName } from "./accountIds";

export interface ResolveAccountRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export function resolveAccountRoot(options: ResolveAccountRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = env.SYNARA_ACCOUNT_HOME;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Synara", "Accounts");
  }
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA.length > 0
        ? env.LOCALAPPDATA
        : join(home, "AppData", "Local");
    return join(localAppData, "Synara", "Accounts");
  }
  const xdgDataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share");
  return join(xdgDataHome, "synara", "accounts");
}

export function activePointerDir(root: string): string {
  return join(root, "active");
}

export function activePointerPath(root: string, provider: SupportedAccountProvider): string {
  return join(activePointerDir(root), activePointerFileName(provider));
}

export function accountsDir(root: string, provider: SupportedAccountProvider): string {
  return join(root, "accounts", provider);
}

export function accountDir(
  root: string,
  provider: SupportedAccountProvider,
  ordinal: number,
): string {
  return join(accountsDir(root, provider), accountDirName(ordinal));
}

export function accountJsonPath(
  root: string,
  provider: SupportedAccountProvider,
  ordinal: number,
): string {
  return join(accountDir(root, provider, ordinal), "account.json");
}

export function accountAgentHome(
  root: string,
  provider: SupportedAccountProvider,
  ordinal: number,
): string {
  return join(accountDir(root, provider, ordinal), "agent", "home");
}

export function accountAppDataDir(
  root: string,
  provider: SupportedAccountProvider,
  ordinal: number,
): string {
  return join(accountDir(root, provider, ordinal), "app", "data");
}

// Mirrors the ServerSecretStore file naming so both stores stay compatible.
export function secretFileName(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.bin`;
}

export function secretsDir(root: string): string {
  return join(root, "secrets");
}

export function accountSecretPath(
  root: string,
  provider: SupportedAccountProvider,
  ordinal: number,
  surface: AccountSurface,
): string {
  return join(secretsDir(root), secretFileName(secretName(provider, ordinal, surface)));
}

export function pendingDir(root: string, provider: SupportedAccountProvider): string {
  return join(root, "pending", provider);
}

export function pendingPath(
  root: string,
  provider: SupportedAccountProvider,
  operationId: string,
): string {
  return join(pendingDir(root, provider), operationId);
}

export function runtimeDir(root: string): string {
  return join(root, "runtime");
}

export function appLeasesDir(root: string): string {
  return join(runtimeDir(root), "app-leases");
}

export function launcherDiagnosticsDir(root: string): string {
  return join(runtimeDir(root), "launcher-diagnostics");
}

export function versionFilePath(root: string): string {
  return join(root, "version");
}
