// FILE: sponsor/page.tsx
// Purpose: Sponsorship page — the GitHub Sponsors tiers, what the money funds,
//          and the current sponsor roll. Linked from the navbar and footer.
// Layer: App Router page (static)
// Depends on: Navbar, SiteFooter, SectionEyebrow, data/sponsorTiers, react-icons/lu
// Note: Tier copy lives in data/sponsorTiers.ts and mirrors the live GitHub
//       tiers. Every CTA deep-links into GitHub Sponsors — checkout is entirely
//       GitHub's, this page never handles payment.
//       Layout deliberately tracks /sponsors: same container, left-aligned
//       header, mono section eyebrows, and a single rule above the closing CTA.
//       The two pages link to each other constantly, so they have to read as one.

import Link from "next/link";
import { LuCheck, LuHeart, LuArrowUpRight, LuArrowDownToLine } from "react-icons/lu";
import Navbar from "@/components/Navbar";
import { SectionEyebrow } from "@/components/SectionEyebrow";
import SiteFooter from "@/components/SiteFooter";
import { SponsorRow } from "@/components/SponsorRow";
import { SPONSORS } from "@/data/sponsors";
import { ctaButtonClass } from "@/lib/ctaButton";
import {
  ONE_TIME_SPONSORSHIP,
  SPONSOR_FUNDING_USES,
  SPONSOR_TIERS,
  type SponsorTier,
} from "@/data/sponsorTiers";
import { ONE_TIME_CHECKOUT_URL, monthlyTierCheckoutUrl, orderedSponsors } from "@/lib/sponsors";
import {
  GITHUB_SPONSORS_URL,
  breadcrumbJsonLd,
  jsonLdScript,
  pageMetadata,
  sponsorJsonLd,
} from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Sponsor — Synara",
  description:
    "Sponsor Synara on GitHub Sponsors. Monthly tiers from $5 to $499, plus custom one-time amounts, fund development, reliable releases, and docs for the free, open-source desktop app.",
  path: "/sponsor",
});

const SPONSOR_JSONLD = [
  sponsorJsonLd(SPONSOR_TIERS),
  breadcrumbJsonLd([
    { name: "Synara", path: "/" },
    { name: "Sponsor", path: "/sponsor" },
  ]),
];

