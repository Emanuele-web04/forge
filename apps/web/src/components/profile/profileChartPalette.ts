// FILE: profileChartPalette.ts
// Purpose: Theme-aware palette for model-mix charts. Keep chart colors tied to
// semantic app tokens so light and dark themes remain centrally controlled.
// Layer: web profile feature.

/** Semantic tokens are resolved by the active light/dark theme. */
export const PROFILE_MODEL_COLORS: readonly string[] = [
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--destructive)",
  "var(--foreground)",
  "var(--muted-foreground)",
];

export function profileModelColorAt(index: number): string {
  const palette = PROFILE_MODEL_COLORS;
  return palette[index % palette.length] ?? "var(--info)";
}

/** Dotted progress-ring accent (matches profile heatmap accent family). */
export const PROFILE_RING_ACCENT = "var(--info)";
export const PROFILE_RING_TRACK = "color-mix(in srgb, var(--muted-foreground) 28%, transparent)";
