import type { PublicProfileHeatmapDay } from "../lib/publicProfile";

const WEEKS = 52;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The GitHub-style activity heatmap, tokens per UTC day over the last year.
 * Pure SSR markup — a grid of cells, no client JS — because the page must
 * unfurl and paint without hydration.
 */
export function Heatmap({ days }: { days: readonly PublicProfileHeatmapDay[] }) {
  const byDay = new Map(days.map((entry) => [entry.day, entry.tokens]));
  const max = Math.max(1, ...days.map((entry) => entry.tokens));

  // Grid columns are weeks ending today (UTC), Sunday-first like GitHub's.
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const end = todayUtc + (6 - new Date(todayUtc).getUTCDay()) * DAY_MS;

  const columns = Array.from({ length: WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => {
      const cellMs = end - ((WEEKS - 1 - week) * 7 + (6 - day)) * DAY_MS;
      const iso = new Date(cellMs).toISOString().slice(0, 10);
      const tokens = cellMs > todayUtc ? null : (byDay.get(iso) ?? 0);
      return { iso, tokens };
    }),
  );

  const level = (tokens: number): number => {
    if (tokens === 0) return 0;
    const ratio = tokens / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };
  const LEVEL_COLORS = ["#1b1b1f", "#123f24", "#166534", "#16a34a", "#4ade80"];

  return (
    <section
      aria-label="Activity heatmap, tokens per day"
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        overflowX: "auto",
      }}
    >
      <div style={{ display: "flex", gap: 3 }}>
        {columns.map((column, weekIndex) => (
          <div key={weekIndex} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {column.map((cell) => (
              <div
                key={cell.iso}
                title={cell.tokens === null ? undefined : `${cell.iso}: ${cell.tokens} tokens`}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background:
                    cell.tokens === null ? "transparent" : LEVEL_COLORS[level(cell.tokens)],
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
