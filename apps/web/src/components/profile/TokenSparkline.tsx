// FILE: TokenSparkline.tsx
// Purpose: Compact monospace-style bar sparkline for lifetime token (or prompt)
// trend under the profile stat tile. Built from heatmap day counts.
// Layer: web profile feature.

import { useMemo } from "react";
import { cn } from "~/lib/utils";
import { normalizeSparklineHeights } from "./profileChartGeometry";

interface TokenSparklineProps {
  readonly values: ReadonlyArray<number>;
  readonly className?: string;
  readonly "aria-label"?: string;
}

export function TokenSparkline({
  values,
  className,
  "aria-label": ariaLabel = "Recent activity trend",
}: TokenSparklineProps) {
  const heights = useMemo(() => normalizeSparklineHeights(values), [values]);

  if (heights.length === 0) {
    return null;
  }

  const peakIndex = findPeakIndex(values);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn("flex h-7 w-full items-end gap-px", className)}
    >
      {heights.map((height, index) => {
        const isPeak = index === peakIndex && values[index]! > 0;
        return (
          <div
            key={index}
            className={cn(
              "min-h-px min-w-[2px] flex-1 rounded-[1px] transition-colors duration-200 ease-out motion-reduce:transition-none",
              isPeak
                ? "bg-[var(--info)]"
                : "bg-[color-mix(in_srgb,var(--info)_42%,transparent)] dark:bg-[color-mix(in_srgb,var(--info)_55%,transparent)]",
              height === 0 && "bg-muted/70 dark:bg-white/[0.06]",
            )}
            style={{ height: height === 0 ? "14%" : `${Math.round(height * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

function findPeakIndex(values: ReadonlyArray<number>): number {
  let peak = -1;
  let peakValue = -1;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (value > peakValue) {
      peakValue = value;
      peak = i;
    }
  }
  return peak;
}
