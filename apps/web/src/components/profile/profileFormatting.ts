// FILE: profileFormatting.ts
// Purpose: Pure display formatters shared by the Profile page and the shareable card.
// Layer: web profile feature (no I/O, safe to use during html-to-image render).

// Compact token/count formatting matching the reference card ("17bn", "538m", "1.2k").
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${trimZero(value / 1_000_000_000)}bn`;
  }
  if (abs >= 1_000_000) {
    return `${trimZero(value / 1_000_000)}m`;
  }
  if (abs >= 1_000) {
    return `${trimZero(value / 1_000)}k`;
  }
  return `${Math.round(value)}`;
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

// Thousands-separated integer ("4,934").
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return WHOLE_NUMBER_FORMATTER.format(value);
}

export function formatDays(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "day" : "days"}`;
}

// Title-case a home-directory basename into a friendly display name.
export function toDisplayName(basename: string): string {
  const cleaned = basename
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return "Synara";
  }
  return cleaned
    .split(" ")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function normalizeHandle(value: string): string {
  const slug = value
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 30);
  return `@${slug || "synara"}`;
}

// Pretty short date for "peak day" tooltips ("Apr 3").
export function formatShortDate(day: string | null): string | null {
  if (!day) {
    return null;
  }
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) {
    return null;
  }
  return MONTH_DAY_FORMATTER.format(new Date(Date.UTC(year, month - 1, date)));
}

const WHOLE_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
