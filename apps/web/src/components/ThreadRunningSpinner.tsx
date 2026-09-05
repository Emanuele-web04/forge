// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared inline running/pulse spinner for sidebar thread status slots.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner

import { useRef } from "react";

import { useTimelineSynchronizedAnimations } from "~/lib/animationTimelineSync";
import { cn } from "~/lib/utils";

// Geometry mirrors Remodex's RunningThreadSpinner (with a thinner stroke and
// slower spin): a full track ring at 22% opacity (stroke ×0.7) and a rounded
// arc trimmed 0.16→0.72. The rotation uses the stepped `animate-spin-stepped`
// token (index.css) rather than `animate-spin`: this glyph is always on while a
// thread runs, and a continuous 60 fps spin inside the translucent sidebar forced
// the whole backdrop-filtered surface + window vibrancy to re-render every frame.
// Every instance is also pinned to the document timeline origin: N running threads
// then step in the same frame (one sidebar repaint per step) instead of N frames.
const CANVAS = 15;
const LINE_WIDTH = 2;
const RADIUS = (CANVAS - LINE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ARC_LENGTH = (0.72 - 0.16) * CIRCUMFERENCE;

export function ThreadRunningSpinner({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  useTimelineSynchronizedAnimations(svgRef);
  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      fill="none"
      className={cn(
        "inline-block size-3 shrink-0 animate-spin-stepped text-muted-foreground/55 motion-reduce:animate-none",
        className,
      )}
    >
      <circle
        cx={CANVAS / 2}
        cy={CANVAS / 2}
        r={RADIUS}
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={LINE_WIDTH * 0.7}
      />
      <circle
        cx={CANVAS / 2}
        cy={CANVAS / 2}
        r={RADIUS}
        stroke="currentColor"
        strokeWidth={LINE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={`${ARC_LENGTH} ${CIRCUMFERENCE}`}
        strokeDashoffset={-0.16 * CIRCUMFERENCE}
      />
    </svg>
  );
}
