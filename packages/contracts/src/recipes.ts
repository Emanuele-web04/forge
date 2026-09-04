// FILE: recipes.ts
// Purpose: Synara-owned local recipe overlays for deterministic discovery of
//          known ACP agents. These are detection/compatibility overlays only:
//          they say how to find/validate an agent locally and what has been
//          assessed about it. They never fork or replace the upstream ACP
//          Registry's structured data (which is consumed via AcpRegistryClient
//          on the server). Keeping the overlay in contracts means both the
//          server (discovery) and any future client surface (KAR-526 Add Agent)
//          resolve the same recipe ids additively.
// Layer: Contracts (schema + data only, no runtime logic)

export type AgentRecipeProbeArg = string;

export interface AgentRecipeVersionCompatibility {
  /** Minimum version (inclusive) accepted by Synara, or unset for no floor. */
  readonly minimum?: string;
  /** The known-good version the recipe pins when the installed version is unparseable. */
  readonly knownGood?: string;
}

export interface AgentRecipeDefinition {
  /**
   * The canonical agent id. Matches the upstream ACP Registry `id` when the
   * agent has one, so the recipe overlay can be JOINED onto registry entries
   * without copying registry data.
   */
  readonly agentId: string;
  /** Display name used when the agent is discovered but not present in the registry. */
  readonly primaryName: string;
  /**
   * Local command names to enumerate on PATH. Every resolved absolute path
   * becomes a separate connection candidate (multiple installs → multiple
   * candidates).
   */
  readonly binaryNames: readonly string[];
  /**
   * Version-probe arguments (e.g. `["--version"]`) appended to the resolved
   * binary path. Empty means "no version probe" (the candidate is classified
   * only as present, never unsupported-version).
   */
  readonly probeArgs?: readonly AgentRecipeProbeArg[];
  /**
   * Compatibility assessment maintained by Synara for the agents we know.
   * Registry entries can be demoted to `listed: false` when compatibility
   * says the current upstream version is broken for Synara.
   */
  readonly compatibility?: {
    readonly listed?: boolean;
    /** One-line human summary shown in Add Agent (KAR-526), never a command source. */
    readonly summary?: string;
    readonly version?: AgentRecipeVersionCompatibility;
  };
}

export const RECIPE_DISCOVERY_SOURCE = "recipe";

/**
 * The built-in recipe set. Canonical ids, reminder on provenance:
 * detection metadata here is Synara-authored; distribution/install facts live
 * in the upstream registry and are never copied here.
 */
export const AGENT_RECIPES: readonly AgentRecipeDefinition[] = [
  {
    agentId: "cline",
    primaryName: "Cline",
    binaryNames: ["cline"],
    probeArgs: ["--version"],
    compatibility: {
      listed: true,
      summary:
        "Cline is detected from its local cline CLI shim (installed via the Cline npm package).",
    },
  },
  {
    agentId: "codex-acp",
    primaryName: "Codex (ACP)",
    binaryNames: ["codex-acp"],
    probeArgs: ["--version"],
  },
  {
    agentId: "opencode",
    primaryName: "OpenCode",
    binaryNames: ["opencode"],
    probeArgs: ["--version"],
  },
  {
    agentId: "goose",
    primaryName: "goose",
    binaryNames: ["goose"],
    probeArgs: ["--version"],
  },
  {
    agentId: "cursor",
    primaryName: "Cursor",
    binaryNames: ["cursor-agent", "cursor"],
    probeArgs: ["--version"],
  },
  {
    agentId: "claude-acp",
    primaryName: "Claude Agent",
    binaryNames: ["claude-agent-acp"],
    probeArgs: ["--version"],
  },
];

export const RECIPE_BY_AGENT_ID: ReadonlyMap<string, AgentRecipeDefinition> = new Map(
  AGENT_RECIPES.map((recipe) => [recipe.agentId, recipe]),
);
