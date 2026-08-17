import { describe, expect, it } from "vitest";

import type { ServerConfigShape } from "./config";
import { normalizeCorsOrigin, shouldRejectUntrustedRequestOrigin } from "./trustedOrigins";

const config = {
  devUrl: new URL("http://localhost:5173/"),
} as ServerConfigShape;

describe("trusted origin duplicate-header handling", () => {
  it("accepts a single origin value represented as an array", () => {
    expect(normalizeCorsOrigin(["http://localhost:5173"])).toBe("http://localhost:5173");
  });

  it("rejects duplicate origin values instead of trusting the first", () => {
    const rawOrigin = ["http://localhost:5173", "https://example.test"];

    expect(normalizeCorsOrigin(rawOrigin)).toBeNull();
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin,
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
  });
});
