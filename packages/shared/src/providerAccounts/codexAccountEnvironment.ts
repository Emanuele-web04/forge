import {
  ACCOUNT_ENV_UNSET,
  type AccountEnvironmentBuildInput,
  type AccountLaunchEnvironment,
} from "./accountEnvironment";

// Inherited auth overrides that would leak the native account into a managed
// launch. Stripped before account-specific values are applied.
const CODEX_CONFLICTING_ENV_VARS = [
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

export function buildCodexAccountEnvironment(
  input: AccountEnvironmentBuildInput,
): AccountLaunchEnvironment {
  const environment: Record<string, string> = {};
  for (const name of CODEX_CONFLICTING_ENV_VARS) {
    environment[name] = ACCOUNT_ENV_UNSET;
  }
  environment.CODEX_HOME = input.agentHome;
  if (input.authMethod === "apiKey" && input.apiKey !== undefined) {
    environment.OPENAI_API_KEY = input.apiKey;
  }
  // OAuth accounts authenticate through CODEX_HOME/auth.json (the file
  // credential store inside the account agent home).
  return { environment, profilePath: input.agentHome };
}
