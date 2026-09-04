import {
  ACCOUNT_ENV_UNSET,
  type AccountEnvironmentBuildInput,
  type AccountLaunchEnvironment,
} from "./accountEnvironment";

// Inherited auth overrides that would leak the native account into a managed
// launch. Stripped before account-specific values are applied.
const GROK_CONFLICTING_ENV_VARS = ["GROK_HOME", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] as const;

export function buildGrokAccountEnvironment(
  input: AccountEnvironmentBuildInput,
): AccountLaunchEnvironment {
  const environment: Record<string, string> = {};
  for (const name of GROK_CONFLICTING_ENV_VARS) {
    environment[name] = ACCOUNT_ENV_UNSET;
  }
  environment.GROK_HOME = input.agentHome;
  if (input.authMethod === "apiKey" && input.apiKey !== undefined) {
    environment.XAI_API_KEY = input.apiKey;
  }
  // OAuth/device accounts authenticate through the credential store beneath
  // GROK_HOME (the account agent home).
  return { environment, profilePath: input.agentHome };
}
