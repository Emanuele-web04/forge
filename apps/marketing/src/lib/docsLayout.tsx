// FILE: lib/docsLayout.tsx
// Purpose: Shared Fumadocs layout options styled after the site chrome —
//          same wordmark, compact nav links, full-width Download CTA, and top-chrome theme toggle.
// Layer: docs layout configuration (server-importable).

import Image from "next/image";
import Link from "next/link";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ThemeToggle } from "@/components/ThemeToggle";

export function docsLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 text-[14px] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
          <Image
            src="/synara-icon.png"
            alt=""
            width={22}
            height={22}
            className="rounded-[5px] border border-[var(--divide)]"
          />
          Synara
          <span className="rounded-full border border-[var(--divide)] px-2 py-px text-[11px] font-medium tracking-normal text-[var(--text-tertiary)]">
            Docs
          </span>
        </span>
      ),
      url: "/",
      transparentMode: "none",
      children: (
        <div className="ms-auto flex items-center justify-end">
          <ThemeToggle />
        </div>
      ),
    },
    links: [
      { text: "Install", url: "/install" },
      { text: "Changelog", url: "/changelog" },
      {
        type: "custom",
        children: (
          <Link
            href="/install"
            className="mx-2 mt-1 flex min-h-9 items-center justify-center rounded-lg border border-[var(--divide)] px-4 py-2 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Download
          </Link>
        ),
      },
    ],
    themeSwitch: { enabled: false },
  };
}
