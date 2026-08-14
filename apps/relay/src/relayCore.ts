import {
  RELAY_TICKET_MAX_AGE_SECONDS,
  type GrantClaims,
  type RelayTicketClaims,
  type RevocationEvent,
} from "@synara/contracts";
import {
  HostToRelayControlMessage,
  RELAY_CLOSE_BAD_TOKEN,
  RELAY_CLOSE_GRANT_REPLAY,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_CLOSE_KEEPALIVE_LOST,
  RELAY_CLOSE_OVERLOADED,
  RELAY_CLOSE_SPLICE_CLAIMED,
  RELAY_CLOSE_SUPERSEDED,
  type RelayToHostControlMessage,
} from "@synara/relay-protocol";
import { Schema } from "effect";
import { randomBytes } from "node:crypto";

import { GrantReplayCache } from "./grantReplayCache";
import type { ApiJwtVerifier } from "./jwtVerifier";
import { createSplicePair, type SplicePair, type SpliceSocket } from "./splicePair";

const DEFAULT_PENDING_TIMEOUT_MS = 10_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
const CLAIMED_SPLICE_RETENTION_MS = 60_000;
/**
 * How long an unlinked host is refused. Must cover the relay ticket's full
 * lifetime (5 min, RELAY_TICKET_MAX_AGE_SECONDS) plus clock tolerance, so a
 * ticket minted just before the unlink cannot outlive the tombstone.
 */
const UNLINKED_HOST_TOMBSTONE_MS = (RELAY_TICKET_MAX_AGE_SECONDS + 120) * 1_000;
const MAX_EARLY_CONTROL_FRAMES = 8;

type Logger = Pick<Console, "error" | "warn">;

export type RelayCoreOptions = {
  verifier: ApiJwtVerifier;
  maxPairs: number;
  highWaterBytes: number;
  pendingTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  stallTimeoutMs?: number;
  backpressurePollMs?: number;
  now?: () => number;
  createSpliceId?: () => string;
  logger?: Logger;
};

type HostConnection = {
  hostId: string;
  socket: SpliceSocket;
  ready: boolean;
  missedPongs: number;
  keepaliveTimer: ReturnType<typeof setInterval>;
  cleanups: Array<() => void>;
};

type PendingSplice = {
  id: string;
  hostId: string;
  host: HostConnection;
  client: SpliceSocket;
  timeout: ReturnType<typeof setTimeout>;
  removeClientClose: () => void;
};

function defaultSpliceId(): string {
  return randomBytes(32).toString("base64url");
}

export class RelayCore {
  private readonly hosts = new Map<string, HostConnection>();
  private readonly pending = new Map<string, PendingSplice>();
  private readonly pairs = new Map<string, SplicePair>();
  private readonly claimedSplices = new Map<string, number>();
  /** hostId -> when its pre-unlink tickets can no longer be valid. */
  private readonly unlinkedHosts = new Map<string, number>();
  private readonly replayCache: GrantReplayCache;
  private readonly now: () => number;
  private readonly logger: Logger;
  private stopped = false;

  constructor(private readonly options: RelayCoreOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.replayCache = new GrantReplayCache(this.now);
  }

  /**
   * Whether this exact host is connected AND ready to be spliced.
   *
   * The aggregate counts cannot answer "can I reach THIS machine" — a client
   * probing the relay learned only that the relay was up, so every host in a
   * relay-configured deployment read as reachable and the truth surfaced late
   * as a 4404 at session open. Exposed as a boolean and nothing else: it says
   * no more than the client is entitled to know (ADR 0010).
   */
  isHostReady(hostId: string): boolean {
    return this.hosts.get(hostId)?.ready === true;
  }

  get hostCount(): number {
    return this.hosts.size;
  }

