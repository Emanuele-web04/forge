import { describe, expect, it } from "vitest";

import {
  generateCortexApiToken,
  isCortexApiTokenScope,
  matchesCortexApiTokenHash,
  validateCortexApiTokenScopes,
} from "./apiTokens";

describe("CORTEX API token primitives", () => {
  it("generates a CSPRNG-backed token with no persisted raw-secret field", () => {
    const token = generateCortexApiToken();
    expect(token.secret).toMatch(/^ctx_live_[A-Za-z0-9_-]{43}$/u);
    expect(token.prefix).toBe(token.secret.slice(0, "ctx_live_".length + 8));
    expect(token.hash).toHaveLength(32);
    expect(Object.keys(token)).not.toContain("rawToken");
  });

  it("matches only the original secret", () => {
    const token = generateCortexApiToken();
    expect(matchesCortexApiTokenHash(token.secret, token.hash)).toBe(true);
    expect(matchesCortexApiTokenHash(`${token.secret}x`, token.hash)).toBe(false);
  });

  it("requires a non-empty, known, deduplicated scope set", () => {
    expect(validateCortexApiTokenScopes(["projects.read", "projects.read"])).toEqual([
      "projects.read",
    ]);
    expect(() => validateCortexApiTokenScopes([])).toThrow("At least one");
    expect(() => validateCortexApiTokenScopes(["admin"])).toThrow("unsupported");
    expect(isCortexApiTokenScope("cortex.ai.invoke")).toBe(true);
    expect(isCortexApiTokenScope("admin")).toBe(false);
  });
});
