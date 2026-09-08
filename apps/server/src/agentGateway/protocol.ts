/**
 * Minimal MCP (Model Context Protocol) JSON-RPC handling for the Synara agent
 * gateway.
 *
 * Implements the stateless subset of the MCP streamable-HTTP transport the
 * gateway needs: `initialize`, `ping`, `tools/list`, and `tools/call`, plus
 * notification acknowledgement. Every POST gets a single JSON response (the
 * spec allows servers to answer with `application/json` instead of an SSE
 * stream), so no session or stream state is kept server-side.
 *
 * Pure request/response shaping lives here so it can be unit tested without
 * the HTTP or Effect layers.
 *
 * @module agentGateway/protocol
 */

export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * MCP `_meta` on a tool definition: namespaced hints a client may honour.
 *
 * The spec reserves `_meta` for exactly this and requires clients to ignore
 * namespaces they do not know, so every key here is inert for every consumer
 * except the one that defined it. The shape is closed rather than an open
 * record: each key has to be a documented, verified contract with some client,
 * and a typo in a namespaced string key is otherwise undetectable.
 *
 * - `anthropic/alwaysLoad`: the Claude Code harness includes this tool's schema
 *   in the prompt instead of deferring it behind its tool-search indirection
 *   (equivalent to `defer_loading: false` on the API). Verified against the
 *   2.1.x CLI's generic MCP tool normalization, which reads it for any server
 *   type, and documented in `@anthropic-ai/claude-agent-sdk`.
 * - `anthropic/searchHint`: replaces the description the same harness indexes
 *   (and sends) for a *deferred* tool. Unused today — see computerTools.ts.
 */
export interface McpToolMeta {
  readonly "anthropic/alwaysLoad"?: boolean;
  readonly "anthropic/searchHint"?: string;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly _meta?: McpToolMeta;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export function mcpToolResultError(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function mcpToolResultJson(value: unknown): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export type ParsedMcpMessage =
  | { readonly kind: "request"; readonly request: JsonRpcRequest }
  | { readonly kind: "notification"; readonly notification: JsonRpcNotification }
  | { readonly kind: "response" }
  | { readonly kind: "invalid"; readonly id: JsonRpcId };

/**
 * Classify one raw JSON-RPC message. Responses and notifications require no
 * reply body; invalid entries produce an error response bound to whatever id
 * could be recovered.
 */
export function parseMcpMessage(raw: unknown): ParsedMcpMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", id: null };
  }
  const record = raw as Record<string, unknown>;
  const rawId = record.id;
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" || rawId === null ? rawId : null;
  if (record.jsonrpc !== "2.0") {
    return { kind: "invalid", id };
  }
  if (typeof record.method !== "string" || record.method.length === 0) {
    // No method: either a client -> server response (has result/error) or garbage.
    if ("result" in record || "error" in record) {
      return { kind: "response" };
    }
    return { kind: "invalid", id };
  }
  if (
    rawId !== undefined &&
    rawId !== null &&
    typeof rawId !== "string" &&
    typeof rawId !== "number"
  ) {
    return { kind: "invalid", id: null };
  }
  if (rawId === undefined) {
    const params =
      typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : {};
    return { kind: "notification", notification: { method: record.method, params } };
  }
  const params =
    typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {};
  return { kind: "request", request: { jsonrpc: "2.0", id, method: record.method, params } };
}

export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)) {
    return requested;
  }
  return MCP_DEFAULT_PROTOCOL_VERSION;
}

export function buildMcpInitializeResult(input: {
  readonly requestedProtocolVersion: unknown;
  readonly serverVersion: string;
  readonly instructions: string;
}): Record<string, unknown> {
  return {
    protocolVersion: negotiateMcpProtocolVersion(input.requestedProtocolVersion),
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "synara",
      title: "Synara App Control",
      version: input.serverVersion,
    },
    instructions: input.instructions,
  };
}