  get pairCount(): number {
    return this.pairs.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async admitHost(socket: SpliceSocket, ticket: string): Promise<void> {
    if (this.stopped) {
      socket.close(1001, "relay is shutting down");
      return;
    }

    const earlyFrames: Array<{ data: Buffer; binary: boolean }> = [];
    let connection: HostConnection | undefined;
    let socketClosed = false;
    let processFrame: ((data: Buffer, binary: boolean) => void) | undefined;
    const removeMessage = socket.onMessage((data, binary) => {
      if (processFrame) {
        processFrame(data, binary);
      } else if (earlyFrames.length < MAX_EARLY_CONTROL_FRAMES) {
        earlyFrames.push({ data, binary });
      }
    });
    const removeClose = socket.onClose(() => {
      socketClosed = true;
      if (connection) this.onControlClosed(connection);
    });

    let claims: RelayTicketClaims;
    try {
      claims = await this.options.verifier.verifyRelayTicket(ticket);
    } catch {
      removeMessage();
      removeClose();
      socket.close(RELAY_CLOSE_BAD_TOKEN, "relay ticket rejected");
      return;
    }
    if (socketClosed || this.stopped) {
      removeMessage();
      removeClose();
      // A socket abandoned mid-admission still needs closing, or it lingers
      // ownerless with no keepalive until TCP timeout.
      if (!socketClosed) socket.close(1001, "relay is shutting down");
      return;
    }
    this.sweepUnlinkedHosts();
    if (this.unlinkedHosts.has(claims.sub)) {
      removeMessage();
      removeClose();
      socket.close(RELAY_CLOSE_BAD_TOKEN, "host was unlinked");
      return;
    }

    const keepaliveTimer = setInterval(
      () => this.keepalive(connection as HostConnection),
      this.options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
    );
    keepaliveTimer.unref?.();
    connection = {
      hostId: claims.sub,
      socket,
      ready: false,
      missedPongs: 0,
      keepaliveTimer,
      cleanups: [removeMessage, removeClose],
    };
    processFrame = (data, binary) =>
      this.onControlFrame(connection as HostConnection, data, binary);

    const existing = this.hosts.get(claims.sub);
    this.hosts.set(claims.sub, connection);
    if (existing) this.disconnectControl(existing, RELAY_CLOSE_SUPERSEDED, "control superseded");
    for (const frame of earlyFrames) processFrame(frame.data, frame.binary);
  }

  async admitClient(client: SpliceSocket, grant: string): Promise<void> {
    client.pauseReads();
    if (this.stopped) {
      client.close(1001, "relay is shutting down");
      return;
    }

    // The close listener must exist BEFORE the verification await: a client
    // that opens and immediately disconnects would otherwise have its close
    // event fire with no listener, and the admission would go on to burn the
    // grant, occupy a pending slot, and hand the host a pair around a dead
    // socket whose onClose can never fire — leaking the slot permanently.
    let socketClosed = false;
    const removeEarlyClose = client.onClose(() => {
      socketClosed = true;
    });

    let claims: GrantClaims;
    try {
      claims = await this.options.verifier.verifyGrant(grant);
    } catch {
      removeEarlyClose();
      client.close(RELAY_CLOSE_BAD_TOKEN, "relay grant rejected");
      return;
    }
    if (socketClosed || this.stopped) {
      removeEarlyClose();
      return;
    }

    // Identity boundary: hostId is the only lookup key. environmentId is
    // intentionally never read by this state machine.
    const host = this.hosts.get(claims.hostId);
    if (!host?.ready) {
      removeEarlyClose();
      client.close(RELAY_CLOSE_HOST_UNAVAILABLE, "host is not connected");
      return;
    }
    if (this.pending.size + this.pairs.size >= this.options.maxPairs) {
      removeEarlyClose();
      client.close(RELAY_CLOSE_OVERLOADED, "relay pair capacity reached");
      return;
    }
    // Burn the grant only once admission is certain: consuming before the
    // capacity check destroys a legitimate grant on overload, turning a
    // retryable 1013 into a 4403 replay refusal on the client's retry.
    if (!this.replayCache.consume(claims.jti, claims.exp)) {
      removeEarlyClose();
      client.close(RELAY_CLOSE_GRANT_REPLAY, "relay grant already used");
      return;
    }
    removeEarlyClose();

    this.sweepClaimedSplices();
    const id = (this.options.createSpliceId ?? defaultSpliceId)();
    const timeout = setTimeout(
      () => this.expirePending(id),
      this.options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS,
    );
    timeout.unref?.();
    const removeClientClose = client.onClose(() => this.removePending(id));
    const pending: PendingSplice = {
      id,
      hostId: claims.hostId,
      host,
      client,
      timeout,
      removeClientClose,
    };
    this.pending.set(id, pending);

    try {
      this.sendControl(host, {
        v: 1,
        type: "splice_request",
        spliceId: id,
        hostId: claims.hostId,
        userId: claims.sub,
        deviceJkt: claims.cnf.jkt,
        expiresAtMs: claims.exp * 1_000,
      });
    } catch (error) {
      this.logger.warn("[relay] failed to signal host for splice", error);
      this.removePending(id);
      client.close(RELAY_CLOSE_HOST_UNAVAILABLE, "host control socket unavailable");
    }
  }

  admitHostData(hostData: SpliceSocket, spliceId: string): void {
    hostData.pauseReads();
    this.sweepClaimedSplices();
    if (this.claimedSplices.has(spliceId) || this.pairs.has(spliceId)) {
      hostData.close(RELAY_CLOSE_SPLICE_CLAIMED, "splice already claimed");
      return;
    }
    const pending = this.pending.get(spliceId);
    if (!pending) {
      hostData.close(RELAY_CLOSE_HOST_UNAVAILABLE, "splice is unavailable");
      return;
    }
    if (this.hosts.get(pending.hostId) !== pending.host) {
      this.removePending(spliceId);
      pending.client.close(RELAY_CLOSE_HOST_UNAVAILABLE, "host control socket changed");
      hostData.close(RELAY_CLOSE_HOST_UNAVAILABLE, "splice host is unavailable");
      return;
    }

    this.removePending(spliceId);
    this.claimedSplices.set(spliceId, this.now() + CLAIMED_SPLICE_RETENTION_MS);
    let pair: SplicePair;
    pair = createSplicePair({
      id: spliceId,
      hostId: pending.hostId,
      client: pending.client,
      host: hostData,
      highWaterBytes: this.options.highWaterBytes,
      ...(this.options.stallTimeoutMs === undefined
        ? {}
        : { stallTimeoutMs: this.options.stallTimeoutMs }),
      ...(this.options.backpressurePollMs === undefined
        ? {}
        : { backpressurePollMs: this.options.backpressurePollMs }),
      onClosed: () => {
        if (this.pairs.get(spliceId) === pair) this.pairs.delete(spliceId);
      },
    });
    this.pairs.set(spliceId, pair);
    pending.client.resumeReads();
    hostData.resumeReads();
  }

  deliverRevocations(events: readonly RevocationEvent[]): void {
    const byHost = new Map<string, RevocationEvent[]>();
    for (const event of events) {
      const group = byHost.get(event.hostId);
      if (group) group.push(event);
      else byHost.set(event.hostId, [event]);
    }
    for (const [hostId, hostEvents] of byHost) {
      const unlinked = hostEvents.some((event) => event.kind === "host_unlinked");
      if (unlinked) {
        // The unlinked host's ticket is already minted and stays
        // syntactically valid for up to five minutes, so closing the socket
        // is not enough — it would simply reconnect and keep serving grants
        // issued before the unlink. Tombstone the host id for the ticket's
        // full lifetime so reconnects are refused until every pre-unlink
        // ticket has expired.
        this.unlinkedHosts.set(hostId, this.now() + UNLINKED_HOST_TOMBSTONE_MS);
      }
      const host = this.hosts.get(hostId);
      if (host) {
        try {
          this.sendControl(host, { v: 1, type: "revocation", events: hostEvents });
        } catch (error) {
          this.logger.warn("[relay] failed to deliver revocation to host", error);
        }
      }
      if (unlinked) {
        // Tear down whether or not a control socket is currently registered:
        // pairs can outlive their control, and an unlinked host's sessions
        // must not survive on a technicality.
        if (host) this.teardownHost(host, RELAY_CLOSE_BAD_TOKEN, "host was unlinked");
        else {
          this.closePairsForHost(hostId, RELAY_CLOSE_BAD_TOKEN, "host was unlinked");
          this.cancelPendingForHostId(hostId, RELAY_CLOSE_BAD_TOKEN, "host was unlinked");
        }
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Shutdown is a relay outage, not a host-unavailable admission failure.
    // Close data-plane state first so disconnecting each control socket cannot
    // rewrite its clients to 4404 through the ordinary host-loss path.
    for (const pending of [...this.pending.values()]) {
      this.removePending(pending.id);
      pending.client.close(1001, "relay is shutting down");
    }
    for (const pair of [...this.pairs.values()]) pair.close(1001, "relay is shutting down");
    for (const host of [...this.hosts.values()]) {
      this.disconnectControl(host, 1001, "relay is shutting down");
    }
    this.hosts.clear();
    this.pending.clear();
    this.pairs.clear();
    this.claimedSplices.clear();
  }

  private onControlFrame(connection: HostConnection, data: Buffer, binary: boolean): void {
    if (binary || this.hosts.get(connection.hostId) !== connection) return;
    try {
      const message = Schema.decodeUnknownSync(HostToRelayControlMessage)(
        JSON.parse(data.toString("utf8")) as unknown,
      );
      if (message.type === "ready") connection.ready = true;
      else connection.missedPongs = 0;
    } catch {
      // The control protocol is deliberately tolerant: unknown future message
      // types and malformed frames do not destabilize a host connection.
    }
  }

  private keepalive(connection: HostConnection): void {
    if (this.hosts.get(connection.hostId) !== connection) return;
    connection.missedPongs += 1;
    if (connection.missedPongs >= 2) {
      this.teardownHost(connection, RELAY_CLOSE_KEEPALIVE_LOST, "host keepalive lost");
      return;
    }
    try {
      this.sendControl(connection, { v: 1, type: "ping" });
    } catch {
      this.teardownHost(connection, RELAY_CLOSE_KEEPALIVE_LOST, "host keepalive failed");
    }
  }

  private sendControl(host: HostConnection, message: RelayToHostControlMessage): void {
    host.socket.send(Buffer.from(JSON.stringify(message)), false);
  }

  private onControlClosed(connection: HostConnection): void {
    if (this.hosts.get(connection.hostId) === connection) this.hosts.delete(connection.hostId);
    this.cleanupControl(connection);
    this.cancelPendingForHost(connection, RELAY_CLOSE_HOST_UNAVAILABLE, "host disconnected");
    // Established pairs die with the control socket that owns them. A pair
    // outliving its control is unreachable by revocation — the relay would
    // keep splicing traffic to a host it can no longer be told to cut off —
    // and its maxPairs slot would never be reclaimed.
    this.closePairsForHost(connection.hostId, RELAY_CLOSE_HOST_UNAVAILABLE, "host disconnected");
  }

  private disconnectControl(connection: HostConnection, code: number, reason: string): void {
    if (this.hosts.get(connection.hostId) === connection) this.hosts.delete(connection.hostId);
    this.cleanupControl(connection);
    this.cancelPendingForHost(connection, RELAY_CLOSE_HOST_UNAVAILABLE, "host disconnected");
    this.closePairsForHost(connection.hostId, RELAY_CLOSE_HOST_UNAVAILABLE, reason);
    connection.socket.close(code, reason);
  }

  private teardownHost(connection: HostConnection, code: number, reason: string): void {
    if (this.hosts.get(connection.hostId) === connection) this.hosts.delete(connection.hostId);
    this.cleanupControl(connection);
    this.cancelPendingForHost(connection, code, reason);
    this.closePairsForHost(connection.hostId, code, reason);
    connection.socket.close(code, reason);
  }

  /** Every pair belonging to a host, whether or not its control is current. */
  private closePairsForHost(hostId: string, code: number, reason: string): void {
    for (const pair of [...this.pairs.values()]) {
      if (pair.hostId === hostId) pair.close(code, reason);
    }
  }

  private cleanupControl(connection: HostConnection): void {
    clearInterval(connection.keepaliveTimer);
    for (const cleanup of connection.cleanups.splice(0)) cleanup();
  }

  private cancelPendingForHost(connection: HostConnection, code: number, reason: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.host !== connection) continue;
      this.removePending(pending.id);
      pending.client.close(code, reason);
    }
  }

  private cancelPendingForHostId(hostId: string, code: number, reason: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.hostId !== hostId) continue;
      this.removePending(pending.id);
      pending.client.close(code, reason);
    }
  }

  private sweepUnlinkedHosts(): void {
    const now = this.now();
    for (const [hostId, expiresAt] of this.unlinkedHosts) {
      if (expiresAt <= now) this.unlinkedHosts.delete(hostId);
    }
  }

  private expirePending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.removePending(id);
    pending.client.close(RELAY_CLOSE_HOST_UNAVAILABLE, "splice timed out");
  }

  private removePending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    pending.removeClientClose();
  }

  private sweepClaimedSplices(): void {
    const now = this.now();
    for (const [id, expiry] of this.claimedSplices) {
      if (expiry <= now) this.claimedSplices.delete(id);
    }
  }
}
