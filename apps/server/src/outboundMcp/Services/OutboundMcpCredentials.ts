import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export type OutboundMcpCredentialRecord = {
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly tokens?: OAuthTokens;
  readonly authorizationServerUrl?: string;
};

export class OutboundMcpCredentialsError extends Data.TaggedError(
  "OutboundMcpCredentialsError",
)<{
  readonly operation: "read" | "write" | "delete" | "clearAttemptSecrets";
  readonly category: "invalid-connection-id" | "invalid-credentials" | "filesystem";
}> {
  override get message(): string {
    return `Failed to ${this.operation} outbound MCP credentials (${this.category}).`;
  }
}

export interface OutboundMcpCredentialsShape {
  readonly read: (
    connectionId: string,
  ) => Effect.Effect<OutboundMcpCredentialRecord | null, OutboundMcpCredentialsError>;
  readonly write: (
    connectionId: string,
    credentials: OutboundMcpCredentialRecord,
  ) => Effect.Effect<void, OutboundMcpCredentialsError>;
  readonly delete: (
    connectionId: string,
  ) => Effect.Effect<void, OutboundMcpCredentialsError>;
  readonly clearAttemptSecrets: (
    connectionId: string,
  ) => Effect.Effect<void, OutboundMcpCredentialsError>;
}

export class OutboundMcpCredentials extends ServiceMap.Service<
  OutboundMcpCredentials,
  OutboundMcpCredentialsShape
>()("synara/outboundMcp/Services/OutboundMcpCredentials") {}
