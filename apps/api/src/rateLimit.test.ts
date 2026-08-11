import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit";

describe("createRateLimiter", () => {
  it("allows up to the limit and then refuses", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => 1_000 });

    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 1_000 });

    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(true);
  });

  it("slides: hits older than the window stop counting", () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => clock });

    expect(limiter.tryConsume("a")).toBe(true);
    clock = 500;
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);

    // The first hit has aged out; the second (at 500) has not.
    clock = 1_100;
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);

    clock = 2_200;
    expect(limiter.tryConsume("a")).toBe(true);
  });

  // The prune is amortized: limiting stays correct while a large expired
  // burst is reclaimed piecemeal by the requests that follow it, and a key
  // deleted mid-pass that comes back is limited afresh.
  it("keeps limiting correct while an expired burst is reclaimed incrementally", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => clock,
      pruneThreshold: 4,
    });

    for (let i = 0; i < 100; i += 1) {
      expect(limiter.tryConsume(`burst-${i}`)).toBe(true);
    }
    clock = 5_000;
    expect(limiter.tryConsume("live")).toBe(true);
    expect(limiter.tryConsume("live")).toBe(true);
    expect(limiter.tryConsume("live")).toBe(false);

    // Burst keys aged out: each is allowed again, and re-limited, regardless
    // of whether the incremental prune has reached it yet.
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.tryConsume(`burst-${i}`)).toBe(true);
    }
    expect(limiter.tryConsume("live")).toBe(false);
  });

  // A burst of single-use keys must not retain their entries forever.
  it("prunes keys that have fallen out of the window", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 1_000,
      now: () => clock,
      pruneThreshold: 4,
    });

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.tryConsume(`key-${i}`)).toBe(true);
    }
    clock = 5_000;
    // Past the window, every prior key is allowed again — the sweep dropping
    // entries must not resurrect or lose a live one.
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.tryConsume(`key-${i}`)).toBe(true);
      expect(limiter.tryConsume(`key-${i}`)).toBe(false);
    }
  });
});
