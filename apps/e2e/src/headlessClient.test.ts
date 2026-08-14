import { describe, expect, it } from "vitest";

import { makeRpcRequestIdGenerator } from "./headlessClient";

describe("headless RPC request IDs", () => {
  it("generates unique decimal strings accepted by Effect RPC's bigint IDs", () => {
    const nextRequestId = makeRpcRequestIdGenerator();
    const first = nextRequestId();
    const second = nextRequestId();

    expect(first).toMatch(/^\d+$/);
    expect(second).toMatch(/^\d+$/);
    expect(second).not.toBe(first);
    expect(() => BigInt(first)).not.toThrow();
    expect(() => BigInt(second)).not.toThrow();
  });
});
