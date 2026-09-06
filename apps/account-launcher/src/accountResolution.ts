// Fail-closed account resolution for the standalone launcher. Reads the
// global account root directly; no server, no database, no Effect runtime.

import * as fs from "node:fs";

import type { AgentAuthMethod, SupportedAccountProvider } from "@synara/contracts";
import { ACCOUNT_ENV_UNSET } from "@synara/shared/providerAccounts/accountEnvironment";
import { accountEnvironmentBuilders } from "@synara/shared/providerAccounts/accountEnvironmentBuilders";
import {
  accountAgentHome,
  accountAppDataDir,
  accountJsonPath,
  accountSecretPath,
  activePointerPath,
} from "@synara/shared/providerAccounts/accountPaths";
import {
  launcherControlEnvVars,
  parseAccountOverride,
  SYNARA_ACCOUNT_OVERRIDE,
} from "@synara/shared/providerAccounts/launcherProtocol";

export class AccountLaunchError extends Error {}

interface AgentBindingRecord {
  readonly state: string;
  readonly authMethod: AgentAuthMethod;
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

// A missing pointer means the native account zero; an existing but invalid
// pointer fails closed so a corrupted file can never silently route work to
// the native credentials.
function readActiveOrdinal(root: string, provider: SupportedAccountProvider): number | null {
  const contents = readFileIfExists(activePointerPath(root, provider));
  if (contents === null) return null;
  const trimmed = contents.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {
    throw new AccountLaunchError(
      `Active pointer for '${provider}' is corrupted (${activePointerPath(root, provider)}). Repair it from Synara \u2192 Settings \u2192 Accounts, or delete the file to reset to the native account.`,
    );
  }
  return Number(trimmed);
}

// Minimal structural validation of the private account record; the launcher
// must not depend on the Effect Schema runtime.
function readAgentBinding(
  root: string,
  provider: SupportedAccountProvider,
  ordinal: number,
): AgentBindingRecord {
  const contents = readFileIfExists(accountJsonPath(root, provider, ordinal));
  if (contents === null) {
    throw new AccountLaunchError(`Account '${provider}' ordinal ${ordinal} does not exist.`);
  }
  let record: unknown;
  try {
    record = JSON.parse(contents);
  } catch {
    throw new AccountLaunchError(
      `Account record for '${provider}' ordinal ${ordinal} is not valid JSON.`,
    );
  }
  const agent = (record as { agent?: Partial<AgentBindingRecord> }).agent;
  if (
    agent === undefined ||
    typeof agent.state !== "string" ||
    (agent.authMethod !== "oauth" && agent.authMethod !== "apiKey")
  ) {
    throw new AccountLaunchError(
      `Account '${provider}' ordinal ${ordinal} has no valid agent binding.`,
    );
  }
  return { state: agent.state, authMethod: agent.authMethod };
}

export interface ResolveLaunchInput {
  readonly root: string;
  readonly provider: SupportedAccountProvider;
  readonly explicitOrdinal?: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolvedLaunch {
  readonly ordinal: number;
  /** Environment overrides; `ACCOUNT_ENV_UNSET` values mark removals. */
  readonly overrides: Readonly<Record<string, string>>;
}

/**
 * Resolves the account and its environment overrides. Selection order:
 * `SYNARA_ACCOUNT_OVERRIDE` (matching provider) > explicit ordinal > active
 * pointer > account zero. Managed accounts fail closed: any missing record,
 * binding, builder, or secret is an error — never a silent fallback.
 */
export function resolveLaunchEnvironment(input: ResolveLaunchInput): ResolvedLaunch {
  const { root, provider, env } = input;

  const overrideValue = env[SYNARA_ACCOUNT_OVERRIDE];
  let overrideOrdinal: number | undefined;
  if (overrideValue !== undefined && overrideValue.length > 0) {
    const override = parseAccountOverride(overrideValue);
    if (override === null) {
      throw new AccountLaunchError(
        `Invalid ${SYNARA_ACCOUNT_OVERRIDE} value '${overrideValue}' (expected <provider>:<ordinal>).`,
      );
    }
    if (override.provider === provider) overrideOrdinal = override.ordinal;
  }

  const ordinal =
    overrideOrdinal ?? input.explicitOrdinal ?? readActiveOrdinal(root, provider) ?? 0;

  // Account zero is the native account: preserve native behavior — no
  // sanitization, no managed environment.
  if (ordinal === 0) return { ordinal: 0, overrides: {} };

  const binding = readAgentBinding(root, provider, ordinal);
  if (binding.state !== "connected") {
    throw new AccountLaunchError(
      `Account '${provider}' ordinal ${ordinal} agent binding is '${binding.state}', not connected. Reconnect it from Synara → Settings → Accounts.`,
    );
  }

  const builder = accountEnvironmentBuilders[provider];

  let apiKey: string | undefined;
  if (binding.authMethod === "apiKey") {
    const secret = readFileIfExists(accountSecretPath(root, provider, ordinal, "agent"));
    if (secret === null) {
      throw new AccountLaunchError(
        `Account '${provider}' ordinal ${ordinal} is missing its stored API key. Reconnect the account.`,
      );
    }
    apiKey = secret;
  }

  const launchEnvironment = builder({
    provider,
    ordinal,
    surface: "agent",
    authMethod: binding.authMethod,
    agentHome: accountAgentHome(root, provider, ordinal),
    appDataDir: accountAppDataDir(root, provider, ordinal),
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  return { ordinal, overrides: launchEnvironment.environment };
}

/**
 * Builds the child environment: strips launcher control variables so they
 * never leak into the provider process, then applies the account overrides
 * (removals marked with `ACCOUNT_ENV_UNSET`, e.g. conflicting provider
 * credentials from the parent shell).
 */
export function buildChildEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  for (const name of launcherControlEnvVars) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === ACCOUNT_ENV_UNSET) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}
