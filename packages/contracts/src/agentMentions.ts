/**
 * Agent Mentions - @alias(task) syntax for subagent delegation.
 *
 * Provides provider-aware alias metadata used by the composer UI and provider runtimes.
 */

import type { ProviderKind } from "./orchestration";
import type { ModelSlug } from "./model";

type AgentAliasColor = "violet" | "fuchsia" | "teal" | "cyan" | "amber" | "orange";

interface BaseAgentAliasDefinition {
  readonly provider: ProviderKind;
  readonly displayName: string;
  readonly color: AgentAliasColor;
}

export interface CodexAgentAliasDefinition extends BaseAgentAliasDefinition {
  readonly provider: "codex";
  readonly kind: "model";
  readonly model: ModelSlug;
}

export interface ClaudeSubagentAliasDefinition extends BaseAgentAliasDefinition {
  readonly provider: "claudeAgent";
  readonly kind: "claude-subagent";
  readonly agentName: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
}

export type AgentAliasDefinition = CodexAgentAliasDefinition | ClaudeSubagentAliasDefinition;

export type ResolvedAgentAlias = AgentAliasDefinition & {
  readonly alias: string;
};

const OPENCODE_AGENT_MENTION_ALIASES: Record<string, AgentAliasDefinition> = {};

const CODEX_AGENT_MENTION_ALIASES: Record<string, CodexAgentAliasDefinition> = {
  "5.5": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    color: "violet",
  },
  "5.4": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    color: "violet",
  },
  mini: {
    provider: "codex",
    kind: "model",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    color: "fuchsia",
  },
  "5.4-mini": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    color: "fuchsia",
  },
  codex: {
    provider: "codex",
    kind: "model",
    model: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    color: "teal",
  },
  "5.3-codex": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    color: "teal",
  },
  spark: {
    provider: "codex",
    kind: "model",
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    color: "cyan",
  },
  "5.3-spark": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    color: "cyan",
  },
  "5.2": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.2",
    displayName: "GPT-5.2",
    color: "amber",
  },
  "5.2-codex": {
    provider: "codex",
    kind: "model",
    model: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    color: "orange",
  },
};

const CLAUDE_AGENT_MENTION_ALIASES: Record<string, ClaudeSubagentAliasDefinition> = {
  explore: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "explore",
    displayName: "Explore",
    color: "cyan",
    description:
      "Read-only codebase explorer. Use for file discovery, code search, and gathering context before implementation.",
    prompt:
      "You are a focused codebase exploration specialist. Search broadly, gather the most relevant findings, and return a concise summary with the key files, evidence, and risks. Do not make code changes.",
    tools: ["Read", "Grep", "Glob"],
    model: "haiku",
  },
  review: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "review",
    displayName: "Code Review",
    color: "amber",
    description:
      "Bug and risk reviewer. Use for code review, regression hunting, and edge-case analysis.",
    prompt:
      "You are a senior code reviewer. Focus on behavioral regressions, correctness bugs, edge cases, and missing tests. Return findings first, then open questions, then a brief summary.",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet",
  },
  reviewer: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "review",
    displayName: "Code Review",
    color: "amber",
    description:
      "Bug and risk reviewer. Use for code review, regression hunting, and edge-case analysis.",
    prompt:
      "You are a senior code reviewer. Focus on behavioral regressions, correctness bugs, edge cases, and missing tests. Return findings first, then open questions, then a brief summary.",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet",
  },
  build: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "build",
    displayName: "Implementer",
    color: "violet",
    description:
      "Implementation teammate. Use for scoped code changes, debugging, and hands-on execution tasks.",
    prompt:
      "You are an implementation-focused coding teammate. Make targeted changes, validate assumptions with the available tools, and return a short implementation summary plus any remaining risks.",
    tools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit"],
    model: "sonnet",
  },
  implement: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "build",
    displayName: "Implementer",
    color: "violet",
    description:
      "Implementation teammate. Use for scoped code changes, debugging, and hands-on execution tasks.",
    prompt:
      "You are an implementation-focused coding teammate. Make targeted changes, validate assumptions with the available tools, and return a short implementation summary plus any remaining risks.",
    tools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit"],
    model: "sonnet",
  },
  plan: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "plan",
    displayName: "Planner",
    color: "fuchsia",
    description:
      "Planning specialist. Use for breaking work into steps, evaluating approaches, and preparing execution plans.",
    prompt:
      "You are a planning specialist. Clarify goals, evaluate tradeoffs, identify edge cases, and return a concrete ordered plan with the main risks called out explicitly.",
    tools: ["Read", "Grep", "Glob", "TodoWrite"],
    model: "sonnet",
  },
  planner: {
    provider: "claudeAgent",
    kind: "claude-subagent",
    agentName: "plan",
    displayName: "Planner",
    color: "fuchsia",
    description:
      "Planning specialist. Use for breaking work into steps, evaluating approaches, and preparing execution plans.",
    prompt:
      "You are a planning specialist. Clarify goals, evaluate tradeoffs, identify edge cases, and return a concrete ordered plan with the main risks called out explicitly.",
    tools: ["Read", "Grep", "Glob", "TodoWrite"],
    model: "sonnet",
  },
};

