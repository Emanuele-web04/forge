// FILE: CapabilityEvidenceBadge.test.ts
// Purpose: Unit tests for the evidence-driven capability badge summary (KAR-530
// AC #2). The badge never fabricates confidence: a history with only `unknown`
// readings must render unknown (muted), not verified (green check).
// Layer: Chat composer presentation (pure helper)

import { describe, expect, it } from "vitest";

import { summarizeCapabilityBadge } from "./CapabilityEvidenceBadge";

describe("summarizeCapabilityBadge", () => {
  it("renders unknown for an empty history (no fabricated confidence)", () => {
    expect(summarizeCapabilityBadge([])).toBe("unknown");
  });

  it("renders unknown when every tracked state is unknown (AC4 honesty)", () => {
    expect(
      summarizeCapabilityBadge([
        { state: "unknown" },
        { state: "unknown" },
        { state: "unknown" },
      ]),
    ).toBe("unknown");
  });

  it("renders degraded when unknown and degraded states are mixed", () => {
    expect(
      summarizeCapabilityBadge([{ state: "unknown" }, { state: "degraded" }]),
    ).toBe("degraded");
  });

  it("renders verified only when a non-unknown verified state exists", () => {
    expect(summarizeCapabilityBadge([{ state: "verified" }, { state: "verified" }])).toBe(
      "verified",
    );
  });

  it("lets a broken capability dominate a mixed history", () => {
    expect(
      summarizeCapabilityBadge([{ state: "verified" }, { state: "unknown" }, { state: "broken" }]),
    ).toBe("broken");
  });

  it("lets a provisional capability dominate a mixed history", () => {
    expect(
      summarizeCapabilityBadge([
        { state: "verified" },
        { state: "unknown" },
        { state: "provisional" },
      ]),
    ).toBe("provisional");
  });

  it("renders degraded when degraded and verified states are mixed", () => {
    expect(
      summarizeCapabilityBadge([{ state: "degraded" }, { state: "verified" }]),
    ).toBe("degraded");
  });
});