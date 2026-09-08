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

export const CurrentWsSessionRole = ServiceMap.Reference<WsSessionRole>(
  "synara/ws/CurrentSessionRole",
  { defaultValue: () => "client" },
);

export interface WsConnectionSession {
  readonly role: WsSessionRole;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
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
  /** Registers cleanup on a live socket; false means it has already closed. */
  readonly onClose: (key: string, cleanup: () => void) => boolean;
}

export class WsConnectionSessions extends ServiceMap.Service<
  WsConnectionSessions,
  WsConnectionSessionsShape
>()("synara/ws/WsConnectionSessions") {}

export const makeWsConnectionSessions = Effect.sync(() => {
  const sessions = new Map<
    string,
    { readonly session: WsConnectionSession; readonly cleanups: Set<() => void> }
  >();
  return {
    register: (session: WsConnectionSession) =>
      Effect.gen(function* () {
        const key = randomUUID();
        const cleanups = new Set<() => void>();
        sessions.set(key, { session, cleanups });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessions.delete(key);
            for (const cleanup of cleanups) cleanup();
            cleanups.clear();
          }),
        );
        return key;
      }),
    lookup: (key: string | undefined) =>
      key === undefined ? undefined : sessions.get(key)?.session,
    onClose: (key: string, cleanup: () => void) => {
      const connection = sessions.get(key);
      if (!connection) return false;
      connection.cleanups.add(cleanup);
      return true;
    },
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
