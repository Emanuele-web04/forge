import { describe, expect, it } from "vitest";

import { DEVICE_FRAME_RESYNC_MESSAGE } from "@synara/shared/deviceFrame";

import { decodeResyncRequest, makeDeviceFrameSink } from "./deviceFrameRoute.ts";

describe("frame socket client messages", () => {
  it("recognizes a resync request in either text or binary framing", () => {
    const message = JSON.stringify({ type: DEVICE_FRAME_RESYNC_MESSAGE });

    expect(decodeResyncRequest(message)).toBe("resync");
    expect(decodeResyncRequest(new TextEncoder().encode(message))).toBe("resync");
  });

  it("ignores anything that is not a resync request rather than erroring", () => {
    // A stray log line or a future message type must never kill a stream.
    expect(decodeResyncRequest("hello")).toBeNull();
    expect(decodeResyncRequest("{ not json")).toBeNull();
    expect(decodeResyncRequest(JSON.stringify({ type: "something.else" }))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(["resync"]))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(null))).toBeNull();
  });

  it("refuses an oversized message without parsing it", () => {
    const oversized = JSON.stringify({
      type: DEVICE_FRAME_RESYNC_MESSAGE,
      padding: "x".repeat(4_096),
    });

    expect(decodeResyncRequest(oversized)).toBeNull();
  });
});

describe("frame socket sink", () => {
  it("counts bytes handed to the socket until the write settles", async () => {
    let settle: (() => void) | undefined;
    const sink = makeDeviceFrameSink({
      send: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      isOpen: () => true,
    });

    sink.send(new Uint8Array(500));

    // The transport reads this to decide whether the client is keeping up.
    expect(sink.bufferedAmount()).toBe(500);
    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("clears the backlog even when a write fails", async () => {
    const sink = makeDeviceFrameSink({
      send: () => Promise.reject(new Error("socket gone")),
      isOpen: () => true,
    });

    sink.send(new Uint8Array(64));
    await Promise.resolve();
    await Promise.resolve();

    // A rejected write must not leave phantom bytes that permanently mark the
    // subscriber as slow.
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("reports a closed connection so the transport drops the subscriber", () => {
    let open = true;
    const sink = makeDeviceFrameSink({ send: () => undefined, isOpen: () => open });

    expect(sink.isOpen()).toBe(true);
    open = false;
    expect(sink.isOpen()).toBe(false);
  });
});
