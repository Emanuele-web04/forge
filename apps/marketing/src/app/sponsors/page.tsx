// FILE: sponsors/page.tsx
// Purpose: The sponsor wall — a public thank-you listing everyone funding
//          Synara, grouped by tier. The pitch and the tiers live at /sponsor.
// Layer: App Router page (static)
// Depends on: Navbar, SiteFooter, SectionEyebrow, SponsorRow, data/sponsors, lib/sponsors
// Note: Only public GitHub sponsors belong in data/sponsors.ts — see the note
//       there before adding anyone.

import Link from "next/link";
import { LuArrowUpRight, LuHeart } from "react-icons/lu";
import Navbar from "@/components/Navbar";
import { SectionEyebrow } from "@/components/SectionEyebrow";
import SiteFooter from "@/components/SiteFooter";
import { SponsorRow } from "@/components/SponsorRow";
import { SPONSORS } from "@/data/sponsors";
import { ctaButtonClass } from "@/lib/ctaButton";
import { groupSponsors, orderedSponsors, sponsorLink } from "@/lib/sponsors";
import {
  GITHUB_SPONSORS_URL,
  breadcrumbJsonLd,
  jsonLdScript,
  pageMetadata,
  sponsorsPageJsonLd,
} from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Sponsors — Synara",
  description:
    "The people and companies funding Synara, the free and open-source command center for agentic development. Thank you to every sponsor and one-time donor.",
  path: "/sponsors",
});

const ORDERED_SPONSORS = orderedSponsors(SPONSORS);

const SPONSORS_JSONLD = [
  sponsorsPageJsonLd(
    ORDERED_SPONSORS.map((sponsor) => ({
      name: sponsor.name,
      url: sponsorLink(sponsor),
    })),
  ),
  breadcrumbJsonLd([
    { name: "Synara", path: "/" },
    { name: "Sponsors", path: "/sponsors" },
  ]),
];

export default function SponsorsPage() {
  const groups = groupSponsors(ORDERED_SPONSORS);
  const count = ORDERED_SPONSORS.length;

  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(SPONSORS_JSONLD) }}
      />
      <Navbar />

      {/* Same container as the landing page, Navbar, and SiteFooter, so the
          heading starts flush under the logo. The sponsor list itself stays
          narrow inside it — a short list of names shouldn't stretch to 6xl. */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        <header>
          <SectionEyebrow as="p">Sponsors</SectionEyebrow>
          <h1 className="mt-2.5 text-[1.35rem] font-medium leading-[1.2] tracking-[-0.03em] sm:text-[1.5rem]">
            The people keeping Synara free
          </h1>
          <p className="mt-3 max-w-3xl text-[13.5px] leading-[1.65] text-[var(--text-secondary)]">
            {count === 0
              ? "Synara is funded entirely by sponsorship. This page is where sponsors get listed — it's empty right now, so the first name on it is available."
              : "Synara is funded entirely by sponsorship — there's no paid tier and no company behind it. Everyone below chose to fund work they could otherwise use for free. Thank you."}
          </p>
        </header>

        {groups.length > 0 ? (
          <div className="mt-10 space-y-9">
            {groups.map((group) => (
              <section key={group.id}>
                <SectionEyebrow>{group.title}</SectionEyebrow>
                <ul className="mt-3 flex max-w-lg flex-col">
                  {group.sponsors.map((sponsor) => (
                    <li key={sponsor.login}>
                      <SponsorRow sponsor={sponsor} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="mt-10 text-[13px] text-[var(--text-tertiary)]">
            No sponsors yet — the first slot is open.
          </p>
        )}

        <section className="mt-12 border-t border-[var(--divide)] pt-8">
          <h2 className="text-[14px] font-medium tracking-[-0.01em]">
            Your name could be on this page
          </h2>
          <p className="mt-2 max-w-3xl text-[13px] leading-[1.65] text-[var(--text-secondary)]">
            Sponsoring Synara gets you listed here. Every tier runs through GitHub Sponsors — the
            full breakdown is on the sponsor page.
          </p>
          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
            <Link
              href="/sponsor"
              className={ctaButtonClass({ variant: "primary", width: "responsive" })}
            >
              <LuHeart className="size-4" aria-hidden="true" />
              See the tiers
            </Link>
            <a
              href={GITHUB_SPONSORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={ctaButtonClass({ variant: "secondary", width: "responsive" })}
            >
              Sponsor on GitHub
              <LuArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
