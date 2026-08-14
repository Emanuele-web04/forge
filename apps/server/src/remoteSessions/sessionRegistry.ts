import { HOST_SESSION_CLOSE_REVOKED } from "@synara/relay-protocol";
import {
  SESSION_CREDENTIAL_MAX_AGE_SECONDS,
  type HostAuthorizationSnapshot,
  type HostSession,
  type RevocationEvent,
} from "@synara/contracts";
import { Layer, ServiceMap } from "effect";

export interface RemoteSession {
  readonly id: string;
  readonly userId: string;
  readonly deviceJkt: string;
  readonly startedAt: string;
  readonly expiresAtSeconds: number;
  readonly via: "direct" | "relay" | "ssh-forward";
  readonly close: (code: number, reason: string) => void;
}

export const REMOTE_SESSION_REVOKED_CLOSE_CODE = HOST_SESSION_CLOSE_REVOKED;

/** Matches the session-credential lifetime: past it, the credential is dead anyway. */
const REVOKED_DEVICE_RETENTION_MS = SESSION_CREDENTIAL_MAX_AGE_SECONDS * 1_000;

export class RemoteSessionRegistry {
  /** deviceJkt -> when its credentials can no longer be presented. */
  readonly #revokedDevices = new Map<string, number>();
  readonly #sessions = new Map<string, RemoteSession>();

  add(session: RemoteSession): () => void {
    this.#sessions.set(session.id, session);
    return () => this.#sessions.delete(session.id);
  }

  get size(): number {
    return this.#sessions.size;
  }

  list(): readonly HostSession[] {
    return [...this.#sessions.values()]
      .map(({ id, userId, deviceJkt, via, startedAt }) => ({
        id,
        userId,
        deviceJkt,
        transport: via,
        startedAt,
      }))
      .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  /**
   * Whether this device may open a NEW session.
   *
   * Killing live sessions was never enough: revocation invalidates the
   * DEVICE, but a session credential stays cryptographically valid for its
   * full hour, and minting a fresh DPoP proof is trivial for whoever holds
   * the device key. Without this check a revoked device simply reconnects
   * over LAN or an SSH forward — no relay, no cloud, nothing to refuse it —
   * and re-admits itself with the credential it already had.
   */
  isDeviceRevoked(deviceJkt: string, nowMs = Date.now()): boolean {
    const until = this.#revokedDevices.get(deviceJkt);
    if (until === undefined) return false;
    if (until <= nowMs) {
      this.#revokedDevices.delete(deviceJkt);
      return false;
    }
    return true;
  }

  /**
   * Retained for the session-credential lifetime: past that the credential
   * cannot be presented anyway, so the entry stops earning its memory.
   */
  #rememberRevoked(deviceJkt: string, nowMs = Date.now()): void {
    this.#revokedDevices.set(deviceJkt, nowMs + REVOKED_DEVICE_RETENTION_MS);
  }

  end(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    this.#sessions.delete(sessionId);
    session.close(REMOTE_SESSION_REVOKED_CLOSE_CODE, "ended by host owner");
    return true;
  }

  private dropWhere(predicate: (session: RemoteSession) => boolean, reason: string): void {
    for (const session of this.#sessions.values()) {
      if (!predicate(session)) continue;
      this.#sessions.delete(session.id);
      session.close(REMOTE_SESSION_REVOKED_CLOSE_CODE, reason);
    }
  }

  async reverify(
    authorization: HostAuthorizationSnapshot,
    event?: Pick<RevocationEvent, "kind" | "subject">,
  ): Promise<void> {
    if (event?.kind === "host_unlinked") {
      this.dropWhere(() => true, "host unlinked");
      return;
    }
    if (event?.kind === "device_revoked" && event.subject) {
      this.#rememberRevoked(event.subject);
      this.dropWhere((session) => session.deviceJkt === event.subject, "device revoked");
    }
    // Eventless recovery: on reconnect (or any refresh) the snapshot carries
    // the recently revoked thumbprints, so a session whose revocation event
    // we never received still dies here rather than living out its TTL.
    if (authorization.revokedDeviceJkts.length > 0) {
      const revoked = new Set(authorization.revokedDeviceJkts);
      for (const jkt of revoked) this.#rememberRevoked(jkt);
      this.dropWhere((session) => revoked.has(session.deviceJkt), "device revoked");
    }
    if (!authorization.discoverable || !authorization.ownerInOrg) {
      this.dropWhere(
        (session) => session.userId !== authorization.ownerUserId,
        "host authorization changed",
      );
    }
  }

  dropExpired(nowSeconds = Math.floor(Date.now() / 1_000)): void {
    this.dropWhere((session) => session.expiresAtSeconds <= nowSeconds, "credential expired");
  }
}

/** One registry per server process, shared by host connectivity and owner RPCs. */
export class RemoteSessionRegistryService extends ServiceMap.Service<
  RemoteSessionRegistryService,
  RemoteSessionRegistry
>()("synara/RemoteSessionRegistry") {}

export const RemoteSessionRegistryLive = Layer.sync(
  RemoteSessionRegistryService,
  () => new RemoteSessionRegistry(),
);
