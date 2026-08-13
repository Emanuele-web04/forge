// FILE: ChangelogContent.tsx
// Purpose: Changelog page body — editorial layout for the full archive and
//          per-release pages. Keeps release rendering shared while letting
//          /changelog/v0.1.1 expose only that release for cleaner indexing.
// Layer: Server component. Content mirrors the in-app "What's new" dialog
//        (src/data/changelog.ts).

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { LuArrowDownToLine, LuLink } from "react-icons/lu";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import ChangelogNav from "@/components/ChangelogNav";
import ChangelogPicker from "@/components/ChangelogPicker";
import { type ChangelogEntry } from "@/data/changelog";
import { GITHUB_RELEASES_URL } from "@/lib/seo";
import { getSortedReleases, toAnchor, toVersionSlug } from "@/lib/changelog";

// Render `backtick` spans as inline code chips; everything else is plain text.
// The changelog data only uses backticks (no links/bold), so this stays tiny.
function renderInline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded-[5px] border border-[var(--divide)] bg-[var(--block-elevated)] px-1.5 py-0.5 font-mono text-[0.82em] text-[var(--text-primary)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default function ChangelogContent({
  releases = getSortedReleases(),
  title = "What's new in Synara.",
  description = "New providers, performance work, and the steady polish that makes the app faster and sturdier. Every release is logged here — the same notes you see in the app's \"What's new\" dialog.",
}: {
  releases?: ChangelogEntry[];
  title?: string;
  description?: string;
} = {}) {
  const highlightedRelease = releases[0];
  const releaseLabel = releases.length === 1 ? "Release" : "Latest release";
  const navItems = releases.map((entry) => ({
    version: entry.version,
    date: entry.date,
    anchor: toAnchor(entry.version),
  }));

  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <Navbar />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-10 pb-24 sm:px-6 sm:pt-16 md:max-w-6xl">
        <div className="md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-16 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-24">
          <aside className="hidden md:block">
            <ChangelogNav items={navItems} />
          </aside>

          <div className="min-w-0">
            <header className="max-w-2xl">
              <p className="hidden font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)] md:block">
                Changelog
              </p>
              <ChangelogPicker items={navItems} />
              <h1 className="mt-3 text-[1.5rem] font-medium leading-[1.12] tracking-[-0.035em] sm:text-[2rem]">
                {title}
              </h1>
              <p className="mt-5 text-[14px] leading-[1.7] text-[var(--text-secondary)] sm:text-[15px]">
                {description}
              </p>
              {highlightedRelease ? (
                <p className="mt-7 flex items-center gap-2.5 text-[12.5px] text-[var(--text-secondary)]">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--accent-link)] opacity-60 motion-reduce:hidden" />
                    <span className="relative inline-flex size-2 rounded-full bg-[var(--accent-link)]" />
                  </span>
                  {releaseLabel}{" "}
                  <span className="font-medium text-[var(--text-primary)]">
                    {highlightedRelease.version}
                  </span>
                  <span className="text-[var(--text-tertiary)]">· {highlightedRelease.date}</span>
                </p>
              ) : null}
            </header>

            <div className="mt-14 space-y-16 sm:mt-20 sm:space-y-24">
              {releases.map((entry) => (
                <Release key={entry.version} entry={entry} />
              ))}
            </div>

            <div className="mt-20 flex flex-col gap-4 border-t border-[var(--divide)] pt-8 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[12px] text-[var(--text-tertiary)]">
                Updated with every release.{" "}
                <a
                  href={GITHUB_RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent-link)] underline underline-offset-2 transition-colors hover:text-[var(--accent-link-hover)]"
                >
                  See releases on GitHub
                </a>
                .
              </p>
              <Link
                href="/install"
                className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90"
              >
                Download Synara
                <LuArrowDownToLine className="size-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Release({ entry }: { entry: ChangelogEntry }) {
  const anchor = toAnchor(entry.version);
  const single = entry.features.length === 1;

  return (
    <section id={anchor} className="scroll-mt-24">
      {/* Date links to the shareable per-version URL (/changelog/v0.1.1). */}
      <Link
        href={`/changelog/${toVersionSlug(entry.version)}`}
        className="group inline-flex items-center gap-1.5 text-[13px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        {entry.date}
        <LuLink
          aria-hidden="true"
          className="size-3 opacity-0 transition-opacity group-hover:opacity-100"
        />
        <span className="sr-only">— link to Synara {entry.version}</span>
      </Link>
      <h2 className="mt-1.5 text-[1.1875rem] font-medium leading-[1.2] tracking-[-0.02em] text-[var(--text-primary)] sm:text-[1.375rem]">
        Synara <span className="font-normal text-[var(--text-tertiary)]">{entry.version}</span>
      </h2>

      {single ? (
        <div className="mt-6">
          <Feature feature={entry.features[0]} />
        </div>
      ) : (
        <ul className="mt-7 space-y-5">
          {entry.features.map((feature) => (
            <li key={feature.id} className="flex gap-3.5">
              <span
                aria-hidden="true"
                className="mt-[0.66em] size-[5px] shrink-0 rounded-full bg-[var(--text-tertiary)]"
              />
              <Feature feature={feature} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Feature({ feature }: { feature: ChangelogEntry["features"][number] }) {
  return (
    <div className="min-w-0">
      <p className="text-[15px] leading-[1.65] text-[var(--text-secondary)] sm:text-[16px]">
        <span className="font-medium text-[var(--text-primary)]">
          {renderInline(feature.title)}
        </span>
        <span className="text-[var(--text-tertiary)]"> — </span>
        {renderInline(feature.description)}
      </p>
      {feature.details ? (
        <p className="mt-2 text-[13px] leading-[1.65] text-[var(--text-tertiary)]">
          {renderInline(feature.details)}
        </p>
      ) : null}
    </div>
  );
}
