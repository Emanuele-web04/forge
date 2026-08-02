import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROXY_QUEUE_BYTES,
  DEFAULT_PROXY_QUEUE_FRAMES,
  makeProxyFrameQueue,
} from "./proxyFrameQueue";

const data = (byteLength: number, payload = "d") =>
  ({ priority: "data", payload, byteLength }) as const;
const control = (payload = "ping") => ({ priority: "control", payload, byteLength: 15 }) as const;

describe("proxy frame queue flow control", () => {
  it("overflows terminally instead of dropping a frame silently", () => {
    // The core rule. A queue that dropped this frame and kept going would leave
    // the consumer applying a stream with an invisible hole in it; a queue that
    // accepted it would be a memory leak behind a slow consumer. Neither is an
    // option, so overflow is a terminal state the caller MUST surface.
    const queue = makeProxyFrameQueue<string>({ maxBytes: 100 });
    expect(queue.enqueue(data(60)).accepted).toBe(true);
    const result = queue.enqueue(data(60));
    expect(result.accepted).toBe(false);
    expect(queue.overflowed).toBe(true);
  });

  it("stays overflowed once overflowed, so a later small frame cannot mask the loss", () => {
    const queue = makeProxyFrameQueue<string>({ maxBytes: 10 });
    queue.enqueue(data(50));
    expect(queue.overflowed).toBe(true);
    // If a 1-byte frame were accepted here the caller could conclude the
    // connection recovered and skip the resync — with frames already missing.
    expect(queue.enqueue(data(1)).accepted).toBe(false);
    expect(queue.enqueue(control()).accepted).toBe(false);
  });

  it("releases the backlog on overflow so a doomed connection stops holding memory", () => {
    const queue = makeProxyFrameQueue<string>({ maxBytes: 100 });
    queue.enqueue(data(90));
    expect(queue.queuedBytes).toBe(90);
    queue.enqueue(data(90));
    // The connection is being torn down; retaining the queued frames until GC
    // notices keeps the leak this class exists to bound.
    expect(queue.queuedBytes).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("bounds by frame count as well as bytes", () => {
    // Many tiny frames cost per-frame overhead the byte counter cannot see. A
    // byte-only bound lets a flood of 1-byte frames grow the queue unboundedly
    // in every dimension that matters.
    const queue = makeProxyFrameQueue<string>({ maxBytes: 1_000_000, maxFrames: 3 });
    expect(queue.enqueue(data(1)).accepted).toBe(true);
    expect(queue.enqueue(data(1)).accepted).toBe(true);
    expect(queue.enqueue(data(1)).accepted).toBe(true);
    expect(queue.enqueue(data(1)).accepted).toBe(false);
    expect(queue.overflowed).toBe(true);
  });

  it("drains every control frame before any queued data frame", () => {
    // Head-of-line blocking: a 15-byte Pong behind a multi-MB snapshot arrives
    // after the peer's heartbeat deadline, and a healthy connection churns
    // through a reconnect. Control frames must overtake queued data.
    const queue = makeProxyFrameQueue<string>({ maxBytes: 10_000_000 });
    queue.enqueue(data(2_000_000, "snapshot-1"));
    queue.enqueue(data(2_000_000, "snapshot-2"));
    queue.enqueue(control("pong"));
    queue.enqueue(data(2_000_000, "snapshot-3"));
    queue.enqueue(control("ping"));

    expect(queue.dequeue()?.payload).toBe("pong");
    expect(queue.dequeue()?.payload).toBe("ping");
    expect(queue.dequeue()?.payload).toBe("snapshot-1");
  });

  it("never reorders data frames relative to each other", () => {
    // Data ordering is the protocol's business. A proxy that reordered it would
    // corrupt every ordered stream running over the socket.
    const queue = makeProxyFrameQueue<string>({ maxBytes: 10_000 });
    queue.enqueue(data(10, "a"));
    queue.enqueue(control("c1"));
    queue.enqueue(data(1_000, "b"));
    queue.enqueue(data(1, "c"));
    queue.dequeue(); // c1
    expect([queue.dequeue()?.payload, queue.dequeue()?.payload, queue.dequeue()?.payload]).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("counts control frames against the ceiling so they are not an unbounded queue by another name", () => {
    // Prioritised on the way out, never exempt on the way in: a peer able to
    // enqueue unlimited pings would otherwise have the memory leak back.
    const queue = makeProxyFrameQueue<string>({ maxBytes: 40 });
    expect(queue.enqueue(control()).accepted).toBe(true);
    expect(queue.enqueue(control()).accepted).toBe(true);
    expect(queue.enqueue(control()).accepted).toBe(false);
    expect(queue.overflowed).toBe(true);
  });

  it("refuses to be configured without a real ceiling", () => {
    // A caller passing 0, a negative, NaN or Infinity must not silently get an
    // unbounded queue — the exact failure mode this class prevents.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const queue = makeProxyFrameQueue<string>({ maxBytes: bad, maxFrames: bad });
      expect(queue.maxBytes, String(bad)).toBe(DEFAULT_PROXY_QUEUE_BYTES);
      expect(queue.maxFrames, String(bad)).toBe(DEFAULT_PROXY_QUEUE_FRAMES);
    }
  });

  it("keeps queuedBytes accurate across enqueue and dequeue", () => {
    // The accounting IS the bound. If dequeue failed to credit bytes back, a
    // long-lived healthy connection would drift into a spurious overflow.
    const queue = makeProxyFrameQueue<string>({ maxBytes: 1_000 });
    queue.enqueue(data(400));
    queue.enqueue(data(400));
    expect(queue.queuedBytes).toBe(800);
    queue.dequeue();
    expect(queue.queuedBytes).toBe(400);
    queue.dequeue();
    expect(queue.queuedBytes).toBe(0);
    // Still usable, not overflowed, after a full drain-and-refill cycle.
    for (let index = 0; index < 100; index += 1) {
      expect(queue.enqueue(data(400)).accepted).toBe(true);
      queue.dequeue();
    }
    expect(queue.overflowed).toBe(false);
  });
});
