import { describe, expect, it } from "vitest";

import { findLastIndexAtOrBelow } from "./diffScrollSurface";

describe("findLastIndexAtOrBelow", () => {
  const tops = [0, 120, 340, 560, 900];

  it("finds the last position at or below the threshold", () => {
    expect(findLastIndexAtOrBelow(tops.length, 0, (i) => tops[i] ?? 0)).toBe(0);
    expect(findLastIndexAtOrBelow(tops.length, 119, (i) => tops[i] ?? 0)).toBe(0);
    expect(findLastIndexAtOrBelow(tops.length, 340, (i) => tops[i] ?? 0)).toBe(2);
    expect(findLastIndexAtOrBelow(tops.length, 5000, (i) => tops[i] ?? 0)).toBe(4);
  });

  it("returns -1 when every position is below the threshold or there are none", () => {
    expect(findLastIndexAtOrBelow(tops.length, -1, (i) => tops[i] ?? 0)).toBe(-1);
    expect(findLastIndexAtOrBelow(0, 10, () => 0)).toBe(-1);
  });

  it("reads only a logarithmic number of positions", () => {
    const length = 4096;
    let reads = 0;
    const index = findLastIndexAtOrBelow(length, 2500 * 20, (i) => {
      reads += 1;
      return i * 20;
    });
    expect(index).toBe(2500);
    expect(reads).toBeLessThanOrEqual(13);
  });
});
