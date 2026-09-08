// FILE: agentGateway/usageTools.ts
// Purpose: Expose cached, normalized provider quota through caller-scoped read-only MCP tools.
// Fetching and quota interpretation stay in providerUsage; gateway code only applies authority.

import type { ProviderKind, ServerAgentProviderUsage } from "@synara/contracts";
import { Effect } from "effect";

import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export interface AgentGatewayUsageToolsInput {
  readonly loadProviderUsage: (
    provider?: ProviderKind,
  ) => Effect.Effect<ReadonlyArray<ServerAgentProviderUsage>, unknown, never>;
}

export function makeAgentGatewayUsageTools(
  input: AgentGatewayUsageToolsInput,
): ReadonlyArray<ToolEntry> {
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
        // Caller-scoped load always requests exactly one provider.
        // Keep an explicit null fallback defensive against future loader changes.
        Effect.map((usage) => mcpToolResultJson({ usage: usage[0] ?? null })),
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
        Effect.map((usage) => mcpToolResultJson({ usage })),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  return [getUsage, listUsage];
}
