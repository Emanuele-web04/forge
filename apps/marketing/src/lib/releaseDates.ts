// FILE: lib/releaseDates.ts
// Purpose: Converts short changelog date labels into stable ISO dates for SEO.
// Layer: shared utility for sitemaps and structured data.

const DEFAULT_RELEASE_YEAR = 2026;

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

/** Fallbacks only; dynamic route helpers prefer changelog and Git metadata. */
export const SITE_LATEST_UPDATE = new Date("2026-08-02T00:00:00.000Z");
export const PRIVACY_LAST_UPDATED = new Date("2026-06-04T00:00:00.000Z");
export const DOCS_LAST_UPDATED = new Date("2026-08-04T00:00:00.000Z");
export const SPONSOR_LAST_UPDATED = new Date("2026-08-07T00:00:00.000Z");

export function releaseDateIso(dateLabel: string) {
  const [monthName, day] = dateLabel.split(" ");
  const month = MONTHS[monthName] ?? "01";
  const paddedDay = (day ?? "1").padStart(2, "0");

  return `${DEFAULT_RELEASE_YEAR}-${month}-${paddedDay}T00:00:00.000Z`;
}

export function releaseDate(dateLabel: string) {
  return new Date(releaseDateIso(dateLabel));
}
