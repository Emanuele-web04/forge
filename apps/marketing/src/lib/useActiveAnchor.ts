// FILE: lib/useActiveAnchor.ts
// Purpose: Shared changelog navigation behavior — scroll-spies which release
//          section is in view AND jumps to a release on demand. Both the
//          right-rail (ChangelogNav) and the mobile dropdown (ChangelogPicker)
//          consume this so the IntersectionObserver wiring and the smooth,
//          reduced-motion-aware anchor jump live in exactly one place.
// Layer: Client hook.

"use client";

import { useCallback, useEffect, useState } from "react";
import { scrollToAnchor } from "@/lib/scrollToAnchor";

export interface ChangelogNavItem {
  readonly version: string;
  readonly date: string;
  readonly anchor: string;
}

/**
 * Tracks the release whose section is near the top of the viewport (`active`)
 * and returns `jumpTo`, which scrolls to a release, syncs the URL hash, and
 * marks it active — honoring `prefers-reduced-motion`. Pass the click event to
 * `jumpTo` to suppress the default anchor jump; omit it (e.g. from a `<select>`)
 * and only the programmatic scroll runs.
 *
 * `items` must be a stable reference (it is — the server page builds it once),
 * so the observer is wired up a single time.
 */
export function useActiveAnchor(items: readonly ChangelogNavItem[]) {
  const [active, setActive] = useState<string | null>(items[0]?.anchor ?? null);

  useEffect(() => {
    const sections = items
      .map((item) => document.getElementById(item.anchor))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-100px 0px -66% 0px", threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  const jumpTo = useCallback((anchor: string, event?: { preventDefault: () => void }) => {
    // Missing section — leave the event alone and let the native jump handle it.
    if (scrollToAnchor(anchor, event)) setActive(anchor);
  }, []);

  return { active, jumpTo };
}
