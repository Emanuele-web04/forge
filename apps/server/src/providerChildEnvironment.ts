// FILE: providerChildEnvironment.ts
// Purpose: Builds provider child environments without Synara control-plane authority.
// Layer: Server provider process security

export type ProviderChildKind =
  | "acp"
  | "antigravity"
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "grok"
  | "kilo"
  | "kilo-server"
  | "opencode"
  | "opencode-server"
  | "pi"
  | "pi-shell"
  | "worktree-setup";

const PROVIDER_CREDENTIAL_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "FACTORY_API_KEY",
  "CURSOR_API_KEY",
  "DOCKER_AUTH_CONFIG",
]);

export function registerProviderCredentialKey(key: string): void {
  const normalized = key.trim().toUpperCase();
  if (/^[A-Z0-9_.-]+$/u.test(normalized)) {
    PROVIDER_CREDENTIAL_KEYS.add(normalized);
  }
}

export function isProviderCredentialKey(key: string): boolean {
  return PROVIDER_CREDENTIAL_KEYS.has(key.trim().toUpperCase());
}

const PROVIDER_CREDENTIAL_GRANTS: Record<ProviderChildKind, "all" | ReadonlySet<string>> = {
  antigravity: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]),
  cursor: new Set(["CURSOR_API_KEY"]),
  droid: new Set(["FACTORY_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  // Generic ACP startup must preserve only the exact credentials granted by
  // its provider-specific caller. A missing spawn environment is not authority
  // to inherit every provider credential from the Synara server.
  acp: new Set(),
  // The Codex process boundary grants either OpenAI or the active custom
  // provider's configured env_key explicitly.
  codex: new Set(),
  // Health, maintenance, and usage probes do not contact upstream model APIs.
  kilo: new Set(),
  opencode: new Set(),
  pi: new Set(),
  // The long-lived OpenCode-compatible daemons discover and serve arbitrary
  // upstream model providers. Isolate their exceptional broad grant from the
  // short-lived CLI probes above until the daemon pool is provider-keyed.
  "kilo-server": "all",
  "opencode-server": "all",
  // Pi's model registry is multi-provider, but commands launched by the model
  // are a separate trust boundary and do not need the model API credentials.
  "pi-shell": new Set(),
  // A saved setup command can execute repository-controlled lifecycle code
  // (for example through a package-manager install). Never expose provider
  // credentials to that process implicitly.
  "worktree-setup": new Set(),
};

const INHERITED_NATIVE_CAPABILITY_KEYS = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
]);

const isTestHarnessKey = (key: string, env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.VITEST) && (key.startsWith("SYNARA_FAKE_") || key.startsWith("SYNARA_ACP_"));

export function buildProviderChildEnvironment(input: {
  readonly provider: ProviderChildKind;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly inheritedSynaraKeys?: ReadonlyArray<string>;
  readonly inheritedNativeCapabilityKeys?: ReadonlyArray<string>;
  readonly additionalCredentialKeys?: ReadonlyArray<string>;
  readonly overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = {
    ...(input.baseEnv ?? process.env),
    ...input.overrides,
  };
  const allowedSynaraKeys = new Set(input.inheritedSynaraKeys ?? []);
  const allowedNativeCapabilities = new Set(input.inheritedNativeCapabilityKeys ?? []);
  const credentialGrants = PROVIDER_CREDENTIAL_GRANTS[input.provider];
  const additionalCredentialGrants = new Set(
    (input.additionalCredentialKeys ?? []).map((key) => key.trim().toUpperCase()),
  );
  const childEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      key.startsWith("SYNARA_") &&
      !allowedSynaraKeys.has(key) &&
      !isTestHarnessKey(key, baseEnv)
    ) {
      continue;
    }
    if (INHERITED_NATIVE_CAPABILITY_KEYS.has(key) && !allowedNativeCapabilities.has(key)) {
      continue;
    }
    if (
      isProviderCredentialKey(key) &&
      credentialGrants !== "all" &&
      !credentialGrants.has(key.toUpperCase()) &&
      !additionalCredentialGrants.has(key.toUpperCase())
    ) {
      continue;
    }
    childEnv[key] = value;
  }

  return childEnv;
}
