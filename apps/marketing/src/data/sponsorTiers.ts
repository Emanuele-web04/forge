// FILE: data/sponsorTiers.ts
// Purpose: Shared sponsorship copy — the GitHub Sponsors tiers and the public
//          sponsor roll used by /sponsor and its structured data.
// Layer: static content (server/client importable).
// Note: `amount` and `perks` mirror the live tiers on
//       https://github.com/sponsors/Emanuele-web04. GitHub is the source of
//       truth — if a tier changes there, change it here too. `label` is
//       presentation only; GitHub itself only shows the price.

export type SponsorTier = {
  /** Stable key + GitHub's `?frequency=` deep link discriminator. */
  id: string;
  /** Monthly price in whole USD. */
  amount: number;
  label: string;
  /** Group heading on /sponsors, e.g. "Backers". */
  plural: string;
  tagline: string;
  perks: string[];
  /** Gives the tier a subtle fill in the grid to mark it as the top tier. */
  featured?: boolean;
};

export const SPONSOR_TIERS: readonly SponsorTier[] = [
  {
    id: "supporter",
    amount: 5,
    label: "Supporter",
    plural: "Supporters",
    tagline: "Support my open-source work and help keep Synara Desktop free.",
    perks: ["Backs ongoing development of the free desktop app"],
  },
  {
    id: "backer",
    amount: 15,
    label: "Backer",
    plural: "Backers",
    tagline: "Support Synara's development and get your name on the sponsors page.",
    perks: ["Everything in Supporter", "Your name listed on this sponsors page"],
  },
  {
    id: "project-sponsor",
    amount: 49,
    label: "Project sponsor",
    plural: "Project sponsors",
    tagline: "Support Synara as a project sponsor.",
    perks: [
      "Everything in Backer",
      "Your name listed on the Synara sponsors page",
      "Thank you post on X",
    ],
  },
  {
    id: "featured-sponsor",
    amount: 149,
    label: "Featured sponsor",
    plural: "Featured sponsors",
    tagline: "Support Synara at a higher level and get more visible recognition.",
    perks: [
      "Everything in Project sponsor",
      "Featured logo placement on the sponsors page, the Synara home page, and my portfolio",
      "Thank you post on X",
    ],
  },
  {
    id: "partner",
    amount: 499,
    label: "Partner",
    plural: "Partners",
    tagline: "Premium sponsorship for companies that want to support Synara visibly.",
    perks: [
      "Logo + link in the main sponsor banner on the Synara sponsor page and home page, plus my portfolio",
      "Featured placement above other sponsors",
      "Thank you post on X, plus one dedicated ad post on X after each monthly renewal",
    ],
    featured: true,
  },
];

/**
 * GitHub always offers a custom amount alongside the published tiers, on both
 * the monthly and the one-time frequency — there are no fixed one-time tiers.
 * This is what a "One time (custom)" sponsorship in the dashboard means.
 */
export const ONE_TIME_SPONSORSHIP = {
  label: "One-time",
  tagline:
    "Prefer a single contribution? Pick any amount you like — no subscription, no commitment.",
  perks: ["Any custom amount", "$49 or more is listed with the top donors"],
};

export const SPONSOR_FUNDING_USES = [
  {
    title: "Development time",
    body: "The hours that go into new providers, worktree flows, and the parts of Synara that are tedious to get right.",
  },
  {
    title: "Reliable releases",
    body: "Signed installers, release testing across macOS, Windows, and Linux, and the fixes that follow a bad build.",
  },
  {
    title: "Docs and support",
    body: "Written guides, changelog entries, and answering the issues that come in after every release.",
  },
];
