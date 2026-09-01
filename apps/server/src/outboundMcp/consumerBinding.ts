import { Schema } from "effect";
import type { Effect } from "effect";

export class OutboundMcpDecodeError extends Schema.TaggedErrorClass<OutboundMcpDecodeError>()(
  "OutboundMcpDecodeError",
  {
    consumerId: Schema.String,
    operation: Schema.String,
    category: Schema.String,
  },
) {
  override get message(): string {
    return `Outbound MCP result decoding failed (${this.consumerId}/${this.operation}, ${this.category}).`;
  }
}

export class OutboundMcpInputError extends Schema.TaggedErrorClass<OutboundMcpInputError>()(
  "OutboundMcpInputError",
  {
    consumerId: Schema.String,
    operation: Schema.String,
    category: Schema.String,
  },
) {
  override get message(): string {
    return `Outbound MCP input encoding failed (${this.consumerId}/${this.operation}, ${this.category}).`;
  }
}

export type McpConsumerOperation = {
  readonly tool: string;
  readonly encode: (
    input: unknown,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, OutboundMcpInputError>;
  readonly decode: (result: unknown) => Effect.Effect<unknown, OutboundMcpDecodeError>;
};

export type McpConsumerBinding<Operation extends string> = {
  readonly id: string;
  readonly presetIds: ReadonlySet<string>;
  readonly requiredTools: ReadonlySet<string>;
  readonly optionalTools: ReadonlySet<string>;
  readonly operations: Readonly<Record<Operation, McpConsumerOperation>>;
};
