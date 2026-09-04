import {
  ACCOUNT_ENV_UNSET,
  type AccountEnvironmentBuildInput,
  type AccountLaunchEnvironment,
} from "./accountEnvironment";

// Inherited auth overrides that would leak the native account (or reroute
// requests through Bedrock/Vertex/custom gateways) into a managed launch.
// Stripped before account-specific values are applied.
const CLAUDE_CONFLICTING_ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

export function buildClaudeAccountEnvironment(
  input: AccountEnvironmentBuildInput,
): AccountLaunchEnvironment {
  const environment: Record<string, string> = {};
  for (const name of CLAUDE_CONFLICTING_ENV_VARS) {
    environment[name] = ACCOUNT_ENV_UNSET;
  }
  // The app surface is the Claude desktop app: OAuth/browser-based, isolated
  // through its own CLAUDE_CONFIG_DIR under the account app data dir. API keys
  // are not a substitute for the desktop login, so no key is injected there.
  const configDir = input.surface === "app" ? input.appDataDir : input.agentHome;
  environment.CLAUDE_CONFIG_DIR = configDir;
  if (input.surface === "agent" && input.authMethod === "apiKey" && input.apiKey !== undefined) {
    environment.ANTHROPIC_API_KEY = input.apiKey;
  }
  // OAuth accounts authenticate through CLAUDE_CONFIG_DIR/.credentials.json
  // (the file credential store inside the isolated config dir).
  return { environment, profilePath: configDir };
}