export const AGENT_MENTION_ALIASES_BY_PROVIDER: Record<
  ProviderKind,
  Record<string, AgentAliasDefinition>
> = {
  codex: CODEX_AGENT_MENTION_ALIASES,
  claudeAgent: CLAUDE_AGENT_MENTION_ALIASES,
  cursor: {},
  antigravity: {},
  grok: {},
  droid: {},
  devin: {},
  kilo: OPENCODE_AGENT_MENTION_ALIASES,
  opencode: OPENCODE_AGENT_MENTION_ALIASES,
  pi: {},
} as const satisfies Record<ProviderKind, Record<string, AgentAliasDefinition>>;

// Backward compatibility for legacy call sites that still expect a flat alias table.
export const AGENT_MENTION_ALIASES: Record<string, AgentAliasDefinition> = Object.assign(
  {},
  ...Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER),
);

const AGENT_MENTION_AUTOCOMPLETE_ALIASES_BY_PROVIDER: Record<ProviderKind, readonly string[]> = {
  codex: ["5.5", "5.4", "mini", "5.3-codex", "spark", "5.2", "5.2-codex"],
  claudeAgent: ["explore", "review", "build", "plan"],
  cursor: [],
  antigravity: [],
  grok: [],
  droid: [],
  devin: [],
  kilo: [],
  opencode: [],
  pi: [],
};

function mapAgentEntries(input: Record<string, AgentAliasDefinition>): ResolvedAgentAlias[] {
  return Object.entries(input)
    .map(([alias, definition]) => Object.assign({ alias }, definition))
    .toSorted((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Get all available agent aliases for a provider. When no provider is passed,
 * returns the global union for parsing and validation helpers.
 */
export function getAgentMentionAliases(provider?: ProviderKind): ResolvedAgentAlias[] {
  if (provider) {
    return mapAgentEntries(AGENT_MENTION_ALIASES_BY_PROVIDER[provider]);
  }

  return Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER).flatMap((definitions) =>
    mapAgentEntries(definitions),
  );
}

/**
 * Get the preferred aliases shown in autocomplete for a provider.
 */
export function getAgentMentionAutocompleteAliases(provider: ProviderKind): ResolvedAgentAlias[] {
  return AGENT_MENTION_AUTOCOMPLETE_ALIASES_BY_PROVIDER[provider].map((alias) => {
    const definition = AGENT_MENTION_ALIASES_BY_PROVIDER[provider][alias];
    if (!definition) {
      throw new Error(`Unknown autocomplete alias for ${provider}: ${alias}`);
    }

    return Object.assign({ alias }, definition);
  });
}

/**
 * Resolve an agent alias. When a provider is passed, only provider-specific aliases are considered.
 */
export function resolveAgentAlias(
  alias: string,
  provider?: ProviderKind,
): AgentAliasDefinition | null {
  const normalized = alias.toLowerCase();
  if (provider) {
    return AGENT_MENTION_ALIASES_BY_PROVIDER[provider][normalized] ?? null;
  }

  for (const definitions of Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER)) {
    const resolved = definitions[normalized];
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export function isValidAgentAlias(alias: string, provider?: ProviderKind): boolean {
  return resolveAgentAlias(alias, provider) !== null;
}

export function getAgentAliasNames(provider?: ProviderKind): string[] {
  if (provider) {
    return Object.keys(AGENT_MENTION_ALIASES_BY_PROVIDER[provider]);
  }

  return Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER).flatMap((definitions) =>
    Object.keys(definitions),
  );
}
