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
  _socket = new FakeTransport();
  send = vi.fn((_data: Buffer, _options: { binary: boolean }, callback: (error?: Error) => void) =>
    callback(),
  );
  close = vi.fn();
}

describe("WebSocket splice adapter", () => {
  it("pauses and resumes the real transport read side", () => {
    const websocket = new FakeWebSocket();
    const socket = new WsSpliceSocket(websocket as unknown as WebSocket);
    socket.pauseReads();
    socket.resumeReads();
    expect(websocket._socket.pause).toHaveBeenCalledOnce();
    expect(websocket._socket.resume).toHaveBeenCalledOnce();
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
    websocket._socket.emit("drain");
    expect(onMessage).toHaveBeenCalledWith(payload, true);
    expect(onDrain).toHaveBeenCalledOnce();
  });
});
