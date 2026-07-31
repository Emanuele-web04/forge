// FILE: ModelUsageDonut.tsx
// Purpose: Lightweight, theme-aware model usage donut with an accessible text legend.
// Lightweight SVG (no chart library) so the profile page stays fast.
// Layer: web profile feature.

import { useId, useMemo, useState } from "react";
import type { ProviderKind } from "@synara/contracts";
import { ProviderIcon } from "~/components/ProviderIcon";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { layoutDonutSegments } from "./profileChartGeometry";
import { profileModelColorAt } from "./profileChartPalette";
import { formatCompact, formatNumber } from "./profileFormatting";
import type { ProfileModelUsageEntry } from "./profileSelectors";

const VIEW = 160;
const CX = VIEW / 2;
const CY = VIEW / 2;
const OUTER = 68;
const INNER = 46;

interface ModelUsageDonutProps {
  readonly entries: ReadonlyArray<ProfileModelUsageEntry>;
  readonly metric: "tokens" | "turns";
  readonly totalWeight: number | null;
  /** Cap how many legend rows / slices are shown (rest collapsed into Other). */
  readonly maxSlices?: number;
  readonly className?: string;
}

interface Slice {
  readonly key: string;
  readonly label: string;
  readonly provider: ProviderKind | "unknown" | "mixed";
  readonly percent: number;
  readonly weight: number | null;
  readonly color: string;
}

export function ModelUsageDonut({
  entries,
  metric,
  totalWeight,
  maxSlices = 6,
  className,
}: ModelUsageDonutProps) {
  const chartId = useId().replace(/:/g, "");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const slices = useMemo(() => buildSlices(entries, maxSlices), [entries, maxSlices]);

  const segments = useMemo(
    () =>
      layoutDonutSegments(
        slices.map((slice) => ({
          key: slice.key,
          value: slice.weight ?? slice.percent,
        })),
        {
          cx: CX,
          cy: CY,
          innerRadius: INNER,
          outerRadius: OUTER,
          gapDegrees: 4,
          startAngle: 0,
        },
      ),
    [slices],
  );

  const centerValue = formatCenterValue({ metric, totalWeight, slices });
  const centerLabel = metric === "tokens" ? "tokens" : "turns";
  const activeKey = hoveredKey;

  if (slices.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8",
        className,
      )}
    >
      <div className="relative size-42 shrink-0 sm:size-44">
        <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="size-full" aria-hidden="true">
          {/* Soft track ring behind segments */}
          <circle
            cx={CX}
            cy={CY}
            r={(OUTER + INNER) / 2}
            fill="none"
            stroke="currentColor"
            strokeWidth={OUTER - INNER}
            className="text-muted/40"
          />

          {segments.map((segment) => {
            const slice = slices.find((entry) => entry.key === segment.key);
            if (!slice) {
              return null;
            }
            const isDimmed = activeKey !== null && activeKey !== segment.key;
            return (
              <path
                key={segment.key}
                d={segment.path}
                fill={slice.color}
                className="origin-center transition-opacity duration-200 ease-out motion-reduce:transition-none"
                style={{ opacity: isDimmed ? 0.22 : 1 }}
                onMouseEnter={() => setHoveredKey(segment.key)}
                onMouseLeave={() => setHoveredKey(null)}
              />
            );
          })}
        </svg>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-semibold tracking-tight tabular-nums text-foreground">
            {centerValue}
          </span>
          <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
        </div>
      </div>

      <ul className="flex w-full min-w-0 flex-1 flex-col gap-2.5">
        {slices.map((slice) => {
          const isDimmed = activeKey !== null && activeKey !== slice.key;
          return (
            <li key={slice.key}>
              <button
                type="button"
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-3 rounded-md text-left transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  isDimmed && "opacity-35",
                )}
                onMouseEnter={() => setHoveredKey(slice.key)}
                onMouseLeave={() => setHoveredKey(null)}
                onFocus={() => setHoveredKey(slice.key)}
                onBlur={() => setHoveredKey(null)}
                aria-label={`${slice.label}: ${formatPercent(slice.percent)}`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: slice.color }}
                    aria-hidden
                  />
                  {slice.provider !== "unknown" && slice.provider !== "mixed" ? (
                    <ProviderIcon provider={slice.provider} className="size-3.5 shrink-0" />
                  ) : (
                    <CentralIcon
                      name="chart-2"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="truncate text-sm text-foreground">{slice.label}</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                  {slice.weight !== null ? (
                    <span className="text-sm text-muted-foreground">
                      {metric === "tokens"
                        ? formatCompact(slice.weight)
                        : formatNumber(slice.weight)}
                    </span>
                  ) : null}
                  <span className="text-sm font-medium text-foreground">
                    {formatPercent(slice.percent)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function buildSlices(entries: ReadonlyArray<ProfileModelUsageEntry>, maxSlices: number): Slice[] {
  if (entries.length === 0) {
    return [];
  }

  const ranked = [...entries].sort((a, b) => b.percent - a.percent);
  const head = ranked.slice(0, Math.max(1, maxSlices - (ranked.length > maxSlices ? 1 : 0)));
  const tail = ranked.slice(head.length);

  const slices: Slice[] = head.map((entry, index) => ({
    key: `${entry.provider}:${entry.model}`,
    label: entry.model,
    provider: entry.provider,
    percent: entry.percent,
    weight: entry.weight,
    color: profileModelColorAt(index),
  }));

  if (tail.length > 0) {
    const percent = tail.reduce((sum, entry) => sum + entry.percent, 0);
    const weights = tail.map((entry) => entry.weight);
    const weight = weights.every((value) => value !== null)
      ? weights.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
    slices.push({
      key: "other",
      label: tail.length === 1 ? tail[0]!.model : `Other (${tail.length})`,
      provider: tail.length === 1 ? tail[0]!.provider : "mixed",
      percent,
      weight,
      color: profileModelColorAt(slices.length),
    });
  }

  return slices;
}

function formatCenterValue({
  metric,
  totalWeight,
  slices,
}: {
  metric: "tokens" | "turns";
  totalWeight: number | null;
  slices: ReadonlyArray<Slice>;
}): string {
  if (totalWeight !== null) {
    return metric === "tokens" ? formatCompact(totalWeight) : formatNumber(totalWeight);
  }
  const fromSlices = slices.reduce<number | null>((sum, slice) => {
    if (sum === null || slice.weight === null) {
      return null;
    }
    return sum + slice.weight;
  }, 0);
  if (fromSlices !== null && fromSlices > 0) {
    return metric === "tokens" ? formatCompact(fromSlices) : formatNumber(fromSlices);
  }
  return "—";
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}
