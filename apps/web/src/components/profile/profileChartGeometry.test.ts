// FILE: profileChartGeometry.test.ts
// Purpose: Unit coverage for profile donut / sparkline geometry helpers.
// Layer: web profile feature tests.

import { describe, expect, it } from "vitest";
import {
  clampPercent,
  donutSegmentPath,
  layoutDonutSegments,
  normalizeSparklineHeights,
  polarToCartesian,
} from "./profileChartGeometry";

describe("polarToCartesian", () => {
  it("places 0° at 12 o'clock", () => {
    const point = polarToCartesian(0, 0, 10, 0);
    expect(point.x).toBeCloseTo(0, 5);
    expect(point.y).toBeCloseTo(-10, 5);
  });
});

describe("donutSegmentPath", () => {
  it("returns null for zero sweep", () => {
    expect(donutSegmentPath(50, 50, 20, 40, 10, 10)).toBeNull();
  });

  it("emits a closed path for a partial sector", () => {
    const path = donutSegmentPath(50, 50, 20, 40, 0, 90);
    expect(path).toMatch(/^M /);
    expect(path).toContain("A 40 40");
    expect(path).toContain("A 20 20");
    expect(path?.endsWith("Z")).toBe(true);
  });
});

describe("layoutDonutSegments", () => {
  it("lays out proportional segments with gaps", () => {
    const segments = layoutDonutSegments(
      [
        { key: "a", value: 75 },
        { key: "b", value: 25 },
      ],
      { cx: 50, cy: 50, innerRadius: 20, outerRadius: 40, gapDegrees: 4 },
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]!.key).toBe("a");
    expect(segments[0]!.percent).toBeCloseTo(75, 5);
    expect(segments[1]!.percent).toBeCloseTo(25, 5);
    // Drawable sweep is 360 - total gap; both segments leave room for gaps.
    const totalSweep = segments.reduce(
      (sum, segment) => sum + (segment.endAngle - segment.startAngle),
      0,
    );
    expect(totalSweep).toBeLessThan(360);
    expect(totalSweep).toBeGreaterThan(340);
  });

  it("ignores non-positive weights", () => {
    expect(
      layoutDonutSegments(
        [
          { key: "a", value: 0 },
          { key: "b", value: -1 },
        ],
        { cx: 0, cy: 0, innerRadius: 1, outerRadius: 2 },
      ),
    ).toEqual([]);
  });
});

describe("normalizeSparklineHeights", () => {
  it("scales peak to 1 and zeros empty days", () => {
    expect(normalizeSparklineHeights([0, 50, 100], { minVisible: 0.1 })).toEqual([0, 0.5, 1]);
  });

  it("enforces a minimum visible height for tiny positive values", () => {
    const heights = normalizeSparklineHeights([1, 100], { minVisible: 0.1 });
    expect(heights[0]).toBe(0.1);
    expect(heights[1]).toBe(1);
  });
});

describe("clampPercent", () => {
  it("clamps finite values into 0–100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42.2)).toBe(42.2);
    expect(clampPercent(null)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
  });
});
