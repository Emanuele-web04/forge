import { describe, expect, it } from "vitest";

import { COMPUTER_FRAME_RESYNC_MESSAGE } from "@synara/shared/computerFrame";

import { decodeResyncRequest, makeComputerFrameSink } from "./computerFrameRoute.ts";

describe("computer frame socket messages", () => {
  it("recognizes text and binary resync messages", () => {
    const message = JSON.stringify({ type: COMPUTER_FRAME_RESYNC_MESSAGE });
    expect(decodeResyncRequest(message)).toBe("resync");
    expect(decodeResyncRequest(new TextEncoder().encode(message))).toBe("resync");
  });

  it("ignores malformed, unrelated, and oversized messages", () => {
    expect(decodeResyncRequest("not json")).toBeNull();
    expect(decodeResyncRequest(JSON.stringify({ type: "other" }))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(["resync"]))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(null))).toBeNull();
    expect(
      decodeResyncRequest(
        JSON.stringify({ type: COMPUTER_FRAME_RESYNC_MESSAGE, x: "x".repeat(2_000) }),
      ),
    ).toBeNull();
  });
});

describe("computer frame socket sink", () => {
  it("accounts for bytes until a write settles", async () => {
    let settle: (() => void) | undefined;
    const sink = makeComputerFrameSink({
      send: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      isOpen: () => true,
    });
    sink.send(new Uint8Array(128));
    expect(sink.bufferedAmount()).toBe(128);
    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("clears the backlog when a write fails", async () => {
    const sink = makeComputerFrameSink({
      send: () => Promise.reject(new Error("socket gone")),
      isOpen: () => true,
    });
    sink.send(new Uint8Array(64));
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.bufferedAmount()).toBe(0);
  });

  it("reports a closed connection to the shared transport", () => {
    let open = true;
    const sink = makeComputerFrameSink({ send: () => undefined, isOpen: () => open });
    expect(sink.isOpen()).toBe(true);
    open = false;
    expect(sink.isOpen()).toBe(false);
  });
});
