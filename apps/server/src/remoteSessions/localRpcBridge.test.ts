import { describe, expect, it } from "vitest";

import { normalizeRelayFrame } from "./localRpcBridge";

describe("normalizeRelayFrame", () => {
  it("preserves text and binary frame kinds and bytes", () => {
    expect(normalizeRelayFrame(Buffer.from("text-frame"), false)).toBe("text-frame");
    const binary = Buffer.from([0, 255, 1, 127]);
    expect(normalizeRelayFrame(binary, true)).toEqual(binary);
  });
});
