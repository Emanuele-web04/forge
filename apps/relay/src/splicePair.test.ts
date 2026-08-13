import { RELAY_CLOSE_OVERLOADED } from "@synara/relay-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSplicePair, type SpliceSocket } from "./splicePair";

class FakeSocket implements SpliceSocket {
  bufferedAmount = 0;
  paused = false;
  sent: Array<{ data: Buffer; binary: boolean }> = [];
  closes: Array<{ code: number; reason: string }> = [];
  private readonly messageListeners = new Set<(data: Buffer, binary: boolean) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private readonly drainListeners = new Set<() => void>();

  send(data: Buffer, binary: boolean): void {
    this.sent.push({ data, binary });
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  pauseReads(): void {
    this.paused = true;
  }

  resumeReads(): void {
    this.paused = false;
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  /**
   * Deliberately delivers while paused. `_socket.pause()` stops TCP reads but
   * `ws` still emits every frame it already parsed out of the chunk in hand,
   * so a fake that swallowed frames when paused would model an unreachable
   * ideal and hide exactly the drop this suite must catch.
   */
  emitMessage(data: Buffer, binary: boolean): void {
    for (const listener of this.messageListeners) listener(data, binary);
  }

  emitClose(code: number, reason = ""): void {
    for (const listener of this.closeListeners) listener(code, reason);
  }

  emitDrain(): void {
    for (const listener of this.drainListeners) listener();
  }
}

function pair(client = new FakeSocket(), host = new FakeSocket(), onClosed = vi.fn()) {
  const controller = createSplicePair({
    id: "splice",
    hostId: "host",
    client,
    host,
    highWaterBytes: 100,
    stallTimeoutMs: 1_000,
    backpressurePollMs: 10,
    onClosed,
  });
  return { client, host, onClosed, controller };
}

afterEach(() => vi.useRealTimers());

describe("4. Backpressure and opaque splice pairs", () => {
  it("forwards text and binary frames verbatim in both directions", () => {
    const { client, host } = pair();
    const text = Buffer.from("hello");
    const binary = Buffer.from([0, 255, 1, 128]);
    client.emitMessage(text, false);
    host.emitMessage(binary, true);
    expect(host.sent).toEqual([{ data: text, binary: false }]);
    expect(client.sent).toEqual([{ data: binary, binary: true }]);
  });

  it("propagates valid close codes and normalizes forbidden codes", () => {
    const first = pair();
    first.client.emitClose(4401, "revoked");
    expect(first.host.closes).toEqual([{ code: 4401, reason: "revoked" }]);
    expect(first.onClosed).toHaveBeenCalledOnce();

    const second = pair();
    second.host.emitClose(1006, "abnormal");
    expect(second.client.closes).toEqual([{ code: 1001, reason: "abnormal" }]);
    expect(second.onClosed).toHaveBeenCalledOnce();
  });

  it("pauses the producer above high water and resumes below half", () => {
    const { client, host } = pair();
    host.bufferedAmount = 101;
    client.emitMessage(Buffer.from("one"), false);
    expect(client.paused).toBe(true);

    host.bufferedAmount = 49;
    host.emitDrain();
    expect(client.paused).toBe(false);
    client.emitMessage(Buffer.from("two"), false);
    expect(host.sent).toHaveLength(2);
  });

  it("queues frames that arrive while paused instead of dropping them", () => {
    // Pausing the TCP socket does not stop `ws` from emitting frames it has
    // already parsed out of the chunk in hand. Dropping those would punch a
    // silent hole in the tunneled protocol — both peers would believe the
    // stream was delivered intact.
    const { client, host } = pair();
    host.bufferedAmount = 101;
    client.emitMessage(Buffer.from("one"), false);
    expect(client.paused).toBe(true);
    client.emitMessage(Buffer.from("in-flight-a"), false);
    client.emitMessage(Buffer.from("in-flight-b"), true);
    expect(host.sent).toHaveLength(1);

    host.bufferedAmount = 49;
    host.emitDrain();
    // Delivered, in arrival order, with text/binary fidelity preserved.
    expect(host.sent.map((frame) => frame.data.toString("utf8"))).toEqual([
      "one",
      "in-flight-a",
      "in-flight-b",
    ]);
    expect(host.sent.at(-1)?.binary).toBe(true);
    expect(client.paused).toBe(false);
  });

  it("closes rather than buffering without bound when a peer never drains", () => {
    const { client, host, onClosed } = pair();
    host.bufferedAmount = 101;
    client.emitMessage(Buffer.from("first"), false);
    // highWaterBytes is 100 in the fixture, so the queue cap is 200 bytes.
    client.emitMessage(Buffer.alloc(150), false);
    expect(client.closes).toHaveLength(0);
    client.emitMessage(Buffer.alloc(150), false);
    expect(client.closes.at(-1)?.code).toBe(RELAY_CLOSE_OVERLOADED);
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("closes both peers with 1013 after a sustained stall", async () => {
    vi.useFakeTimers();
    const { client, host, onClosed } = pair();
    host.bufferedAmount = 101;
    client.emitMessage(Buffer.from("blocked"), true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.closes.at(-1)?.code).toBe(RELAY_CLOSE_OVERLOADED);
    expect(host.closes.at(-1)?.code).toBe(RELAY_CLOSE_OVERLOADED);
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
