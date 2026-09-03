// FILE: lib/sponsors.ts
// Purpose: Derives display groups and labels from the raw sponsor roll.
// Layer: shared utility (server/client importable).
// Note: The wall splits at the $49 tier, which is where the published perks
//       start promising visible recognition. That split is the only thing the
//       site knows about a sponsor's contribution — amounts are never stored,
//       so they can never leak onto the page.

import { SPONSORS, type Sponsor } from "@/data/sponsors";
import { GITHUB_SPONSORS_URL } from "@/lib/seo";

export type SponsorGroup = {
  id: string;
  title: string;
  sponsors: Sponsor[];
};

/**
 * The one recognition rule: top donors ahead of everyone else, declaration
 * order kept inside each half. Both the wall and the preview strip derive from
 * this, so a sponsor can never appear in one order on /sponsors and another on
 * /sponsor.
 */
function partitionByRecognition(sponsors: readonly Sponsor[]) {
  return {
    top: sponsors.filter((sponsor) => sponsor.top),
    rest: sponsors.filter((sponsor) => !sponsor.top),
  };
}

/** The roll as a single flat list, in the order the site always shows it. */
export function orderedSponsors(sponsors: readonly Sponsor[] = SPONSORS): Sponsor[] {
  const { top, rest } = partitionByRecognition(sponsors);
  return [...top, ...rest];
}

/** Deep-links straight into GitHub's checkout for one monthly tier. */
export function monthlyTierCheckoutUrl(amount: number) {
  return `${GITHUB_SPONSORS_URL}?frequency=recurring&amount=${amount}`;
}

/** GitHub has no fixed one-time tiers — this opens the custom-amount form. */
export const ONE_TIME_CHECKOUT_URL = `${GITHUB_SPONSORS_URL}?frequency=one-time`;

/**
 * The quiet second line under a sponsor's name: their handle, then the join
 * date. The handle is dropped when it only restates the display name (plenty of
 * sponsors have no GitHub name set, so `name === login`), and the whole line
 * collapses to null when there is nothing worth showing — never render an empty
 * row just to keep the list a uniform height.
 */
export function sponsorMetaLabel(sponsor: Sponsor) {
  const parts: string[] = [];
  if (sponsor.name.trim().toLowerCase() !== sponsor.login.trim().toLowerCase()) {
    parts.push(`@${sponsor.login}`);
  }
  if (sponsor.since) {
    parts.push(`since ${sponsor.since}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function sponsorLink(sponsor: Sponsor) {
  return sponsor.websiteUrl ?? `https://github.com/${sponsor.login}`;
}

/**
 * The same split as `orderedSponsors`, but kept as labelled groups for the
 * wall's headings. Empty groups are dropped so the page never shows a bare
 * heading.
 */
export function groupSponsors(sponsors: readonly Sponsor[] = SPONSORS): SponsorGroup[] {
  const { top, rest } = partitionByRecognition(sponsors);

  const groups: SponsorGroup[] = [
    { id: "top-donors", title: "Top donors", sponsors: top },
    { id: "donors", title: "Donors", sponsors: rest },
  ];

  return groups.filter((group) => group.sponsors.length > 0);
}
