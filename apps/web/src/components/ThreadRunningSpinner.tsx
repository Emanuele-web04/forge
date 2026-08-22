// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared inline running/pulse spinner for sidebar thread status slots.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner

import { cn } from "~/lib/utils";

// Geometry mirrors Remodex's RunningThreadSpinner (with a thinner stroke and
// slower spin): a full track ring at 22% opacity (stroke ×0.7) and a rounded
// arc trimmed 0.16→0.72. The rotation uses the stepped `animate-spin-stepped`
// token (index.css) rather than `animate-spin`: this glyph is always on while a
// thread runs, and a continuous 60 fps spin inside the translucent sidebar forced
// the whole backdrop-filtered surface + window vibrancy to re-render every frame.
const CANVAS = 15;
const LINE_WIDTH = 2;
const RADIUS = (CANVAS - LINE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ARC_LENGTH = (0.72 - 0.16) * CIRCUMFERENCE;

export function ThreadRunningSpinner({ className }: { className?: string }) {
  return (
    <svg
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
