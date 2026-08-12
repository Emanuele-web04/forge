// The few display helpers @synara/profile-ui/formatting doesn't cover — all specific
// to the public page's copy (member-since spelling, avatar grapheme, streak em dash).

import { formatDays } from "@synara/profile-ui/formatting";

/** "2026-08-11T…" → "August 2026" — the "on Synara since" spelling. */
export function memberSince(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}


/** "12 days" / "1 day" via profile-ui's formatDays; em dash before any activity. */
export function formatStreak(days: number): string {
  return days <= 0 ? "—" : formatDays(days);
}
