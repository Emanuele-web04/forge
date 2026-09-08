import type { ApiJwks } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { ApiJwksCache } from "./apiJwksCache";

const jwks = { keys: [] } as unknown as ApiJwks;

describe("ApiJwksCache", () => {
  it("requires cloud on first contact and retains last-known-good keys afterwards", async () => {
    let online = false;
    let now = 0;
    const cache = new ApiJwksCache(
      async () => {
        if (!online) throw new Error("offline");
        return jwks;
      },
      { refreshAfterMs: 1, nowMs: () => now },
    );
    await expect(cache.get()).rejects.toThrow("offline");
    online = true;
    expect(await cache.get()).toBe(jwks);
    online = false;
    now = 2;
    expect(await cache.get()).toBe(jwks);
  });
});
