import { GrantClaims, NonNegativeInt, RevocationEvent } from "@synara/contracts";
import { Schema } from "effect";

const ControlEnvelope = {
  v: Schema.Literal(1),
};

export const SpliceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export type SpliceId = typeof SpliceId.Type;

export const SpliceRequest = Schema.Struct({
  ...ControlEnvelope,
  type: Schema.Literal("splice_request"),
  spliceId: SpliceId,
  hostId: GrantClaims.fields.hostId,
  userId: GrantClaims.fields.sub,
  deviceJkt: GrantClaims.fields.cnf.fields.jkt,
  expiresAtMs: NonNegativeInt,
});
export type SpliceRequest = typeof SpliceRequest.Type;

export const Revocation = Schema.Struct({
  ...ControlEnvelope,
  type: Schema.Literal("revocation"),
  events: Schema.Array(RevocationEvent),
});
export type Revocation = typeof Revocation.Type;

export const Ping = Schema.Struct({ ...ControlEnvelope, type: Schema.Literal("ping") });
export type Ping = typeof Ping.Type;

export const Pong = Schema.Struct({ ...ControlEnvelope, type: Schema.Literal("pong") });
export type Pong = typeof Pong.Type;

export const Ready = Schema.Struct({ ...ControlEnvelope, type: Schema.Literal("ready") });
export type Ready = typeof Ready.Type;

export const RelayToHostControlMessage = Schema.Union([SpliceRequest, Revocation, Ping]);
export type RelayToHostControlMessage = typeof RelayToHostControlMessage.Type;

export const HostToRelayControlMessage = Schema.Union([Ready, Pong]);
export type HostToRelayControlMessage = typeof HostToRelayControlMessage.Type;

export const RelayControlMessage = Schema.Union([SpliceRequest, Revocation, Ping, Pong, Ready]);
export type RelayControlMessage = typeof RelayControlMessage.Type;

export const RELAY_CLOSE_BAD_TOKEN = 4401 as const;
export const RELAY_CLOSE_GRANT_REPLAY = 4403 as const;
export const RELAY_CLOSE_HOST_UNAVAILABLE = 4404 as const;
export const RELAY_CLOSE_KEEPALIVE_LOST = 4408 as const;
export const RELAY_CLOSE_SUPERSEDED = 4409 as const;
export const RELAY_CLOSE_SPLICE_CLAIMED = 4413 as const;
export const RELAY_CLOSE_OVERLOADED = 1013 as const;

export const RELAY_CLOSE_CODES = {
  BAD_TOKEN: RELAY_CLOSE_BAD_TOKEN,
  GRANT_REPLAY: RELAY_CLOSE_GRANT_REPLAY,
  HOST_UNAVAILABLE: RELAY_CLOSE_HOST_UNAVAILABLE,
  KEEPALIVE_LOST: RELAY_CLOSE_KEEPALIVE_LOST,
  SUPERSEDED: RELAY_CLOSE_SUPERSEDED,
  SPLICE_CLAIMED: RELAY_CLOSE_SPLICE_CLAIMED,
  OVERLOADED: RELAY_CLOSE_OVERLOADED,
} as const;
