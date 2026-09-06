import type {
  AccountSurface,
  AgentAuthMethod,
  ProcessEnvRecord,
  SupportedAccountProvider,
} from "@synara/contracts";

/**
 * Sentinel value inside an account environment record meaning "remove this
 * variable from the child environment". `ProcessEnvRecord` cannot carry
 * undefined values, so conflicting inherited auth overrides are stripped by
 * mapping them to this empty-string marker.
 */
export const ACCOUNT_ENV_UNSET = "";

export interface AccountEnvironmentBuildInput {
  readonly provider: SupportedAccountProvider;
  readonly ordinal: number;
  readonly surface: AccountSurface;
  readonly authMethod: AgentAuthMethod;
  readonly agentHome: string;
  readonly appDataDir: string;
  readonly apiKey?: string;
}

export interface AccountLaunchEnvironment {
  readonly environment: ProcessEnvRecord;
  readonly profilePath: string;
}

export type AccountEnvironmentBuilder = (
  input: AccountEnvironmentBuildInput,
) => AccountLaunchEnvironment;

/** Applies account environment overrides onto a child process environment. */
export function applyAccountEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  overrides: ProcessEnvRecord,
): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(overrides)) {
    if (value === ACCOUNT_ENV_UNSET) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}
