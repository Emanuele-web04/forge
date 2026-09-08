import { describe, expect, it } from "vitest";

import { GrantReplayCache } from "./grantReplayCache";

describe("grant jti single-use cache", () => {
  it("atomically consumes a jti once through its expiry tolerance", () => {
    let now = 100_000;
    const cache = new GrantReplayCache(() => now);
    expect(cache.consume("grant-1", 110)).toBe(true);
    expect(cache.consume("grant-1", 110)).toBe(false);
    now = 169_999;
    expect(cache.consume("grant-1", 110)).toBe(false);
    now = 170_000;
    expect(cache.consume("grant-1", 200)).toBe(true);
  });

  it("sweeps expired entries opportunistically", () => {
    let now = 100_000;
    const cache = new GrantReplayCache(() => now);
    cache.consume("grant-1", 101);
    cache.consume("grant-2", 102);
    expect(cache.size).toBe(2);
    now = 162_000;
    cache.consume("grant-3", 200);
    expect(cache.size).toBe(1);
  });
});
