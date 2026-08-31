// FILE: providerUsage/http.retryAfter.test.ts
// Purpose: Verifies strict Retry-After delta-seconds and HTTP-date parsing.

import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "./http.ts";

function retryAfterHeaders(value: string): Headers {
  return new Headers({ "Retry-After": value });
}

describe("parseRetryAfterMs", () => {
  it("parses digit-only delta seconds and HTTP dates", () => {
    expect(parseRetryAfterMs(retryAfterHeaders(" 120 "), 0)).toBe(120_000);

    const nowMs = Date.parse("2026-10-21T07:27:00.000Z");
    const retryAt = new Date(nowMs + 60_000).toUTCString();
    expect(parseRetryAfterMs(retryAfterHeaders(retryAt), nowMs)).toBe(60_000);
  });

  it.each(["1e3", "0x10", "1.5", "+10", "-10"])(
    "rejects non-HTTP numeric spelling %s",
    (value) => {
      expect(parseRetryAfterMs(retryAfterHeaders(value), 0)).toBeUndefined();
    },
  );

  it("rejects zero and unsafe delta values", () => {
    expect(parseRetryAfterMs(retryAfterHeaders("0"), 0)).toBeUndefined();
    expect(
      parseRetryAfterMs(retryAfterHeaders(String(Number.MAX_SAFE_INTEGER)), 0),
    ).toBeUndefined();
  });
});
