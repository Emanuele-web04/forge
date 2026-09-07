// FILE: registry.ts
// Purpose: The outbound sessions this shell holds to other hosts, keyed by
//          host, and the local upgrade path a renderer uses to be bridged
//          onto one of them.
// Layer: server host connections
//
// One session per host at a time. A renderer that connects to the local
// `/ws/remote/:hostId` path gets its frames forwarded verbatim onto the
// dialed socket and back; the host on the other end sees the ordinary Synara
// WebSocket protocol, exactly as the relay-splice path delivers it. Several
// renderer windows may share one dialed session, but the first one to attach
// owns the RPC stream state on the far side — this version therefore allows a
// single attachment and refuses a second with a clear close.

import type { HostConnection, HostConnectionTransport } from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import WebSocket, { type RawData } from "ws";

import type { RelaySocket } from "../relayDial";
import type { DialedSession } from "./dialer";

export const HOST_CONNECTION_WS_PATH_PREFIX = "/ws/remote/";

/** Same as the relay's forwarding: reserved codes cannot be sent on the wire. */
function forwardableCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return 1001;
  return code >= 1000 && code <= 4999 ? code : 1001;
}

function normalizeFrame(data: RawData, binary: boolean): string | Buffer {
  if (!binary) return data.toString();
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

interface Connection {
  readonly hostId: string;
  readonly hostName: string;
  readonly transport: HostConnectionTransport;
  readonly startedAt: string;
  readonly credentialExpiresAt: string;
  readonly session: DialedSession;
  attachment: RelaySocket | undefined;
  detachAttachment: (() => void) | undefined;
}

export class HostConnectionRegistry {
  readonly #connections = new Map<string, Connection>();
  readonly #listeners = new Set<() => void>();

  list(): readonly HostConnection[] {
    return [...this.#connections.values()].map((connection) => this.project(connection));
  }

  get(hostId: string): HostConnection | undefined {
    const connection = this.#connections.get(hostId);
    return connection ? this.project(connection) : undefined;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Records a freshly dialed session, replacing any prior one to the same host. */
  add(input: {
    readonly hostId: string;
    readonly hostName: string;
    readonly session: DialedSession;
  }): HostConnection {
    this.remove(input.hostId, 1000, "replaced by a new connection");
    const connection: Connection = {
      hostId: input.hostId,
      hostName: input.hostName,
      transport: input.session.transport,
      startedAt: new Date().toISOString(),
      credentialExpiresAt: new Date(input.session.credentialExpiresAtSeconds * 1000).toISOString(),
      session: input.session,
      attachment: undefined,
      detachAttachment: undefined,
    };
    this.#connections.set(input.hostId, connection);
    input.session.socket.on("close", () => {
      if (this.#connections.get(input.hostId) === connection) {
        connection.detachAttachment?.();
        this.#connections.delete(input.hostId);
        this.notify();
      }
    });
    this.notify();
    return this.project(connection);
  }

  remove(hostId: string, code = 1000, reason = "disconnected"): boolean {
    const connection = this.#connections.get(hostId);
    if (!connection) return false;
    this.#connections.delete(hostId);
    connection.detachAttachment?.();
    const socket = connection.session.socket;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
    this.notify();
    return true;
  }

  /**
   * Bridges a renderer-facing socket onto the dialed session. Frames flow
   * both ways untouched; a close on either side closes the other with the
   * same code, so the renderer sees the host's own close semantics (a 4503
   * revocation, for instance) rather than a generic drop.
   */
  attach(hostId: string, local: RelaySocket): boolean {
    const connection = this.#connections.get(hostId);
    if (!connection) {
      local.close(4404, "no open connection to that host");
      return false;
    }
    if (connection.attachment) {
      local.close(4409, "another window already holds this connection");
      return false;
    }
    const remote = connection.session.socket;
    const toRemote = (data: RawData, binary: boolean) => {
      if (remote.readyState === WebSocket.OPEN) {
        remote.send(normalizeFrame(data, binary), { binary });
      }
    };
    const toLocal = (data: RawData, binary: boolean) => {
      if (local.readyState === WebSocket.OPEN) {
        local.send(
          binary ? (normalizeFrame(data, true) as Buffer) : (normalizeFrame(data, false) as string),
        );
      }
    };
    const onRemoteClose = (code: number, reason: Buffer) => {
      detach();
      local.close(forwardableCloseCode(code), reason.toString("utf8"));
    };
    const onLocalClose = () => {
      // The renderer went away; keep the dialed session for the next window.
      detach();
    };
    const detach = () => {
      if (connection.attachment !== local) return;
      connection.attachment = undefined;
      connection.detachAttachment = undefined;
      local.removeAllListeners("message");
      local.removeAllListeners("close");
      remote.off("message", toLocal);
      remote.off("close", onRemoteClose);
    };
    connection.attachment = local;
    connection.detachAttachment = detach;
    local.on("message", toRemote);
    local.on("close", onLocalClose);
    remote.on("message", toLocal);
    remote.on("close", onRemoteClose);
    return true;
  }

  closeAll(): void {
    for (const hostId of Array.from(this.#connections.keys())) {
      this.remove(hostId, 1001, "shutting down");
    }
  }

  private project(connection: Connection): HostConnection {
    return {
      hostId: connection.hostId,
      hostName: connection.hostName,
      transport: connection.transport,
      startedAt: connection.startedAt,
      credentialExpiresAt: connection.credentialExpiresAt,
      wsPath: `${HOST_CONNECTION_WS_PATH_PREFIX}${encodeURIComponent(connection.hostId)}`,
    };
  }

  private notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not break connection bookkeeping.
      }
    }
  }
}

export class HostConnectionRegistryService extends ServiceMap.Service<
  HostConnectionRegistryService,
  HostConnectionRegistry
>()("synara/HostConnectionRegistry") {}

export const HostConnectionRegistryLive = Layer.effect(
  HostConnectionRegistryService,
  Effect.gen(function* () {
    const registry = new HostConnectionRegistry();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.closeAll()));
    return registry;
  }),
);
