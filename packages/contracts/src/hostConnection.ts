// FILE: hostConnection.ts
// Purpose: The client-side view of an outbound session to another host — what
//          the shell opened, over which transport, and how a renderer reaches
//          it. Schema-only.
// Layer: contracts (schema-only)

import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * The transport the outbound session actually won (ADR 0007 preference
 * order). Mirrors `TransportKind` in @synara/shared/transportRace, which is
 * runtime code and cannot be imported here.
 */
export const HostConnectionTransport = Schema.Literals([
  "loopback",
  "lan",
  "tailscale",
  "ssh",
  "relay",
]);
export type HostConnectionTransport = typeof HostConnectionTransport.Type;

/**
 * An open outbound session this shell holds to another host.
 *
 * `wsPath` is the local upgrade path a renderer connects to in order to be
 * bridged onto that session: the shell owns the device key and the minted
 * credential, so the renderer never handles either. Everything past the
 * handshake is the ordinary Synara WebSocket protocol, spoken to the remote
 * host as if it were local.
 */
export const HostConnection = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  hostName: TrimmedNonEmptyString,
  transport: HostConnectionTransport,
  startedAt: IsoDateTime,
  /** When the minted session credential expires; the shell re-mints before then. */
  credentialExpiresAt: IsoDateTime,
  /** Local path a renderer upgrades on to reach this session. */
  wsPath: TrimmedNonEmptyString,
});
export type HostConnection = typeof HostConnection.Type;

export const HostsConnectInput = Schema.Struct({
  hostId: TrimmedNonEmptyString,
});
export type HostsConnectInput = typeof HostsConnectInput.Type;

export const HostsDisconnectInput = Schema.Struct({
  hostId: TrimmedNonEmptyString,
});
export type HostsDisconnectInput = typeof HostsDisconnectInput.Type;

export const ListHostConnectionsResponse = Schema.Struct({
  connections: Schema.Array(HostConnection),
});
export type ListHostConnectionsResponse = typeof ListHostConnectionsResponse.Type;
