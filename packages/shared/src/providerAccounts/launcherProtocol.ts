import type { SupportedAccountProvider } from "@synara/contracts";

export const SYNARA_LAUNCHER_BYPASS = "SYNARA_LAUNCHER_BYPASS";
export const SYNARA_LAUNCHER_BYPASS_VALUE = "1";
export const SYNARA_ACCOUNT_OVERRIDE = "SYNARA_ACCOUNT_OVERRIDE";
// Set by the provider shims to tell the launcher which shim was invoked.
export const SYNARA_LAUNCHER_SHIM = "SYNARA_LAUNCHER_SHIM";

export function isLauncherBypass(env: NodeJS.ProcessEnv): boolean {
  return env[SYNARA_LAUNCHER_BYPASS] === SYNARA_LAUNCHER_BYPASS_VALUE;
}

// Launcher control variables stripped from the environment before exec-ing the
// real provider binary, so they never leak into provider child processes.
export const launcherControlEnvVars: readonly string[] = [
  SYNARA_LAUNCHER_BYPASS,
  SYNARA_ACCOUNT_OVERRIDE,
  SYNARA_LAUNCHER_SHIM,
];

// Shim command name for each provider (the executables installed on PATH).
export const providerShimCommands: Record<SupportedAccountProvider, string> = {
  codex: "codex",
  claudeAgent: "claude",
  cursor: "cursor-agent",
  grok: "grok",
};

export function providerForShimCommand(command: string): SupportedAccountProvider | undefined {
  for (const [provider, shim] of Object.entries(providerShimCommands)) {
    if (shim === command) return provider as SupportedAccountProvider;
  }
  return undefined;
}

export interface AccountOverride {
  readonly provider: SupportedAccountProvider;
  readonly ordinal: number;
}

/** Parses `SYNARA_ACCOUNT_OVERRIDE=<provider>:<ordinal>`. Returns null when malformed. */
export function parseAccountOverride(value: string): AccountOverride | null {
  const match = /^([a-zA-Z]+):(0|[1-9][0-9]*)$/.exec(value.trim());
  if (match === null) return null;
  const provider = match[1] as string;
  if (!(provider in providerShimCommands)) return null;
  return { provider: provider as SupportedAccountProvider, ordinal: Number(match[2]) };
}
