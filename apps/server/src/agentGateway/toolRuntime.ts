import type { ProviderKind } from "@synara/contracts";
import type { Effect } from "effect";

import type { AgentGatewayTargetError } from "./targetResolver.ts";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";
import {
  mcpToolResultJson,
  type JsonRpcId,
  type McpToolCallResult,
  type McpToolDefinition,
} from "./protocol.ts";

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export interface ProviderSessionPrincipal {
  readonly kind: "provider-session";
  readonly sessionKey: string;
  readonly threadId: string;
  readonly provider: ProviderKind;
  readonly turnId: string | null;
}

export interface ExternalClientPrincipal {
  readonly kind: "external-client";
  readonly integrationId: string;
  readonly name: string;
}

export type AgentGatewayPrincipal = ProviderSessionPrincipal | ExternalClientPrincipal;

export interface ToolContext {
  readonly principal: ProviderSessionPrincipal;
  readonly callerThreadId: string;
  readonly callerSessionKey: string;
  readonly callerProvider: ProviderKind;
  readonly callerCapabilities: ReadonlySet<AgentGatewayCapability>;
  readonly callerTurnId: string | null;
  readonly assertCallerTurnActive: () => Effect.Effect<void, GatewayToolError>;
  readonly jsonRpcRequestId: JsonRpcId;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

export interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
  readonly requiredCapability: AgentGatewayCapability;
  readonly requiresActiveTurn?: boolean;
}

export interface McpToolEntry<Context, Capability extends string> {
  readonly definition: McpToolDefinition;
  readonly handler: (
    args: Record<string, unknown>,
    context: Context,
  ) => Effect.Effect<McpToolCallResult>;
  readonly requiredCapability: Capability;
}

/**
 * Narrow a tool catalog to what one caller may actually invoke.
 *
 * Both MCP surfaces build their catalog once and gate per call, so without
 * this a `tools/list` advertises tools whose every invocation is denied — the
 * caller pays prompt tokens for them and learns they are unusable only by
 * failing. Capabilities are fixed when a credential is issued (granting or
 * revoking one restarts the session), so a filtered list can never go stale
 * mid-session and no `listChanged` notification is owed.
 */
export function filterToolsByCapability<
  Capability extends string,
  Tool extends { readonly requiredCapability: Capability },
>(tools: ReadonlyArray<Tool>, capabilities: ReadonlySet<Capability>): ReadonlyArray<Tool> {
  return tools.filter((tool) => capabilities.has(tool.requiredCapability));
}

export class GatewayToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function gatewayToolErrorResult(error: GatewayToolError | AgentGatewayTargetError) {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }),
    isError: true as const,
  };
}
