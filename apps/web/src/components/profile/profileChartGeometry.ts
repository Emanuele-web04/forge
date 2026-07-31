// FILE: profileChartGeometry.ts
// Purpose: Pure SVG geometry helpers for profile charts (donut arcs, polar
// coordinates, sparkline bar heights). No React — safe for unit tests.
// Layer: web profile feature.

/** Convert polar coordinates to SVG cartesian (0° at 12 o'clock, clockwise). */
export function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

/**
 * Closed annulus sector path for a donut segment.
 * Angles are degrees, 0 at 12 o'clock, sweeping clockwise.
 * Returns null when the sweep is degenerate.
 */
export function donutSegmentPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
): string | null {
  const sweep = endAngle - startAngle;
  if (!(sweep > 0) || !(outerRadius > innerRadius) || !(innerRadius >= 0)) {
    return null;
  }

  // Full circle needs two arcs — a single 360° arc is invalid in SVG.
  if (sweep >= 359.999) {
    const mid = startAngle + 180;
    const outerA = polarToCartesian(cx, cy, outerRadius, startAngle);
    const outerB = polarToCartesian(cx, cy, outerRadius, mid);
    const outerC = polarToCartesian(cx, cy, outerRadius, startAngle + 360);
    const innerA = polarToCartesian(cx, cy, innerRadius, startAngle + 360);
    const innerB = polarToCartesian(cx, cy, innerRadius, mid);
    const innerC = polarToCartesian(cx, cy, innerRadius, startAngle);
    return [
      `M ${outerA.x} ${outerA.y}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${outerB.x} ${outerB.y}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${outerC.x} ${outerC.y}`,
      `L ${innerA.x} ${innerA.y}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${innerB.x} ${innerB.y}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${innerC.x} ${innerC.y}`,
      "Z",
    ].join(" ");
  }

  const largeArc = sweep > 180 ? 1 : 0;
  // Clockwise: outer arc sweeps with sweep-flag 1; inner returns with 0.
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

export interface DonutSegmentLayout {
  readonly key: string;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly percent: number;
  readonly path: string;
}

/**
 * Layout donut segments from relative weights (percentages or absolute counts).
 * `gapDegrees` is the empty gap between segments (split evenly on both sides).
 */
export function layoutDonutSegments(
  entries: ReadonlyArray<{ key: string; value: number }>,
  options: {
    readonly cx: number;
    readonly cy: number;
    readonly innerRadius: number;
    readonly outerRadius: number;
    readonly gapDegrees?: number;
    readonly startAngle?: number;
  },
): ReadonlyArray<DonutSegmentLayout> {
  const positive = entries.filter((entry) => Number.isFinite(entry.value) && entry.value > 0);
  const total = positive.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0 || positive.length === 0) {
    return [];
  }

  const gapDegrees = Number.isFinite(options.gapDegrees) ? Math.max(0, options.gapDegrees ?? 3) : 3;
  const startAngle = options.startAngle ?? 0;
  // Cap total gap so a single tiny segment still has room.
  const totalGap = Math.min(gapDegrees * positive.length, 36);
  const gapPerSegment = positive.length > 1 ? totalGap / positive.length : 0;
  const drawable = 360 - totalGap;

  let cursor = startAngle;
  const segments: DonutSegmentLayout[] = [];

  for (const entry of positive) {
    const sweep = (entry.value / total) * drawable;
    const segmentStart = cursor + gapPerSegment / 2;
    const segmentEnd = segmentStart + sweep;
    const path = donutSegmentPath(
      options.cx,
      options.cy,
      options.innerRadius,
      options.outerRadius,
      segmentStart,
      segmentEnd,
    );
    if (path) {
      segments.push({
        key: entry.key,
        startAngle: segmentStart,
        endAngle: segmentEnd,
        percent: (entry.value / total) * 100,
        path,
      });
    }
    cursor = segmentEnd + gapPerSegment / 2;
  }

  return segments;
}

/** Normalize values to 0–1 bar heights for sparklines (peak = 1). */
export function normalizeSparklineHeights(
  values: ReadonlyArray<number>,
  options?: { readonly minVisible?: number },
): ReadonlyArray<number> {
  const minVisible = options?.minVisible ?? 0.08;
  if (values.length === 0) {
    return [];
  }
  const finiteValues = values.map((value) => (Number.isFinite(value) ? value : 0));
  const peak = Math.max(...finiteValues, 0);
  if (peak <= 0) {
    return values.map(() => 0);
  }
  return finiteValues.map((value) => {
    if (value <= 0) {
      return 0;
    }
    return Math.max(minVisible, value / peak);
  });
}

/** Clamp a percentage into a safe 0–100 ring fill. */
export function clampPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}
