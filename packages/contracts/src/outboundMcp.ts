import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

export const OutboundMcpConnectionStatus = Schema.Literals([
  "disconnected",
  "authorizing",
  "connected",
  "reconnect-required",
  "incompatible",
  "temporarily-unavailable",
]);
export type OutboundMcpConnectionStatus = typeof OutboundMcpConnectionStatus.Type;

export const OutboundMcpConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  presetId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
  status: OutboundMcpConnectionStatus,
  lastValidatedAt: Schema.NullOr(IsoDateTime),
  errorCategory: Schema.NullOr(TrimmedNonEmptyString),
});
export type OutboundMcpConnection = typeof OutboundMcpConnection.Type;

export const OutboundMcpListResult = Schema.Struct({
  connections: Schema.Array(OutboundMcpConnection),
});
export type OutboundMcpListResult = typeof OutboundMcpListResult.Type;

export const OutboundMcpBeginAuthorizationInput = Schema.Struct({
  presetId: TrimmedNonEmptyString,
});
export type OutboundMcpBeginAuthorizationInput = typeof OutboundMcpBeginAuthorizationInput.Type;

export const OutboundMcpBeginAuthorizationResult = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  authorizationUrl: TrimmedNonEmptyString,
});
export type OutboundMcpBeginAuthorizationResult = typeof OutboundMcpBeginAuthorizationResult.Type;

export const OutboundMcpDisconnectInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
});
export type OutboundMcpDisconnectInput = typeof OutboundMcpDisconnectInput.Type;
