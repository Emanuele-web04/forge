import type { HostAuthorizationSnapshot, RevocationEvent } from "@synara/contracts";

export interface RemoteSession {
  readonly id: string;
  readonly userId: string;
  readonly deviceJkt: string;
  readonly expiresAtSeconds: number;
  readonly via: "direct" | "relay" | "ssh-forward";
  readonly close: (code: number, reason: string) => void;
}

export const REMOTE_SESSION_REVOKED_CLOSE_CODE = 4403;

export class RemoteSessionRegistry {
  readonly #sessions = new Map<string, RemoteSession>();

  add(session: RemoteSession): () => void {
    this.#sessions.set(session.id, session);
    return () => this.#sessions.delete(session.id);
  }

  get size(): number {
    return this.#sessions.size;
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
      this.dropWhere((session) => session.deviceJkt === event.subject, "device revoked");
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
