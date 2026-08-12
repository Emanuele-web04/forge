// Builds the profile-ui `HeatmapCell` grid from the API's sparse day buckets.
// Pure date/rank math (no I/O) so the page can stay fully SSR.

import type { HeatmapCell } from "@synara/profile-ui/heatmap";
import type { PublicProfileHeatmapDay } from "./publicProfile";

const DAY_MS = 86_400_000;
// Number of non-empty intensity levels (1–4); level 0 is reserved for empty days.
const HEATMAP_LEVELS = 4;
// Trailing window: the SAME ~9-month span the in-app dashboard uses
// (HEATMAP_WINDOW_DAYS in apps/server/src/profileStats.ts) — the public page
// must show the identical grid the owner sees in the app.
const WINDOW_DAYS = 274;

/**
 * Rank-based intensity, mirroring `heatmapIntensity` in apps/server/src/profileStats.ts.
 * Percent-of-max bucketing collapses on skewed data — token counts routinely span orders
 * of magnitude, so one spike day flattens the rest of the grid to level 1. Ranking spreads
 * active days across all four levels regardless of scale; ties share a level.
 */
export function heatmapIntensity(count: number, sortedActiveCounts: readonly number[]): number {
  if (count <= 0 || sortedActiveCounts.length === 0) {
    return 0;
  }
  // Days with a count <= this one, i.e. this day's rank in the active-day distribution.
  let low = 0;
  let high = sortedActiveCounts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedActiveCounts[mid]! <= count) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const level = Math.ceil((low * HEATMAP_LEVELS) / sortedActiveCounts.length);
  return Math.min(HEATMAP_LEVELS, Math.max(1, level));
}

function utcMsOf(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

/**
 * The trailing ~274-day cell grid, tokens per UTC day, ending on the owner's most
 * recent day. Usage pushes land in the owner's local day buckets, so the window ends
 * at the later of the newest bucket and today's UTC date — the grid is always full
 * and never truncates a bucket the owner already has.
 */
export function buildHeatmapCells(days: readonly PublicProfileHeatmapDay[]): HeatmapCell[] {
  const tokensByDay = new Map(days.map((entry) => [entry.day, entry.tokens]));
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const newestBucketMs = days.reduce((max, entry) => Math.max(max, utcMsOf(entry.day)), 0);
  const endMs = Math.max(todayMs, newestBucketMs);
  const startMs = endMs - (WINDOW_DAYS - 1) * DAY_MS;

  const activeCounts = days
    .filter((entry) => entry.tokens > 0 && utcMsOf(entry.day) >= startMs)
    .map((entry) => entry.tokens)
    .sort((left, right) => left - right);

  const cells: HeatmapCell[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = new Date(ms);
    const day = date.toISOString().slice(0, 10);
    const count = tokensByDay.get(day) ?? 0;
    cells.push({
      day,
      count,
      weekday: date.getUTCDay(),
      intensity: heatmapIntensity(count, activeCounts),
    });
  }
  return cells;
}
