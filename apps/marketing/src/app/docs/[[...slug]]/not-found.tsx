// FILE: src/app/docs/[[...slug]]/not-found.tsx
// Purpose: Docs-flavored 404 for unknown docs slugs (e.g. /docs/nope).
//          The docs catch-all page calls notFound(); without a segment-level
//          boundary Next serves its `__next_error__` fallback document, whose
//          hydration rewrites the <html> class from the RSC tree. Dark mode is
//          preserved by the root ThemeScript, which re-asserts the stored
//          synara-theme class after any hydration class rewrite (debounced
//          MutationObserver) — in every document, including the error-fallback
//          shell. This boundary only supplies the docs-chromed 404 UI.
// Layer: App Router segment not-found (server component).

import Link from "next/link";

export default function DocsNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center px-4 py-24">
      <div className="mx-auto w-full max-w-xl text-center">
        <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          404
        </p>
        <h1 className="mt-3 text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]">
          Page not found
        </h1>
        <p className="mt-5 text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
          The documentation page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Browse the docs
          </Link>
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--divide)] px-5 py-2.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