export default function SponsorPage() {
  const sponsors = orderedSponsors(SPONSORS);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(SPONSOR_JSONLD) }}
      />
      <Navbar />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        <header>
          <SectionEyebrow as="p">Sponsor</SectionEyebrow>
          <h1 className="mt-2.5 text-[1.35rem] font-medium leading-[1.2] tracking-[-0.03em] sm:text-[1.5rem]">
            Synara is free. Sponsorship is what keeps it that way.
          </h1>
          <p className="mt-3 max-w-3xl text-[13.5px] leading-[1.65] text-[var(--text-secondary)]">
            Synara Desktop is open source under the MIT license, with no paid tier, no account, and
            nothing held back behind a subscription. It&apos;s maintained by me, with help from some
            kind developers in the open source community. If it saves you time, sponsoring is the
            most direct way to keep it moving — every tier below runs through GitHub Sponsors, so
            billing, receipts, and cancellation stay entirely on GitHub.
          </p>
          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
            <a
              href={GITHUB_SPONSORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={ctaButtonClass({ variant: "primary", width: "responsive" })}
            >
              <LuHeart className="size-4" aria-hidden="true" />
              Become a sponsor
            </a>
            <a
              href={ONE_TIME_CHECKOUT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={ctaButtonClass({ variant: "secondary", width: "responsive" })}
            >
              Give once
              <LuArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </div>
        </header>

        <section className="mt-12">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between">
            <SectionEyebrow>Monthly tiers</SectionEyebrow>
            <p className="text-[12px] text-[var(--text-tertiary)]">
              Cancel any time from your GitHub billing settings.
            </p>
          </div>

          {/* Hairline grid, the same treatment Features and PrivacySection use
              on the landing page. `gap-px` over a divide-coloured background
              draws the rules, so the cell count can change at every breakpoint
              without any nth-child border math. Six cells divide evenly into
              1/2/3 columns, so no row is ever left with a gap. */}
          <div className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-[var(--divide)] bg-[var(--divide)] sm:grid-cols-2 lg:grid-cols-3">
            {SPONSOR_TIERS.map((tier) => (
              <TierCard key={tier.id} tier={tier} />
            ))}
            <OneTimeCard />
          </div>
        </section>

        <section className="mt-12">
          <SectionEyebrow>Where the money goes</SectionEyebrow>
          {/* Plain columns, not cards. The tier grid above is the only thing on
              this page that earns card chrome — three short paragraphs read
              better unboxed, the same way the sponsor rows do. */}
          <div className="mt-4 grid gap-6 sm:grid-cols-3 sm:gap-8">
            {SPONSOR_FUNDING_USES.map((use) => (
              <div key={use.title}>
                <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{use.title}</h3>
                <p className="mt-1.5 text-[13px] leading-[1.65] text-[var(--text-secondary)]">
                  {use.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between">
            <SectionEyebrow>
              {sponsors.length === 1 ? "Current sponsor" : "Current sponsors"}
            </SectionEyebrow>
            {sponsors.length > 0 ? (
              <Link
                href="/sponsors"
                className="inline-flex items-center gap-1 text-[12px] text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
              >
                See the full sponsor wall
                <LuArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
          <p className="mt-2 max-w-3xl text-[13px] leading-[1.65] text-[var(--text-secondary)]">
            Thank you — genuinely. This list is updated by hand as sponsorships come in.
          </p>

          {sponsors.length > 0 ? (
            <ul className="mt-3 flex max-w-lg flex-col">
              {sponsors.slice(0, 6).map((sponsor) => (
                <li key={sponsor.login}>
                  <SponsorRow sponsor={sponsor} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-[var(--text-tertiary)]">
              No sponsors yet — the first slot is open.
            </p>
          )}
        </section>

        <section className="mt-12">
          <SectionEyebrow>Questions</SectionEyebrow>
          <div className="mt-4 space-y-5">
            <QA question="Does sponsoring unlock features?">
              No. Synara is MIT-licensed and every feature is free for everyone, sponsor or not.
              Sponsorship funds the work — it doesn&apos;t buy access.
            </QA>
            <QA question="Can I sponsor as a company?">
              Yes. GitHub Sponsors supports paying from an organization account, and invoices come
              from GitHub. Logo placement and a link come with the $149 and $499 tiers, whoever is
              sponsoring.
            </QA>
            <QA question="Can I give a one-off amount instead?">
              Yes. Switch to the One-time tab on GitHub and enter any amount you like — there are no
              fixed one-time tiers, so a one-off contribution always shows up as a custom amount.
            </QA>
            <QA question="How do I get my name or logo listed?">
              Sponsor at $15 or above and your name goes on the sponsor wall; from $49 up — monthly
              or one-time — it goes under Top donors. For logo placement at $149 and above, send me
              the asset and the link you want it to point at{" "}
              <a
                href="https://x.com/emanueledpt"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
              >
                on X
              </a>
              .
            </QA>
          </div>
        </section>

        <div className="mt-12 flex flex-col gap-4 border-t border-[var(--divide)] pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Not able to sponsor? Starring the repo and telling someone about Synara genuinely helps
            too.
          </p>
          <Link href="/install" className={ctaButtonClass({ variant: "secondary", width: "fit" })}>
            Download Synara
            <LuArrowDownToLine className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

/**
 * One cell of the tier grid. The whole cell is the link rather than holding a
 * button, so six tiers don't stack six competing pills down the page — the loud
 * CTA stays the one in the header. Hover tints the cell, matching the landing
 * page's feature grid.
 */
function TierCell({
  href,
  label,
  price,
  priceSuffix,
  tagline,
  perks,
  action,
  ariaLabel,
  featured,
}: {
  href: string;
  label: string;
  price: string;
  priceSuffix?: string;
  tagline: string;
  perks: readonly string[];
  action: string;
  ariaLabel: string;
  featured?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel}
      className={`group flex flex-col p-6 transition-colors hover:bg-[var(--mock-row)] ${
        featured ? "bg-[var(--block-elevated)]" : "bg-[var(--page-bg)]"
      }`}
    >
      <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{label}</h3>

      <p className="mt-2.5 flex items-baseline gap-1">
        <span className="font-mono text-[1.25rem] tabular-nums tracking-[-0.02em] text-[var(--text-primary)]">
          {price}
        </span>
        {priceSuffix ? (
          <span className="text-[12px] text-[var(--text-tertiary)]">{priceSuffix}</span>
        ) : null}
      </p>

      <p className="mt-3 text-[13px] leading-[1.6] text-[var(--text-secondary)]">{tagline}</p>

      <PerkList perks={perks} />

      <span className="mt-5 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
        {action}
        <LuArrowUpRight
          className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          aria-hidden="true"
        />
      </span>
    </a>
  );
}

function TierCard({ tier }: { tier: SponsorTier }) {
  return (
    <TierCell
      href={monthlyTierCheckoutUrl(tier.amount)}
      label={tier.label}
      price={`$${tier.amount}`}
      priceSuffix="/mo"
      tagline={tier.tagline}
      perks={tier.perks}
      action="Sponsor on GitHub"
      ariaLabel={`Sponsor the ${tier.label} tier at $${tier.amount} a month on GitHub Sponsors`}
      featured={tier.featured}
    />
  );
}

function OneTimeCard() {
  return (
    <TierCell
      href={ONE_TIME_CHECKOUT_URL}
      label={ONE_TIME_SPONSORSHIP.label}
      price="Any amount"
      tagline={ONE_TIME_SPONSORSHIP.tagline}
      perks={ONE_TIME_SPONSORSHIP.perks}
      action="Give once on GitHub"
      ariaLabel="Give a one-time amount on GitHub Sponsors"
    />
  );
}

function PerkList({ perks }: { perks: readonly string[] }) {
  return (
    <ul className="mt-4 flex-1 space-y-2">
      {perks.map((perk) => (
        <li key={perk} className="flex items-start gap-2 text-[12.5px] leading-[1.5]">
          <LuCheck
            className="mt-[3px] size-3.5 shrink-0 text-[var(--text-tertiary)]"
            aria-hidden="true"
          />
          <span className="text-[var(--text-secondary)]">{perk}</span>
        </li>
      ))}
    </ul>
  );
}

function QA({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{question}</h3>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-[1.65] text-[var(--text-secondary)]">
        {children}
      </p>
    </div>
  );
}
