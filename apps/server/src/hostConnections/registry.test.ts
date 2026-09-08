// The registry bridges a renderer socket onto a dialed session: frames flow
// both ways untouched, closes propagate with their code, and a second window
// is refused while the first holds the attachment.
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import type WebSocket from "ws";

import type { RelaySocket } from "../relayDial";
import type { DialedSession } from "./dialer";
import { HostConnectionRegistry } from "./registry";

class FakeRemote extends EventEmitter {
  readyState = 1;
  readonly sent: Array<{ data: string | Buffer; binary: boolean }> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  send(data: string | Buffer, options: { binary?: boolean }): void {
    this.sent.push({ data, binary: options.binary === true });
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }
}

class FakeLocal extends EventEmitter implements RelaySocket {
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }
}

function session(remote: FakeRemote): DialedSession {
  return {
    socket: remote as unknown as WebSocket,
    transport: "relay",
    credential: "cred",
    credentialExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3600,
    race: { outcome: "reachable", candidate: { kind: "relay", url: "x" }, attempts: [] },
  };
}

describe("HostConnectionRegistry", () => {
  it("projects a connection with the bridge path and lists it", () => {
    const registry = new HostConnectionRegistry();
    const remote = new FakeRemote();
    const connection = registry.add({
      hostId: "host_1",
      hostName: "Ada",
      session: session(remote),
    });
    expect(connection).toMatchObject({
      hostId: "host_1",
      hostName: "Ada",
      transport: "relay",
      wsPath: "/ws/remote/host_1",
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("host_1")?.hostId).toBe("host_1");
  });

  it("forwards frames both ways preserving text/binary and closes local with the remote's code", () => {
    const registry = new HostConnectionRegistry();
    const remote = new FakeRemote();
    registry.add({ hostId: "host_1", hostName: "Ada", session: session(remote) });
    const local = new FakeLocal();
    expect(registry.attach("host_1", local)).toBe(true);

    local.emit("message", Buffer.from("to-host"), false);
    local.emit("message", Buffer.from([1, 2, 3]), true);
    expect(remote.sent).toEqual([
      { data: "to-host", binary: false },
      { data: Buffer.from([1, 2, 3]), binary: true },
    ]);

    remote.emit("message", Buffer.from("from-host"), false);
    remote.emit("message", Buffer.from([9]), true);
    expect(local.sent).toEqual(["from-host", Buffer.from([9])]);

    remote.close(4503, "device revoked");
    expect(local.closes).toEqual([{ code: 4503, reason: "device revoked" }]);
    expect(registry.get("host_1")).toBeUndefined();
  });

  it("refuses a second attachment and keeps the session when the renderer detaches", () => {
    const registry = new HostConnectionRegistry();
    const remote = new FakeRemote();
    registry.add({ hostId: "host_1", hostName: "Ada", session: session(remote) });
    const first = new FakeLocal();
    const second = new FakeLocal();
    expect(registry.attach("host_1", first)).toBe(true);
    expect(registry.attach("host_1", second)).toBe(false);
    expect(second.closes).toEqual([
      { code: 4409, reason: "another window already holds this connection" },
    ]);

    first.close(1000, "window closed");
    expect(remote.closes).toEqual([]);
    expect(registry.get("host_1")).toBeDefined();
    // The slot is free again.
    const third = new FakeLocal();
    expect(registry.attach("host_1", third)).toBe(true);
  });

  it("remove closes the dialed socket and an attached renderer", () => {
    const registry = new HostConnectionRegistry();
    const remote = new FakeRemote();
    registry.add({ hostId: "host_1", hostName: "Ada", session: session(remote) });
    const local = new FakeLocal();
    registry.attach("host_1", local);
    expect(registry.remove("host_1")).toBe(true);
    expect(remote.closes).toEqual([{ code: 1000, reason: "disconnected" }]);
    expect(registry.list()).toEqual([]);
    expect(registry.remove("host_1")).toBe(false);
  });

  it("refuses attachment to an unknown host with 4404", () => {
    const registry = new HostConnectionRegistry();
    const local = new FakeLocal();
    expect(registry.attach("nope", local)).toBe(false);
    expect(local.closes[0]?.code).toBe(4404);
  });
});
