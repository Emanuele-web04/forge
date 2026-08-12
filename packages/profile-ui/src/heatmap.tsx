// FILE: heatmap.tsx
// Purpose: GitHub-style contribution heatmap shared by the Profile page, the
// shareable card, and the public profile page. Renders columns of week × weekday
// cells with pre-bucketed intensity. Sizing uses inline px so html-to-image
// reproduces it exactly. Hover tooltips are pluggable: consumers pass
// `renderTooltip` to wrap cells in their own tooltip primitive (the web app uses
// Base UI); the default is a native `title` attribute.
// Layer: profile-ui shared component.

import { Fragment, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";
import { formatCompact, formatShortDate } from "./formatting";

// Structural mirror of `ProfileHeatmapCell` from @synara/contracts. Declared locally so
// this package stays free of Effect/contracts dependencies; the contracts type is
// assignable to it at every call site.
export interface HeatmapCell {
  readonly day: string;
  readonly count: number;
  readonly weekday: number;
  readonly intensity: number;
}

// Single-hue ramp built from the theme accent (`--info`, defaults to blue-500) for the
// in-app page (level 0 → 4). Mixes toward transparent so it sits well on light/dark.
export const APP_HEATMAP_INTENSITY_CLASSES: readonly string[] = [
  "bg-muted/70 dark:bg-white/[0.06]",
  "bg-[color-mix(in_srgb,var(--info)_24%,transparent)]",
  "bg-[color-mix(in_srgb,var(--info)_46%,transparent)]",
  "bg-[color-mix(in_srgb,var(--info)_72%,transparent)]",
  "bg-[var(--info)]",
];

// Accent ramp for the exported card. Mixes toward white so the steps stay opaque on the
// card's white background and reproduce identically via html-to-image. Level 0 mirrors the
// in-app heatmap's empty cell (`bg-muted/70`, i.e. black ~2.8%) flattened to an opaque color
// on white, so the exported image matches the empty-box color shown in the app.
export const CARD_HEATMAP_INTENSITY_CLASSES: readonly string[] = [
  "bg-[color-mix(in_srgb,black_2.8%,white)]",
  "bg-[color-mix(in_srgb,var(--info)_22%,white)]",
  "bg-[color-mix(in_srgb,var(--info)_45%,white)]",
  "bg-[color-mix(in_srgb,var(--info)_70%,white)]",
  "bg-[var(--info)]",
];

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

interface ActivityHeatmapProps {
  readonly cells: ReadonlyArray<HeatmapCell>;
  readonly cellSize?: number;
  readonly gap?: number;
  readonly radius?: number;
  readonly intensityClasses?: readonly string[];
  readonly showMonths?: boolean;
  readonly monthsPosition?: "top" | "bottom";
  readonly monthLabelClassName?: string;
  /**
   * Stretch columns to fill the container width (responsive square cells) instead
   * of using a fixed `cellSize`. Used by the in-app panel so the grid never scrolls
   * horizontally; the exported card keeps fixed px so html-to-image is exact.
   */
  readonly fill?: boolean;
  /**
   * In `fill` mode, stretch week columns across the container. When set, `maxCellSize`
   * caps each square cell's maximum size; columns shrink below that cap if needed so the
   * grid never overflows horizontally.
   */
  readonly maxCellSize?: number;
  /**
   * Wrap each day cell in a styled tooltip. Receives the cell data and the ready-made
   * cell element (classes + inline sizing applied); return it wrapped in your tooltip
   * primitive. Leave unset for a native `title` attribute — the right choice for the
   * exported card (html-to-image) and static pages.
   */
  readonly renderTooltip?: (cell: HeatmapCell, cellNode: ReactElement) => ReactNode;
  readonly className?: string;
}

/** Human tooltip label for a heatmap day, e.g. "1.2k prompts on Apr 3". */
export function heatmapTooltipText(cell: HeatmapCell, unit: string): string {
  const date = formatShortDate(cell.day) ?? cell.day;
  if (cell.count <= 0) {
    return `No ${unit} on ${date}`;
  }
  const noun = cell.count === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${formatCompact(cell.count)} ${noun} on ${date}`;
}

type Slot =
  | { readonly kind: "cell"; readonly cell: HeatmapCell }
  | { readonly kind: "pad"; readonly id: string };

interface Column {
  readonly key: string;
  readonly slots: ReadonlyArray<Slot>;
}

export function ActivityHeatmap({
  cells,
  cellSize: cellSizeProp,
  gap: gapProp,
  radius: radiusProp,
  intensityClasses: intensityClassesProp,
  showMonths: showMonthsProp,
  monthsPosition: monthsPositionProp,
  monthLabelClassName,
  fill: fillProp,
  maxCellSize,
  renderTooltip,
  className,
}: ActivityHeatmapProps) {
  const cellSize = cellSizeProp ?? 13;
  const gap = gapProp ?? 3;
  const radius = radiusProp ?? 4;
  const intensityClasses = intensityClassesProp ?? APP_HEATMAP_INTENSITY_CLASSES;
  const showMonths = showMonthsProp ?? false;
  const monthsPosition = monthsPositionProp ?? "top";
  const fill = fillProp ?? false;
  const columns: Column[] = [];
  if (cells.length > 0) {
    const slots: Slot[] = [];
    for (let index = 0; index < cells[0]!.weekday; index += 1) {
      slots.push({ kind: "pad", id: `pad-lead-${index}` });
    }
    for (const cell of cells) {
      slots.push({ kind: "cell", cell });
    }
    while (slots.length % 7 !== 0) {
      slots.push({ kind: "pad", id: `pad-tail-${slots.length}` });
    }

    for (let index = 0; index < slots.length; index += 7) {
      const week = slots.slice(index, index + 7);
      const firstCell = week.find(
        (slot): slot is Extract<Slot, { kind: "cell" }> => slot.kind === "cell",
      );
      columns.push({ key: firstCell ? firstCell.cell.day : `col-${index}`, slots: week });
    }
  }

  let previousMonth = -1;
  const monthByColumn: (string | null)[] = columns.map((column) => {
    const firstCell = column.slots.find(
      (slot): slot is Extract<Slot, { kind: "cell" }> => slot.kind === "cell",
    );
    if (!firstCell) {
      return null;
    }
    const monthIndex = Number(firstCell.cell.day.split("-")[1]) - 1;
    if (monthIndex === previousMonth || monthIndex < 0) {
      return null;
    }
    previousMonth = monthIndex;
    return MONTH_LABELS[monthIndex] ?? null;
  });

  const columnCount = columns.length;
  const responsiveFill = fill && maxCellSize != null;
  const resolvedCellSize = fill ? (maxCellSize ?? cellSize) : cellSize;

  const columnStyle: CSSProperties = { gap: `${gap}px` };
  const cellStyle: CSSProperties = fill
    ? { borderRadius: `${radius}px` }
    : {
        width: `${resolvedCellSize}px`,
        height: `${resolvedCellSize}px`,
        borderRadius: `${radius}px`,
      };
  const cellClass = fill ? "aspect-square w-full min-w-0" : "shrink-0";
  const fillColumnStyle: CSSProperties = responsiveFill
    ? { ...columnStyle, flex: "1 1 0%", maxWidth: `${maxCellSize}px`, minWidth: 0 }
    : columnStyle;
  const columnClass = fill ? "flex min-w-0 flex-1 flex-col" : "flex shrink-0 flex-col";
  const monthLabelWidth: CSSProperties | undefined = fill
    ? responsiveFill
      ? { flex: "1 1 0%", maxWidth: `${maxCellSize}px`, minWidth: 0 }
      : undefined
    : { width: `${resolvedCellSize}px` };
  const monthLabelClass = fill ? "min-w-0 flex-1" : "shrink-0";
  const rowClass = fill ? "flex w-full min-w-0" : "flex w-max";
  const gridWidth =
    !fill && columnCount > 0
      ? columnCount * resolvedCellSize + Math.max(0, columnCount - 1) * gap
      : 0;
  const rowStyle: CSSProperties = {
    ...columnStyle,
    ...(gridWidth > 0 ? { width: `${gridWidth}px` } : {}),
  };

  const monthRow = showMonths ? (
    <div className={rowClass} style={rowStyle}>
      {columns.map((column, index) => (
        <div
          key={column.key}
          className={cn(
            "overflow-visible whitespace-nowrap text-[10px] font-medium leading-none text-muted-foreground",
            monthLabelClass,
            monthLabelClassName,
          )}
          style={monthLabelWidth}
        >
          {monthByColumn[index] ?? ""}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div
      className={cn(fill ? "flex w-full min-w-0 flex-col" : "inline-flex flex-col", className)}
      style={{ gap: `${gap}px` }}
    >
      {showMonths && monthsPosition === "top" ? monthRow : null}
      <div className={rowClass} style={rowStyle}>
        {columns.map((column) => (
          <div key={column.key} className={columnClass} style={fillColumnStyle}>
            {column.slots.map((slot) => {
              if (slot.kind !== "cell") {
                return (
                  <div
                    key={slot.id}
                    className={cn(cellClass, "bg-transparent")}
                    style={cellStyle}
                  />
                );
              }
              const cellClassName = cn(
                cellClass,
                intensityClasses[slot.cell.intensity] ?? intensityClasses[0],
              );
              if (!renderTooltip) {
                return (
                  <div
                    key={slot.cell.day}
                    className={cellClassName}
                    style={cellStyle}
                    title={`${slot.cell.day} · ${slot.cell.count.toLocaleString()}`}
                  />
                );
              }
              return (
                <Fragment key={slot.cell.day}>
                  {renderTooltip(slot.cell, <div className={cellClassName} style={cellStyle} />)}
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
      {showMonths && monthsPosition === "bottom" ? monthRow : null}
    </div>
  );
}
