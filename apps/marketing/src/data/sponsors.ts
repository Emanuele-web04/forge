// FILE: data/sponsors.ts
// Purpose: The public sponsor roll rendered on /sponsors and previewed on /sponsor.
// Layer: static content (server/client importable).
// Note: Maintained by hand — add an entry when GitHub reports a new sponsor.
//       ONLY list sponsors who are public on GitHub. Sponsorship can be private,
//       and a private sponsor must never be published here.
//       Never store a sponsor's contribution amount. GitHub keeps amounts to the
//       maintainer dashboard and does not publish them, so neither do we — `top`
//       records which side of the $49 line someone falls on, nothing more.

export type Sponsor = {
  /** GitHub login; also builds the profile link and the dedupe key. */
  login: string;
  /** Display name — falls back to the login when someone has no name set. */
  name: string;
  avatarUrl: string;
  /**
   * True for the tiers that buy visible recognition: $49/mo and up, or a
   * one-time gift of $49 or more. Drives the listing order and the
   * "Top donors" group. Leave it off for everyone else, including sponsors
   * whose tier you haven't looked up yet.
   */
  top?: boolean;
  /** Display date the sponsorship started, e.g. "Aug 2, 2026". */
  since?: string;
  /** Optional company link used instead of the GitHub profile. */
  websiteUrl?: string;
  /** Logo for top donors, served from /public. Falls back to the avatar. */
  logoUrl?: string;
};

/** Newest first. */
export const SPONSORS: readonly Sponsor[] = [
  {
    login: "sandeshapparala",
    name: "Sandesh Apparala",
    avatarUrl: "https://avatars.githubusercontent.com/u/138796263?v=4",
    since: "Aug 4, 2026",
  },
  {
    login: "aristotl-dylan",
    name: "aristotl-dylan",
    avatarUrl: "https://avatars.githubusercontent.com/u/247120692?v=4",
    top: true,
    since: "Aug 3, 2026",
  },
  {
    login: "lassejlv",
    name: "Lasse",
    avatarUrl: "https://avatars.githubusercontent.com/u/77295879?v=4",
    since: "Aug 3, 2026",
    websiteUrl: "https://lassejlv.dk",
  },
  {
    login: "Howardedu",
    name: "Howardedu",
    avatarUrl: "https://avatars.githubusercontent.com/u/99465200?v=4",
    top: true,
    since: "Aug 3, 2026",
  },
  {
    login: "m-vts",
    name: "m-vts",
    avatarUrl: "https://avatars.githubusercontent.com/u/43476645?v=4",
    top: true,
    since: "Aug 2, 2026",
  },
];
