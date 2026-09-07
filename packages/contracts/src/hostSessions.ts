// FILE: hostSessions.ts
// Purpose: Owner-visible metadata for the live sessions a host is serving.
// Layer: contracts (schema-only)

import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

export const HostSessionTransport = Schema.Literals(["direct", "relay", "ssh-forward"]);
export type HostSessionTransport = typeof HostSessionTransport.Type;

/** A safe projection of a live session: no socket or close handle crosses RPC. */
export const HostSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  userId: TrimmedNonEmptyString,
  deviceJkt: TrimmedNonEmptyString,
  transport: HostSessionTransport,
  startedAt: IsoDateTime,
});
export type HostSession = typeof HostSession.Type;

export const ListHostSessionsResponse = Schema.Struct({
  sessions: Schema.Array(HostSession),
});
export type ListHostSessionsResponse = typeof ListHostSessionsResponse.Type;

export const EndHostSessionInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type EndHostSessionInput = typeof EndHostSessionInput.Type;
