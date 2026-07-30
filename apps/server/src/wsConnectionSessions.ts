// Purpose: correlate authenticated WebSocket upgrades with RPC handler execution.
// Layer: server transport support
//
// RpcServer.toHttpEffectWebsocket forks the RPC server on the layer-build scope,
// so services provided around the per-connection HTTP upgrade effect never reach
// handler fibers. This registry bridges that gap: the upgrade route registers the
// connection's authenticated session under an unguessable key, injects the key as
// a synthetic request header (overriding any client-supplied value), and the RPC
// admission middleware resolves it back into handler-scoped services.
import { randomUUID } from "node:crypto";

import { Effect, Layer, Scope, ServiceMap } from "effect";

import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "./managedAttachmentPrincipal";

export type WsSessionRole = "owner" | "client";

/** Conservative default: an unresolved connection session is never an owner. */
export const DEFAULT_WS_SESSION_ROLE: WsSessionRole = "client";

export const CurrentWsSessionRole = ServiceMap.Reference<WsSessionRole>(
  "synara/ws/CurrentSessionRole",
  { defaultValue: () => DEFAULT_WS_SESSION_ROLE },
);

export interface WsConnectionSession {
  readonly role: WsSessionRole;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
  /**
   * Whether this connection's client build is version-skewed from the server.
   * Classified once at upgrade from the client build it presented, and enforced
   * by the admission middleware. The client refuses writes too, but that is UX:
   * an older client predating the client-side guard, or any direct client, only
   * stops here.
   */
  readonly buildSkewed: boolean;
}

/**
 * Synthetic header carrying the connection-session key. It is set server-side on
 * the upgrade request (never sent to clients), and Headers.set overrides any
 * value a client tried to smuggle in, so entries cannot be forged or replayed.
 */
export const WS_CONNECTION_SESSION_HEADER = "x-synara-ws-connection-session";

export interface WsConnectionSessionsShape {
  /** Registers the session for the lifetime of the connection scope. */
  readonly register: (session: WsConnectionSession) => Effect.Effect<string, never, Scope.Scope>;
  readonly lookup: (key: string | undefined) => WsConnectionSession | undefined;
}

export class WsConnectionSessions extends ServiceMap.Service<
  WsConnectionSessions,
  WsConnectionSessionsShape
>()("synara/ws/WsConnectionSessions") {}

export const makeWsConnectionSessions = Effect.sync(() => {
  const sessions = new Map<string, WsConnectionSession>();
  return {
    register: (session: WsConnectionSession) =>
      Effect.gen(function* () {
        const key = randomUUID();
        sessions.set(key, session);
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(key)));
        return key;
      }),
    lookup: (key: string | undefined) => (key === undefined ? undefined : sessions.get(key)),
  } satisfies WsConnectionSessionsShape;
});

export const WsConnectionSessionsLive = Layer.effect(
  WsConnectionSessions,
  makeWsConnectionSessions,
);

/**
 * Provides the connection session's identity services to an RPC handler
 * effect. With no session (no or unknown key), the effect keeps the
 * conservative defaults: role "client" and the local-loopback principal.
 */
export function provideWsConnectionSession<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  session: WsConnectionSession | undefined,
): Effect.Effect<A, E, R> {
  return session
    ? effect.pipe(
        Effect.provideService(CurrentWsSessionRole, session.role),
        Effect.provideService(CurrentManagedAttachmentPrincipal, session.attachmentPrincipal),
      )
    : effect;
}
