import type { SupportedAccountProvider } from "@synara/contracts";
import {
  providerForShimCommand,
  providerShimCommands,
  SYNARA_LAUNCHER_SHIM,
} from "@synara/shared/providerAccounts/launcherProtocol";

export { SYNARA_LAUNCHER_SHIM };

export interface LauncherInvocation {
  readonly provider: SupportedAccountProvider;
  readonly explicitOrdinal?: number;
  readonly providerArgs: readonly string[];
}

export class LauncherUsageError extends Error {}

function parseOrdinal(value: string | undefined, flag: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new LauncherUsageError(`${flag} requires a non-negative integer ordinal.`);
  }
  return Number(value);
}

// Accepts both provider ids (claudeAgent) and shim command names (claude).
function requireProvider(name: string): SupportedAccountProvider {
  if (name in providerShimCommands) return name as SupportedAccountProvider;
  const provider = providerForShimCommand(name);
  if (provider === undefined) {
    throw new LauncherUsageError(
      `Unknown provider '${name}'. Supported: codex, claude, cursor-agent, grok.`,
    );
  }
  return provider;
}

/**
 * Two invocation forms:
 * - Shim mode: `SYNARA_LAUNCHER_SHIM=<shim-name>` is set and every argument is
 *   forwarded verbatim to the provider binary.
 * - Run mode: `synara-account-launcher run <provider> [--ordinal N] [--] <args...>`
 *   (used by the `synara run` wrapper). `--provider` is also accepted in place
 *   of the positional provider name.
 */
export function parseLauncherInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): LauncherInvocation {
  const shimName = env[SYNARA_LAUNCHER_SHIM];
  if (shimName !== undefined && shimName.length > 0) {
    return { provider: requireProvider(shimName), providerArgs: argv };
  }

  const [command, ...rest] = argv;
  if (command !== "run") {
    throw new LauncherUsageError(
      "Usage: synara-account-launcher run <provider> [--ordinal N] [--] <provider args...>",
    );
  }

  let provider: SupportedAccountProvider | undefined;
  let explicitOrdinal: number | undefined;
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index] as string;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--provider") {
      provider = requireProvider(rest[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (arg === "--ordinal") {
      explicitOrdinal = parseOrdinal(rest[index + 1], "--ordinal");
      index += 2;
      continue;
    }
    if (provider === undefined && !arg.startsWith("-")) {
      provider = requireProvider(arg);
      index += 1;
      continue;
    }
    // First unrecognized argument: everything from here on belongs to the provider.
    break;
  }

  if (provider === undefined) {
    throw new LauncherUsageError("No provider specified. Use: synara run <provider> [args...].");
  }
  return {
    provider,
    ...(explicitOrdinal !== undefined ? { explicitOrdinal } : {}),
    providerArgs: rest.slice(index),
  };
}
