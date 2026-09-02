import { describe, expect, it } from "vitest";
import {
  confirmedWeight,
  effectiveWeight,
  rankCandidates,
  rankScore,
  shouldPrune,
} from "./scoring";

const row = (overrides = {}) => ({
  memoryId: "b",
  type: "semantic" as const,
  peakWeight: 1,
  accessCount: 0,
  pinned: false,
  lastAccessedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
const now = "2026-01-08T00:00:00.000Z";

describe("Mind scoring", () => {
  it("matches approved stability factors and remains bounded", () => {
    expect(effectiveWeight(row(), "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(effectiveWeight(row(), now)).toBeCloseTo(Math.exp(-7 / 3));
    expect(effectiveWeight(row({ type: "decision", accessCount: 2 }), now)).toBeCloseTo(
      Math.exp(-7 / 62),
    );
    expect(confirmedWeight(0.9)).toBe(1);
    expect(rankScore(-2, 0)).toBe(-0.7);
  });
  it("uses memory ID as the final deterministic tie-break", () => {
    expect(
      rankCandidates(
        [
          { memory: row({ memoryId: "b" }), bm25: -1 },
          { memory: row({ memoryId: "a" }), bm25: -1 },
        ],
        now,
      ).map((x) => x.memory.memoryId),
    ).toEqual(["a", "b"]);
  });
  it("returns zero weight for invalid dates instead of NaN", () => {
    expect(effectiveWeight(row({ lastAccessedAt: "not-a-date" }), now)).toBe(0);
    expect(effectiveWeight(row(), "not-a-date")).toBe(0);
  });
  it("prunes only the approved conjunction and never pinned rows", () => {
    const stale = row({ peakWeight: 0.001, lastAccessedAt: "2025-01-01T00:00:00.000Z" });
    expect(shouldPrune(stale, now)).toBe(true);
    expect(shouldPrune({ ...stale, accessCount: 2 }, now)).toBe(false);
    expect(shouldPrune({ ...stale, pinned: true }, now)).toBe(false);
  });
});
