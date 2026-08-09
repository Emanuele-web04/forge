import type { DeviceUdid } from "@synara/contracts";
import { encodeDeviceFrame } from "@synara/shared/deviceFrame";
import { describe, expect, it, vi } from "vitest";

import {
  createDeviceFrameSource,
  deviceFrameSocketUrl,
  type WebSocketLike,
} from "./deviceFrameSource";

const UDID = "AAAA-BBBB" as DeviceUdid;
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

function frameBytes(overrides: {
  sequence: number;
  keyframe?: boolean;
  codecConfig?: boolean;
  payload?: Uint8Array;
}) {
  return encodeDeviceFrame({
    header: {
      deviceId: UDID,
      sequence: overrides.sequence,
      timestampMs: 1_000,
      keyframe: overrides.keyframe ?? false,
      codecConfig: overrides.codecConfig ?? false,
    },
    payload: overrides.payload ?? new Uint8Array([1, 2, 3]),
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("deviceFrameSocketUrl", () => {
  it("targets the shared frame path with the device in the query", () => {
    const url = new URL(deviceFrameSocketUrl({ udid: UDID, explicitUrl: EXPLICIT_URL }));

    expect(url.pathname).toBe("/ws/device-frames");
    expect(url.searchParams.get("udid")).toBe(UDID);
  });
});

describe("createDeviceFrameSource", () => {
  function subscribe(options?: { now?: () => number; resyncCooldownMs?: number }) {
    const { socket, close, send } = createFakeSocket();
    const onFrame = vi.fn();
    const onReset = vi.fn();
    const source = createDeviceFrameSource({
      udid: UDID,
      explicitUrl: EXPLICIT_URL,
      handlers: { onFrame, onReset },
      createSocket: () => socket,
      ...options,
    });
    return { socket, close, send, onFrame, onReset, source };
  }

  it("pins the socket to arraybuffer so frames arrive in order", () => {
    // Blob delivery is async and would reorder frames against the sync path.
    const { socket } = subscribe();
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("decodes a binary message into a frame", () => {
    const { socket, onFrame } = subscribe();

    socket.emit("message", {
      data: toArrayBuffer(frameBytes({ sequence: 7, keyframe: true })),
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    const frame = onFrame.mock.calls[0]?.[0];
    expect(frame.header.deviceId).toBe(UDID);
    expect(frame.header.sequence).toBe(7);
    expect(frame.header.keyframe).toBe(true);
    expect([...frame.payload]).toEqual([1, 2, 3]);
  });

  it("ignores text messages instead of tearing the stream down", () => {
    // A stray server log line must not kill a healthy video stream.
    const { socket, onFrame, onReset } = subscribe();

    socket.emit("message", { data: "not a frame" });

    expect(onFrame).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("resets when a malformed envelope arrives", () => {
    const { socket, onFrame, onReset } = subscribe();

    socket.emit("message", { data: new ArrayBuffer(4) });

    expect(onFrame).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledWith("decode-failed");
  });

  it("reports close and error separately so the pane can distinguish them", () => {
    const closed = subscribe();
    closed.socket.emit("close", {});
    expect(closed.onReset).toHaveBeenCalledWith("closed");

    const errored = subscribe();
    errored.socket.emit("error", {});
    expect(errored.onReset).toHaveBeenCalledWith("error");
  });

  it("stops delivering after close, and closes the socket exactly once", () => {
    const { socket, close, onFrame, onReset, source } = subscribe();

    source.close();
    source.close();
    expect(close).toHaveBeenCalledTimes(1);

    socket.emit("message", { data: toArrayBuffer(frameBytes({ sequence: 1 })) });
    socket.emit("close", {});

    expect(onFrame).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("accepts a typed-array payload as well as a raw ArrayBuffer", () => {
    const { socket, onFrame } = subscribe();

    socket.emit("message", { data: frameBytes({ sequence: 3, codecConfig: true }) });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0].header.codecConfig).toBe(true);
  });
});

describe("resync requests", () => {
  function subscribeWithClock(startMs: number) {
    const { socket, close, send } = createFakeSocket();
    let clock = startMs;
    const source = createDeviceFrameSource({
      udid: UDID,
      explicitUrl: EXPLICIT_URL,
      handlers: { onFrame: vi.fn(), onReset: vi.fn() },
      createSocket: () => socket,
      now: () => clock,
      resyncCooldownMs: 1_000,
    });
    return { socket, close, send, source, advance: (ms: number) => (clock += ms) };
  }

  it("sends the shared resync message once the socket is open", () => {
    const { socket, send, source } = subscribeWithClock(0);
    socket.emit("open", {});

    expect(source.requestResync()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      type: "device.frame.resync",
    });
  });

  it("debounces repeat requests inside the cooldown", () => {
    // Resync rebuilds the VideoToolbox session; a gate firing on every dropped
    // frame must not thrash the encoder.
    const { socket, send, source, advance } = subscribeWithClock(0);
    socket.emit("open", {});

    expect(source.requestResync()).toBe(true);
    expect(source.requestResync()).toBe(false);
    advance(999);
    expect(source.requestResync()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    advance(1);
    expect(source.requestResync()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("defers a request made before the socket opens instead of dropping it", () => {
    // A gap can be detected on the first frames of a fresh connection; dropping
    // the request would strand the canvas until the next natural IDR.
    const { socket, send, source } = subscribeWithClock(0);

    expect(source.requestResync()).toBe(false);
    expect(send).not.toHaveBeenCalled();

    socket.emit("open", {});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends only one deferred request no matter how many were coalesced", () => {
    const { socket, send, source, advance } = subscribeWithClock(0);

    source.requestResync();
    advance(5_000);
    source.requestResync();
    socket.emit("open", {});

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses to send after close", () => {
    const { socket, send, source } = subscribeWithClock(0);
    socket.emit("open", {});
    source.close();

    expect(source.requestResync()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports failure rather than throwing when the socket rejects the send", () => {
    const { socket, send, source } = subscribeWithClock(0);
    socket.emit("open", {});
    send.mockImplementation(() => {
      throw new Error("socket closed");
    });

    expect(source.requestResync()).toBe(false);
  });
});
