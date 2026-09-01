import type {
  OutboundMcpBeginAuthorizationInput,
  OutboundMcpBeginAuthorizationResult,
  OutboundMcpConnection,
  OutboundMcpDisconnectInput,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

export type McpConnectionEvent = {
  readonly connectionId: string;
  readonly type: "connected" | "credentials-invalidated" | "disconnected";
};

export type McpAuthorizationCompletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly category:
        | "authorization-cancelled"
        | "invalid-authorization-attempt"
        | "incompatible-client"
        | "incompatible-tools"
        | "reconnect-required"
        | "temporarily-unavailable";
    };

export type McpCompleteAuthorizationInput = {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
};

export class McpConnectionServiceError extends Schema.TaggedErrorClass<McpConnectionServiceError>()(
  "McpConnectionServiceError",
  { category: Schema.String },
) {
  override get message(): string {
    return `Outbound MCP connection operation failed (${this.category}).`;
  }
}

export interface McpConnectionServiceShape {
  readonly list: () => Effect.Effect<
    ReadonlyArray<OutboundMcpConnection>,
    McpConnectionServiceError
  >;
  readonly beginAuthorization: (
    input: OutboundMcpBeginAuthorizationInput,
  ) => Effect.Effect<OutboundMcpBeginAuthorizationResult, McpConnectionServiceError>;
  readonly completeAuthorization: (
    input: McpCompleteAuthorizationInput,
  ) => Effect.Effect<McpAuthorizationCompletion, McpConnectionServiceError>;
  readonly disconnect: (
    input: OutboundMcpDisconnectInput,
  ) => Effect.Effect<void, McpConnectionServiceError>;
  readonly invoke: (
    consumerId: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Effect.Effect<unknown, McpConnectionServiceError>;
  readonly subscribe: (listener: (event: McpConnectionEvent) => void) => Effect.Effect<() => void>;
}

export class McpConnectionService extends ServiceMap.Service<
  McpConnectionService,
  McpConnectionServiceShape
>()("synara/outboundMcp/Services/McpConnectionService") {}
