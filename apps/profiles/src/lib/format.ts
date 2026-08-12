/** 1234567 → "1.2M" — the compact stat spelling the share card uses. */
export function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

/** "2026-08-11T…" → "August 2026" — the "member since" spelling. */
export function memberSince(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** First grapheme of the display name, uppercased — the avatar fallback glyph. */
export function initial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** "12 days" / "1 day" / em dash before any activity. */
export function formatStreak(days: number): string {
  if (days <= 0) return "\u2014";
  return days === 1 ? "1 day" : `${days} days`;
}
