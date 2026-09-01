import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  McpConsumerBinding,
  OutboundMcpDecodeError,
  OutboundMcpInputError,
} from "../consumerBinding.ts";

export class McpToolClientError extends Schema.TaggedErrorClass<McpToolClientError>()(
  "McpToolClientError",
  {
    category: Schema.String,
    consumerId: Schema.String,
    connectionId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.category === "tool-not-allowed") {
      return "Tool is not allowed for this consumer.";
    }
    return `Outbound MCP client failed (${this.consumerId}, ${this.category}).`;
  }
}

export type McpToolClientFailure =
  | McpToolClientError
  | OutboundMcpDecodeError
  | OutboundMcpInputError
  | DOMException;

export interface McpToolClientShape {
  readonly validate: <Operation extends string>(
    binding: McpConsumerBinding<Operation>,
    signal?: AbortSignal,
  ) => Effect.Effect<string, McpToolClientFailure>;
  readonly call: <Operation extends string>(
    binding: McpConsumerBinding<Operation>,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Effect.Effect<unknown, McpToolClientFailure>;
  readonly invalidate: (connectionId: string) => Effect.Effect<void, never>;
  readonly closeAll: () => Effect.Effect<void, never>;
}

export class McpToolClient extends ServiceMap.Service<McpToolClient, McpToolClientShape>()(
  "synara/outboundMcp/Services/McpToolClient",
) {}
