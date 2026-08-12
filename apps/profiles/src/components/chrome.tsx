// Shared page chrome for every route this app serves (profile, not-found): the
// full-width top nav with the Synara lockup and the hairline footer. Pure SSR.

import type { ReactNode } from "react";
import { SynaraLogo } from "@synara/profile-ui/logo";

export function SiteNav() {
  return (
    <nav className="flex w-full items-center justify-between px-6 py-5 sm:px-8">
      <a href="https://trysynara.com" className="flex items-center gap-2.5">
        <SynaraLogo className="h-[22px] w-auto" aria-label="Synara" />
        <span className="font-display text-lg leading-none">Synara</span>
      </a>
      <a
        href="https://trysynara.com"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Get Synara
      </a>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-4 px-6 py-6 sm:px-0">
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground/80">
          <SynaraLogo className="h-3.5 w-auto shrink-0 opacity-60" />
          <span className="truncate">Built with Synara — the open workspace for coding agents</span>
        </p>
        <a
          href="https://trysynara.com"
          className="shrink-0 text-xs text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          trysynara.com
        </a>
      </div>
    </footer>
  );
}

/** Nav + centered 720px column + footer — the frame both routes share. */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteNav />
      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-10 px-6 pb-16 pt-8 sm:px-0">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
