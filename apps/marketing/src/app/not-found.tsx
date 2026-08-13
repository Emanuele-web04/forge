// FILE: not-found.tsx
// Purpose: Site-chromed 404 page for unmatched routes (and docs pages that
//          call notFound()). Matches the site design system and is
//          dark-mode aware via the same design tokens as every other page.
// Layer: App Router not-found (server component).

import Link from "next/link";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <Navbar />
      <main className="flex flex-1 items-center justify-center px-4 py-24">
        <div className="mx-auto w-full max-w-xl text-center">
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
            404
          </p>
          <h1 className="mt-3 text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]">
            Page not found
          </h1>
          <p className="mt-5 text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
            The page you&apos;re looking for doesn&apos;t exist or has moved.
          </p>
          <Link
            href="/"
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90"
          >
            Back to home
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
