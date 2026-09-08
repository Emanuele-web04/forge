import type { ComputerId } from "@synara/contracts";
import { encodeComputerFrame } from "@synara/shared/computerFrame";
import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_FRAME_RESYNC_COOLDOWN_MS,
  createComputerFrameSource,
  type WebSocketLike,
} from "./computerFrameSource";

const COMPUTER_ID = "desktop" as ComputerId;
const EXPLICIT_URL = "ws://127.0.0.1:4321";
type Listener = (event: never) => void;

function createFakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const close = vi.fn();
  const send = vi.fn();
  const socket: WebSocketLike & { emit: (type: string, event: unknown) => void } = {
    binaryType: "blob",
    close,
    send,
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit: (type, event) => {
      for (const listener of listeners.get(type) ?? []) {
        (listener as (event: unknown) => void)(event);
      }
    },
  };
  return { socket, close, send };
}

function frameBytes(sequence: number) {
  return encodeComputerFrame({
    header: {
      computerId: COMPUTER_ID,
      sequence,
      timestampMs: 1_000,
      keyframe: true,
      codecConfig: false,
    },
    payload: new Uint8Array([1, 2, 3]),
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("computer frame socket url", () => {
  it("targets the computer frame route and query parameter", () => {
    const { socket } = createFakeSocket();
    let requested = "";
    createComputerFrameSource({
      computerId: COMPUTER_ID,
      explicitUrl: EXPLICIT_URL,
      handlers: { onFrame: vi.fn(), onReset: vi.fn() },
      createSocket: (url) => {
        requested = url;
        return socket;
      },
    });
    const url = new URL(requested);
    expect(url.pathname).toBe("/ws/computer-frames");
    expect(url.searchParams.get("computerId")).toBe(COMPUTER_ID);
  });
});

describe("createComputerFrameSource", () => {
  function subscribe(options?: { now?: () => number }) {
    const { socket, close, send } = createFakeSocket();
    const onFrame = vi.fn();
    const onReset = vi.fn();
    const source = createComputerFrameSource({
      computerId: COMPUTER_ID,
      explicitUrl: EXPLICIT_URL,
      handlers: { onFrame, onReset },
      createSocket: () => socket,
      ...options,
    });
    return { socket, close, send, onFrame, onReset, source };
  }

  it("pins binary delivery and decodes PNG envelopes", () => {
    const { socket, onFrame } = subscribe();
    expect(socket.binaryType).toBe("arraybuffer");
    socket.emit("message", { data: toArrayBuffer(frameBytes(7)) });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0].header.computerId).toBe(COMPUTER_ID);
    expect(onFrame.mock.calls[0]?.[0].header.sequence).toBe(7);
    expect([...onFrame.mock.calls[0]?.[0].payload]).toEqual([1, 2, 3]);
  });

  it("ignores text and resets malformed binary envelopes", () => {
    const { socket, onFrame, onReset } = subscribe();
    socket.emit("message", { data: "not a frame" });
    socket.emit("message", { data: new ArrayBuffer(4) });

    expect(onFrame).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledWith("decode-failed");
  });

  it("reconnect-facing reset reasons and close are single-use", () => {
    const closed = subscribe();
    closed.socket.emit("close", {});
    expect(closed.onReset).toHaveBeenCalledWith("closed");

    const errored = subscribe();
    errored.socket.emit("error", {});
    expect(errored.onReset).toHaveBeenCalledWith("error");

    const source = subscribe();
    source.source.close();
    source.source.close();
    expect(source.close).toHaveBeenCalledTimes(1);
    source.socket.emit("message", { data: toArrayBuffer(frameBytes(1)) });
    expect(source.onFrame).not.toHaveBeenCalled();
  });

  it("coalesces resync requests until the cooldown expires", () => {
    let now = 0;
    const { socket, send, source } = subscribe({ now: () => now });
    socket.emit("open", {});
    expect(source.requestResync()).toBe(true);
    expect(source.requestResync()).toBe(false);
    now += COMPUTER_FRAME_RESYNC_COOLDOWN_MS;
    expect(source.requestResync()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("defers a resync until the socket opens", () => {
    const { socket, send, source } = subscribe();
    expect(source.requestResync()).toBe(false);
    socket.emit("open", {});
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "computer.frame.resync" }));
  });
});
