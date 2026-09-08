// FILE: agentGateway/usageTools.ts
// Purpose: Expose cached, normalized provider quota through caller-scoped read-only MCP tools.
// Fetching and quota interpretation stay in providerUsage; gateway code only applies authority.

import type { ProviderKind, ServerAgentProviderUsage } from "@synara/contracts";
import { Duration, Effect, Option } from "effect";

import { AGENT_PROVIDER_USAGE_MAX_AGE_MS } from "../providerUsage/agent.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export interface AgentGatewayUsageToolsInput {
  readonly loadProviderUsage: (
    provider?: ProviderKind,
  ) => Effect.Effect<ReadonlyArray<ServerAgentProviderUsage>, unknown, never>;
  /** Override for the stall bound. Production default is {@link USAGE_TOOL_TIMEOUT}. */
  readonly timeout?: Duration.Input;
}

// Same bound as synara_context so a stalled provider lookup reports
// unavailable usage instead of holding the MCP call open.
const USAGE_TOOL_TIMEOUT = "3 seconds" as const;

function timedOutUsage(provider: ProviderKind): ServerAgentProviderUsage {
  return {
    provider,
    availability: "unavailable",
    unavailableReason: "timed-out",
    checkedAt: new Date().toISOString(),
    freshness: { stale: true, ageMs: 0, maxAgeMs: AGENT_PROVIDER_USAGE_MAX_AGE_MS },
    snapshot: null,
    quotaWindows: [],
  };
}

export function makeAgentGatewayUsageTools(
  input: AgentGatewayUsageToolsInput,
): ReadonlyArray<ToolEntry> {
  const timeout = input.timeout ?? USAGE_TOOL_TIMEOUT;
  const getUsage: ToolEntry = {
    requiredCapability: "usage:read",
    definition: {
      name: "synara_get_usage",
      description:
        "Read current provider account quota for your own provider. Actionable remaining percentages appear only for fresh authoritative quota windows; unavailable, stale, token, and spend data are never treated as remaining quota.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Get provider usage", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      input.loadProviderUsage(context.callerProvider).pipe(
        Effect.timeoutOption(timeout),
        // Caller-scoped load always requests exactly one provider.
        // Keep an explicit null fallback defensive against future loader changes.
        Effect.map((usage) =>
          mcpToolResultJson({
            usage: Option.match(usage, {
              onNone: () => timedOutUsage(context.callerProvider),
              onSome: (results) => results[0] ?? null,
            }),
          }),
        ),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  const listUsage: ToolEntry = {
    requiredCapability: "usage:read",
    definition: {
      name: "synara_list_provider_usage",
      description:
        "List current account-quota snapshots for enabled providers. Each provider and quota window carries provenance, freshness, and explicit unavailable states. Informational token or spend lines are not account quota.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List provider usage", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      input.loadProviderUsage().pipe(
        Effect.timeoutOption(timeout),
        Effect.map((usage) =>
          Option.match(usage, {
            onNone: () => mcpToolResultError("Provider usage lookup timed out."),
            onSome: (results) => mcpToolResultJson({ usage: results }),
          }),
        ),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  return [getUsage, listUsage];
}
