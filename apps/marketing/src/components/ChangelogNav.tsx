// FILE: ChangelogNav.tsx
// Purpose: Sticky left-rail "on this page" menu (md+) for the changelog — lists
//          every release, scroll-spies the one in view, and anchors to it on
//          click (smooth, reduced-motion aware). Keeps the active row visible in
//          the rail as you scroll the page.
// Layer: Client component (interactive); data is passed in from the server page.

"use client";

import { useEffect, useRef } from "react";
import { type ChangelogNavItem, useActiveAnchor } from "@/lib/useActiveAnchor";

export type { ChangelogNavItem };

export default function ChangelogNav({ items }: { items: ChangelogNavItem[] }) {
  const { active, jumpTo } = useActiveAnchor(items);
  const navRef = useRef<HTMLElement>(null);

  // Keep the active row scrolled into view within the rail itself.
  useEffect(() => {
    if (!active || !navRef.current) return;
    const link = navRef.current.querySelector(`a[href="#${active}"]`);
    link?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <nav
      ref={navRef}
      aria-label="Releases"
      className="no-scrollbar sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-tertiary)]">
        Releases
      </p>
      <ul className="mt-3 border-l border-[var(--divide)]">
        {items.map((item) => {
          const isActive = active === item.anchor;
          return (
            <li key={item.anchor}>
              <a
                href={`#${item.anchor}`}
                onClick={(event) => jumpTo(item.anchor, event)}
                aria-current={isActive ? "true" : undefined}
                className={`-ml-px flex items-baseline justify-between gap-2 border-l py-2 pl-3 pr-1 text-[12px] transition-colors ${
                  isActive
                    ? "border-[var(--accent-link)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
                }`}
              >
                <span className={`font-mono ${isActive ? "font-medium" : ""}`}>{item.version}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">{item.date}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
