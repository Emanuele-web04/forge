import { describe, expect, it } from "vitest";

import { isMindSecret } from "./secretPatterns.ts";

describe("isMindSecret", () => {
  it("rejects the same credential text on consecutive calls", () => {
    const secret = "deploy with api_key=supersecret12345678 tonight";
    expect(isMindSecret(secret)).toBe(true);
    expect(isMindSecret(secret)).toBe(true);
    expect(isMindSecret(secret)).toBe(true);
  });

  it("rejects token-prefixed secrets consistently", () => {
    const secret = "rotated ghp-abcdefgh12345678 yesterday";
    for (let i = 0; i < 4; i += 1) {
      expect(isMindSecret(secret)).toBe(true);
    }
  });

  it("accepts ordinary text", () => {
    expect(isMindSecret("friday deploy checklist")).toBe(false);
  });
});
