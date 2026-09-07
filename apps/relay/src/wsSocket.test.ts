import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { WsSpliceSocket } from "./wsSocket";

class FakeTransport extends EventEmitter {
  pause = vi.fn();
  resume = vi.fn();
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  _socket: FakeTransport | undefined = new FakeTransport();
  send = vi.fn((_data: Buffer, _options: { binary: boolean }, callback: (error?: Error) => void) =>
    callback(),
  );
  close = vi.fn();
}

/** The shape Bun's `ws` shim presents: a WebSocket with no transport handle. */
function bunShapedWebSocket(): FakeWebSocket {
  const websocket = new FakeWebSocket();
  websocket._socket = undefined;
  return websocket;
}

describe("WebSocket splice adapter", () => {
  it("pauses and resumes the real transport read side", () => {
    const websocket = new FakeWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    socket.pauseReads();
    socket.resumeReads();
    expect(websocket._socket?.pause).toHaveBeenCalledOnce();
    expect(websocket._socket?.resume).toHaveBeenCalledOnce();
  });

  it("preserves frame bytes and binary flags and surfaces drain", () => {
    const websocket = new FakeWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    const onMessage = vi.fn();
    const onDrain = vi.fn();
    socket.onMessage(onMessage);
    socket.onDrain(onDrain);
    const payload = Buffer.from([0, 255, 1]);
    websocket.emit("message", payload, true);
    websocket._socket?.emit("drain");
    expect(onMessage).toHaveBeenCalledWith(payload, true);
    expect(onDrain).toHaveBeenCalledOnce();
  });

  it("holds frames that arrive while paused with no listener and replays them in order", () => {
    // Bun's shim cannot pause the transport, so frames keep arriving. A
    // client's mint request lands between admission and pairing; without
    // holding it here the host never sees it and the session hangs.
    const websocket = bunShapedWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    socket.pauseReads();
    websocket.emit("message", Buffer.from("first"), false);
    websocket.emit("message", Buffer.from([1, 2, 3]), true);

    const onMessage = vi.fn();
    socket.onMessage(onMessage);
    expect(onMessage.mock.calls).toEqual([
      [Buffer.from("first"), false],
      [Buffer.from([1, 2, 3]), true],
    ]);

    // Once listened, delivery is direct — nothing is held or duplicated.
    websocket.emit("message", Buffer.from("live"), false);
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[2]).toEqual([Buffer.from("live"), false]);
  });

  it("does not hold frames when reads are not paused", () => {
    // Unpaused and unlistened is the ordinary EventEmitter contract: the
    // frame is dropped, as it would be on Node. Holding here would grow
    // without bound on a control socket nobody has claimed yet.
    const websocket = bunShapedWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    websocket.emit("message", Buffer.from("orphan"), false);
    const onMessage = vi.fn();
    socket.onMessage(onMessage);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("refuses a peer that floods before it is spliced instead of buffering without bound", () => {
    const websocket = bunShapedWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    socket.pauseReads();
    websocket.emit("message", Buffer.alloc(48 * 1024), true);
    expect(websocket.close).not.toHaveBeenCalled();
    websocket.emit("message", Buffer.alloc(32 * 1024), true);
    expect(websocket.close).toHaveBeenCalledWith(
      1008,
      "relay peer sent too much before it was spliced",
    );
  });

  it("delivers to every listener while listened, and only replays to the first", () => {
    const websocket = bunShapedWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    socket.pauseReads();
    websocket.emit("message", Buffer.from("held"), false);
    const first = vi.fn();
    const second = vi.fn();
    socket.onMessage(first);
    socket.onMessage(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    websocket.emit("message", Buffer.from("live"), false);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops delivering to a removed listener", () => {
    const websocket = new FakeWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    const onMessage = vi.fn();
    const remove = socket.onMessage(onMessage);
    remove();
    websocket.emit("message", Buffer.from("after"), false);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
