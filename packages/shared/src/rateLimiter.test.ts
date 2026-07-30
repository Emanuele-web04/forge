import { describe, expect, it } from "vitest";

import { makeTokenBucketLimiter } from "./rateLimiter";

describe("makeTokenBucketLimiter", () => {
  it("allows a burst up to capacity and then refuses", () => {
    let now = 0;
    const limiter = makeTokenBucketLimiter({
      capacity: 3,
      refillPerSecond: 1,
      now: () => now,
    });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")].map((d) => d.allowed)).toEqual(
      [true, true, true],
    );
    const refused = limiter.take("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    let now = 0;
    const limiter = makeTokenBucketLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
    limiter.take("a");
    limiter.take("a");
    expect(limiter.take("a").allowed).toBe(false);
    now = 1_000;
    expect(limiter.take("a").allowed).toBe(true);
  });

  it("does not let hammering starve the bucket forever", () => {
    // A naive implementation resets `updatedAt` on a refused call and drops the
    // partial refill, so a caller retrying in a tight loop never recovers.
    let now = 0;
    const limiter = makeTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
    expect(limiter.take("a").allowed).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      now += 40;
      limiter.take("a");
    }
    now += 300;
    expect(limiter.take("a").allowed).toBe(true);
  });

  it("keys buckets independently", () => {
    let now = 0;
    const limiter = makeTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("b").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
  });

  it("evicts idle buckets so the map cannot grow without bound", () => {
    let now = 0;
    const limiter = makeTokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: () => now,
      idleEvictionMs: 1_000,
    });
    for (let index = 0; index < 50; index += 1) limiter.take(`key-${index}`);
    expect(limiter.size()).toBe(50);
    now = 5_000;
    limiter.take("fresh");
    expect(limiter.size()).toBe(1);
  });
});
