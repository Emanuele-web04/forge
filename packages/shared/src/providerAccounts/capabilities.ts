import type {
  AccountSupportLevel,
  AccountSurface,
  AgentAuthMethod,
  ProviderAccountCapabilities,
  SupportedAccountProvider,
} from "@synara/contracts";

// Only combinations with a complete, verified end-to-end workflow are marked
// as available. Managed OAuth login is implemented for Codex only (official
// `codex login` inside an isolated CODEX_HOME). Desktop-app profile isolation
// is unproven for every provider, so all app surfaces stay unsupported until
// a verified isolation probe exists.
const CAPABILITY_MATRIX: Record<SupportedAccountProvider, ProviderAccountCapabilities> = {
  codex: {
    agent: { oauth: "supported", apiKey: "supported" },
    app: { oauth: "unsupported", supportLevel: "unsupported" },
  },
  claudeAgent: {
    agent: { oauth: "unsupported", apiKey: "supported" },
    app: { oauth: "unsupported", supportLevel: "unsupported" },
  },
  cursor: {
    agent: { oauth: "unsupported", apiKey: "supported" },
    app: { oauth: "unsupported", supportLevel: "unsupported" },
  },
  grok: {
    agent: { oauth: "unsupported", apiKey: "supported" },
    app: { oauth: "unsupported", supportLevel: "unsupported" },
  },
};

export function authCapabilities(provider: SupportedAccountProvider): ProviderAccountCapabilities {
  return CAPABILITY_MATRIX[provider];
}

export function supportLevelFor(
  provider: SupportedAccountProvider,
  surface: AccountSurface,
  authMethod: AgentAuthMethod,
): AccountSupportLevel {
  const capabilities = CAPABILITY_MATRIX[provider];
  if (surface === "app") {
    return authMethod === "oauth" ? capabilities.app.oauth : "unsupported";
  }
  return authMethod === "oauth" ? capabilities.agent.oauth : capabilities.agent.apiKey;
}

export function isConnectSupported(
  provider: SupportedAccountProvider,
  surface: AccountSurface,
  authMethod: AgentAuthMethod,
): boolean {
  return supportLevelFor(provider, surface, authMethod) !== "unsupported";
}
