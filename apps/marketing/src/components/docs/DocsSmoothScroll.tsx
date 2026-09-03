// FILE: docs/DocsSmoothScroll.tsx
// Purpose: Gives every in-page anchor on the docs pages the same smooth jump the
//          homepage and changelog rails use.
// Layer: Client component (behavior only; renders nothing).

"use client";

import { useEffect } from "react";
import { scrollToAnchor } from "@/lib/scrollToAnchor";

/**
 * Docs pages carry three separate sets of `#` links — the "On this page" table of
 * contents, the heading permalinks, and hand-written links in the MDX body — all
 * rendered by fumadocs rather than by us. Rather than override three components,
 * one delegated listener upgrades every one of them at once, and keeps working
 * for any `#` link a future doc adds.
 *
 * Only the click path is intercepted, so fumadocs' own scrolling (restoring
 * position across routes, nudging the active TOC entry into view) is untouched —
 * which a global `scroll-behavior: smooth` would not have left alone.
 */
export function DocsSmoothScroll() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // Anything but a plain left-click keeps native behavior: a modifier click
      // opens the link in a new tab, where scrolling this page would be wrong.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      const link = target instanceof Element ? target.closest("a") : null;
      if (!link || link.target === "_blank") return;

      const href = link.getAttribute("href");
      if (!href || !href.startsWith("#") || href.length === 1) return;

      // Heading slugs are written raw in the markup but may arrive percent-encoded
      // in the href; fall back to the raw value if the escape sequence is broken.
      const raw = href.slice(1);
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        id = raw;
      }

      // Unknown id — leave the event alone so the browser's own jump still runs.
      scrollToAnchor(id, event);
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
