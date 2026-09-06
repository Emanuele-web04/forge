import {
  ACCOUNT_ENV_UNSET,
  type AccountEnvironmentBuildInput,
  type AccountLaunchEnvironment,
} from "./accountEnvironment";

// Inherited auth overrides that would leak the native account into a managed
// launch. Stripped before account-specific values are applied. Cursor managed
// accounts never repoint HOME: only the documented CURSOR_* variables move.
const CURSOR_CONFLICTING_ENV_VARS = ["CURSOR_API_KEY", "CURSOR_CONFIG_DIR"] as const;

export function buildCursorAccountEnvironment(
  input: AccountEnvironmentBuildInput,
): AccountLaunchEnvironment {
  const environment: Record<string, string> = {};
  for (const name of CURSOR_CONFLICTING_ENV_VARS) {
    environment[name] = ACCOUNT_ENV_UNSET;
  }
  environment.CURSOR_CONFIG_DIR = input.agentHome;
  if (input.authMethod === "apiKey" && input.apiKey !== undefined) {
    environment.CURSOR_API_KEY = input.apiKey;
  }
  // Cursor agent OAuth stays unsupported for managed accounts; the app OAuth
  // binding resolves through this same builder.
  return { environment, profilePath: input.agentHome };
}
