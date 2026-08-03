// FILE: ui/src/components/Shell.tsx
// Purpose: The centered card every ceremony page lives inside — wordmark,
// title, and the shared page chrome.
// Layer: Account UI presentation
// Depends on: React.

import type { ReactNode } from "react";

export function Wordmark(): ReactNode {
  return (
    <div className="flex items-center justify-center gap-2.5">
      <span
        aria-hidden
        className="size-2.5 rotate-45 rounded-[3px] bg-accent shadow-[0_0_18px_-2px_var(--color-accent)]"
      />
      <span className="text-[15px] font-medium tracking-[0.2em] text-ink uppercase">Synara</span>
    </div>
  );
}

export function Shell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      {/* A single soft accent bloom behind the card: the only ornament on the page. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,var(--color-accent)_0%,transparent_70%)] opacity-[0.07]"
      />

      <div className="relative w-full max-w-[400px]">
        <Wordmark />

        <div className="mt-9 rounded-2xl border border-line/70 bg-surface/80 p-8 shadow-[0_1px_0_0_oklch(1_0_0/0.04)_inset,0_24px_60px_-30px_oklch(0_0_0/0.9)] backdrop-blur-sm">
          <header className="mb-7">
            <h1 className="text-[19px] leading-tight font-semibold tracking-[-0.01em] text-ink">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">{subtitle}</p>
            ) : null}
          </header>
          {children}
        </div>

        {footer ? (
          <div className="mt-6 text-center text-[13px] text-ink-faint">{footer}</div>
        ) : null}
      </div>
    </main>
  );
}
