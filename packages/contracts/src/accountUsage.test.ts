import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { UsageMinute } from "./accountUsage";

const decodeUsageMinute = Schema.decodeUnknownSync(UsageMinute);

describe("UsageMinute", () => {
  it.each(["2026-08-11T21:34:00Z", "2026-08-11T21:34:00.000Z", "2024-02-29T00:00:00Z"])(
    "accepts the canonical minute spelling %s",
    (minute) => {
      expect(decodeUsageMinute(minute)).toBe(minute);
    },
  );

  it.each([
    ["non-zero seconds", "2026-08-11T21:34:05Z"],
    ["a missing Z", "2026-08-11T21:34:00"],
    ["non-zero milliseconds", "2026-08-11T21:34:00.500Z"],
  ])("rejects %s", (_label, minute) => {
    expect(() => decodeUsageMinute(minute)).toThrow();
  });

  // Shape alone would admit these; the calendar filter must not. An impossible
  // date that decodes becomes an Invalid Date in the service — a 500 where the
  // contract owes the caller a validation error.
  it.each([
    ["an impossible month and day", "2026-99-99T99:99:00Z"],
    ["a 13th month", "2026-13-01T00:00:00Z"],
    ["a 32nd day", "2026-01-32T00:00:00Z"],
    ["a 24th hour", "2026-01-01T24:00:00Z"],
    ["a 60th minute", "2026-01-01T12:60:00Z"],
    ["February 30th", "2026-02-30T00:00:00Z"],
    ["a leap day off a leap year", "2025-02-29T00:00:00Z"],
  ])("rejects %s despite a shape-valid spelling", (_label, minute) => {
    expect(() => decodeUsageMinute(minute)).toThrow();
  });
});
