// FILE: SiteFooter.tsx
// Purpose: Shared page footer (credits + attribution + privacy link) used across routes.
// Layer: Presentational component
// Depends on: next/link, design tokens in globals.css

import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-[var(--divide)] py-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 text-[12px] text-[var(--text-tertiary)] sm:flex-row sm:items-center sm:justify-between sm:gap-0 sm:px-6">
        <span>
          Made by{" "}
          <a
            href="https://x.com/emanueledpt"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            @emanueledpt
          </a>
        </span>
        <div className="flex items-center gap-4 sm:gap-6">
          <Link
            href="/docs"
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Docs
          </Link>
          <Link
            href="/changelog"
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Changelog
          </Link>
          <Link href="/sponsor" className="transition-colors hover:text-[var(--text-primary)]">
            Sponsor
          </Link>
          <Link
            href="/privacy"
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Privacy
          </Link>
        </div>
      </div>
    </footer>
  );
}
