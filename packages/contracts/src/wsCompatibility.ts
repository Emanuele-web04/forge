import { Schema } from "effect";

import { NonNegativeInt } from "./baseSchemas";

export const WS_PROTOCOL_EPOCH = 1;
export const WS_PROTOCOL_MIN_REVISION = 1;
export const WS_PROTOCOL_MAX_REVISION = 1;
export const WS_BOOTSTRAP_METHOD = "bootstrap.negotiate";
export const WS_BOOTSTRAP_PATH = "/ws/bootstrap";
export const WS_NEGOTIATE_HTTP_PATH = "/ws/negotiate";
export const WS_FEATURE_PATH = "/ws";

// These are protocol budgets, not server implementation details. Keeping the
// browser's desired lease set and server admission on the same values prevents
// prewarming from creating subscriptions the connection can never admit.
export const WS_STREAM_LIMITS = {
  totalPerClient: 20,
  threadPerClient: 8,
} as const;

export const WS_COMPATIBILITY_QUERY = {
  clientBuild: "x-synara-client-build",
  protocolEpoch: "x-synara-protocol-epoch",
  protocolRevision: "x-synara-protocol-revision",
  serverInstanceId: "x-synara-server-instance",
} as const;

export const WS_NEGOTIATE_QUERY = {
  clientBuild: "x-synara-client-build",
  protocolEpoch: "x-synara-protocol-epoch",
  minRevision: "x-synara-protocol-min-revision",
  maxRevision: "x-synara-protocol-max-revision",
  requiredCapability: "x-synara-required-capability",
} as const;

export const WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY = "projects.github-provisioning";

// Capabilities the current client refuses to run without. Kept separate from
// the advertised server list so a newer client can still negotiate with an
// older server (over the legacy bootstrap socket) during a rollout window.
export const WS_CLIENT_REQUIRED_CAPABILITIES = [
  "orchestration.cursor-safe-streams",
  "orchestration.thread-detail-snapshot",
  "rpc.typed-errors",
] as const;

export const WS_SERVER_CAPABILITIES = [
  ...WS_CLIENT_REQUIRED_CAPABILITIES,
  // Optional feature capability: older servers may omit it without making the
  // rest of a newer client unusable during a staggered rollout.
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
  // Single-handshake connect: negotiation is available over plain HTTP at
  // WS_NEGOTIATE_HTTP_PATH, so a connect costs exactly one WebSocket upgrade.
  "transport.http-negotiate",
] as const;

export const WsCompatibilityAction = Schema.Literals(["reload", "update-client", "update-server"]);
export type WsCompatibilityAction = typeof WsCompatibilityAction.Type;

export const WsBootstrapNegotiateInput = Schema.Struct({
  protocolEpoch: Schema.Int,
  minRevision: NonNegativeInt,
  maxRevision: NonNegativeInt,
  clientBuild: Schema.String,
  requiredCapabilities: Schema.Array(Schema.String),
});
export type WsBootstrapNegotiateInput = typeof WsBootstrapNegotiateInput.Type;

export const WsBootstrapNegotiateResult = Schema.Struct({
  protocolEpoch: Schema.Int,
  negotiatedRevision: NonNegativeInt,
  serverBuild: Schema.String,
  serverInstanceId: Schema.String,
  capabilities: Schema.Array(Schema.String),
});
export type WsBootstrapNegotiateResult = typeof WsBootstrapNegotiateResult.Type;

export class WsCompatibilityError extends Schema.TaggedErrorClass<WsCompatibilityError>()(
  "WsCompatibilityError",
  {
    message: Schema.String,
    code: Schema.Literals([
      "WS_PROTOCOL_INCOMPATIBLE",
      "WS_CAPABILITIES_INCOMPATIBLE",
      "WS_NEGOTIATION_REQUIRED",
      "WS_SERVER_GENERATION_CHANGED",
    ]),
    retryable: Schema.Literal(false),
    action: WsCompatibilityAction,
    serverBuild: Schema.String,
    protocolEpoch: Schema.Int,
    minRevision: NonNegativeInt,
    maxRevision: NonNegativeInt,
  },
) {}
