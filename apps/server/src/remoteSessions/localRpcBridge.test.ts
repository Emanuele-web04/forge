import { EventEmitter } from "node:events";

import { Effect } from "effect";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { SessionCredentialServiceShape } from "../auth/Services/SessionCredentialService";
import type { RelaySocket } from "../relayDial";
import { bridgeRemoteSocketToLocalRpc, normalizeRelayFrame } from "./localRpcBridge";

interface FakeInternalSocket extends EventEmitter {
  readyState: number;
  /** Marks the local `/ws` connection as established. */
  accept(): void;
  /** Reproduces `ws` REPORTING a close on the internal socket. */
  reportClose(code: number, reason?: string): void;
}

const internalSockets = vi.hoisted(() => ({ created: [] as FakeInternalSocket[] }));

// The internal `/ws` socket is faked at the module boundary rather than dialled
// for real. The close codes this bridge must survive — 1005/1006/1015 and
// anything outside 1000-4999 — are ones `ws` reports LOCALLY and refuses to put
// on the wire, so no genuine peer can be made to produce them.
vi.mock("ws", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeWebSocket extends Emitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    constructor(readonly url: string) {
      super();
      internalSockets.created.push(this as unknown as FakeInternalSocket);
    }
    send(): void {}
    close(code = 1000, reason = ""): void {
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    }
    terminate(): void {
      this.readyState = 3;
    }
    accept(): void {
      this.readyState = 1;
      this.emit("open");
    }
    reportClose(code: number, reason = ""): void {
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    }
  }
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

class TestRelaySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(): void {}

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }

  override removeAllListeners(event?: "open" | "message" | "close" | "error"): this {
    return super.removeAllListeners(event);
  }
}

function stubSessions(revoked: string[] = []): SessionCredentialServiceShape {
  return {
    cookieName: "synara-test",
    issue: () =>
      Effect.succeed({
        sessionId: "session-1",
        token: "session-token",
        method: "bearer-session-token",
        client: { label: "remote", deviceType: "unknown" },
        expiresAt: {} as never,
        role: "client" as const,
      }),
    issueWebSocketToken: () => Effect.succeed({ token: "ws-token", expiresAt: {} as never }),
    revoke: (sessionId: string) =>
      Effect.sync(() => {
        revoked.push(sessionId);
        return true;
      }),
  } as unknown as SessionCredentialServiceShape;
}

/** A fully established bridge, with a handle on each end of it. */
async function establishedBridge(): Promise<{
  external: TestRelaySocket;
  internal: FakeInternalSocket;
}> {
  internalSockets.created.length = 0;
  const external = new TestRelaySocket();
  const bridge = bridgeRemoteSocketToLocalRpc(
    external as unknown as RelaySocket,
    { userId: "user-1", expiresAtSeconds: Math.floor(Date.now() / 1_000) + 60 },
    { listeningPort: 1, sessions: stubSessions() },
  );
  const internal = await vi.waitFor(() => {
    const socket = internalSockets.created[0];
    if (!socket) throw new Error("internal socket was not created");
    return socket;
  });
  internal.accept();
  await bridge;
  return { external, internal };
}

describe("normalizeRelayFrame", () => {
  it("preserves text and binary frame kinds and bytes", () => {
    expect(normalizeRelayFrame(Buffer.from("text-frame"), false)).toBe("text-frame");
    const binary = Buffer.from([0, 255, 1, 127]);
    expect(normalizeRelayFrame(binary, true)).toEqual(binary);
  });
});

describe("bridgeRemoteSocketToLocalRpc", () => {
  it("revokes a session issued after the remote peer drops during setup", async () => {
    let finishTokenIssue: (() => void) | undefined;
    let tokenIssueStarted: (() => void) | undefined;
    const tokenStarted = new Promise<void>((resolve) => {
      tokenIssueStarted = resolve;
    });
    const tokenIssued = new Promise<void>((resolve) => {
      finishTokenIssue = resolve;
    });
    const revoked: string[] = [];
    const sessions = {
      ...stubSessions(revoked),
      issueWebSocketToken: () =>
        Effect.promise(async () => {
          tokenIssueStarted?.();
          await tokenIssued;
          return { token: "ws-token", expiresAt: {} as never };
        }),
    } as unknown as SessionCredentialServiceShape;
    const external = new TestRelaySocket();

    const bridge = bridgeRemoteSocketToLocalRpc(
      external as unknown as RelaySocket,
      { userId: "user-1", expiresAtSeconds: Math.floor(Date.now() / 1_000) + 60 },
      { listeningPort: 1, sessions },
    );
    await tokenStarted;
    external.close(1001, "peer left");
    finishTokenIssue?.();

    await expect(bridge).rejects.toThrow("remote peer closed during local RPC setup");
    expect(revoked).toEqual(["session-1"]);
  });

  // `ws` throws SYNCHRONOUSLY when one of these reserved codes is handed to
  // close(). Raised from inside a close listener, with no uncaughtException
  // handler in this process, it takes the whole host down — and 1006 is the
  // ordinary code for any TCP reset or relay restart.
  it.each([
    ["1005 (no status received)", 1005],
    ["1006 (abnormal closure)", 1006],
    ["1015 (TLS handshake failure)", 1015],
  ])("substitutes 1001 for locally-reported %s", async (_label, reported) => {
    const { external, internal } = await establishedBridge();

    internal.reportClose(reported, "internal gone");

    expect(external.closes).toEqual([{ code: 1001, reason: "internal gone" }]);
  });

  // Anything outside 1000-4999 is illegal on the wire, so close() rejects it
  // just as loudly as the reserved codes above.
  it.each([
    ["0", 0],
    ["999", 999],
    ["5000", 5000],
  ])("substitutes 1001 for out-of-range close code %s", async (_label, reported) => {
    const { external, internal } = await establishedBridge();

    internal.reportClose(reported);

    expect(external.closes).toEqual([{ code: 1001, reason: "" }]);
  });

  it.each([
    ["1000 (normal closure)", 1000],
    ["4503 (host session revoked)", 4503],
  ])("forwards legal close code %s unchanged", async (_label, code) => {
    const { external, internal } = await establishedBridge();

    internal.reportClose(code, "bye");

    expect(external.closes).toEqual([{ code, reason: "bye" }]);
  });
});
