// FILE: InsightProgressRings.tsx
// Purpose: Compact, theme-aware dotted rings for percentage insights. The SVG
// is decorative; the figure caption provides the accessible summary.
// Layer: web profile feature.

import { useId, useMemo } from "react";
import { cn } from "~/lib/utils";
import { polarToCartesian } from "./profileChartGeometry";
import { PROFILE_RING_ACCENT, PROFILE_RING_TRACK } from "./profileChartPalette";
import type { ProfileInsightRing } from "./profileSelectors";

const VIEW = 140;
const CX = VIEW / 2;
const CY = VIEW / 2;
const RADIUS = 52;
const DOT_COUNT = 48;
const DOT_RADIUS = 2.6;

interface InsightProgressRingsProps {
  readonly rings: ReadonlyArray<ProfileInsightRing>;
  readonly className?: string;
}

export function InsightProgressRings({ rings, className }: InsightProgressRingsProps) {
  if (rings.length === 0) {
    return (
      <div className={cn("grid grid-cols-2 gap-4", className)}>
        <ProgressRing
          ring={{ id: "provider", label: "—", detail: "No provider data yet", percent: 0 }}
        />
        <ProgressRing
          ring={{ id: "reasoning", label: "—", detail: "No reasoning data yet", percent: 0 }}
        />
      </div>
    );
  }

  return (
    <div
      className={cn("grid gap-4", rings.length === 1 ? "grid-cols-1" : "grid-cols-2", className)}
    >
      {rings.map((ring) => (
        <ProgressRing key={ring.id} ring={ring} />
      ))}
    </div>
  );
}

function ProgressRing({ ring }: { ring: ProfileInsightRing }) {
  const titleId = useId();
  const filled = Math.round((Math.min(100, Math.max(0, ring.percent)) / 100) * DOT_COUNT);

  const dots = useMemo(() => {
    return Array.from({ length: DOT_COUNT }, (_, index) => {
      // Start at 12 o'clock, go clockwise.
      const angle = (index / DOT_COUNT) * 360;
      const point = polarToCartesian(CX, CY, RADIUS, angle);
      return { ...point, filled: index < filled };
    });
  }, [filled]);

  const percentLabel = formatRingPercent(ring.percent);

  return (
    <figure className="flex flex-col items-center gap-2 text-center" aria-labelledby={titleId}>
      <div className="relative size-[118px] sm:size-[128px]">
        <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="size-full" aria-hidden="true">
          {dots.map((dot, index) => (
            <circle
              key={index}
              cx={dot.x}
              cy={dot.y}
              r={DOT_RADIUS}
              fill={dot.filled ? PROFILE_RING_ACCENT : PROFILE_RING_TRACK}
              className="transition-[fill] duration-300 ease-out motion-reduce:transition-none"
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-3">
          <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
            {percentLabel}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted-foreground">
            {ring.label}
          </span>
        </div>
      </div>
      <figcaption id={titleId} className="text-xs text-muted-foreground">
        {ring.detail}: {ring.label}, {percentLabel}
      </figcaption>
    </figure>
  );
}

function formatRingPercent(value: number): string {
  const rounded = Math.round(value);
  return `${rounded}%`;
}
