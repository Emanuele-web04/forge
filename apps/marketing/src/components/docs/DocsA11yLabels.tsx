"use client";

import { useEffect } from "react";

/**
 * Minimal docs-page accessibility augmentation.
 *
 * Two fumadocs rendering gaps are patched here (no CSS-only fix exists for either):
 *
 * 1. GFM task lists (remark-gfm, e.g. the checklist in /docs/workflows/studio) render as
 *    `<input type="checkbox" disabled>` inside `li.task-list-item` with no accessible name.
 *    Axe flags all of them (region/checkbox naming). We label each one.
 * 2. Fumadocs code blocks wrap `<pre>` in a scrollable `div[role="region"][tabindex="0"]`
 *    (`.fd-scroll-container`) with no accessible name. We label those regions — but only the
 *    ones that actually contain a `<pre>`, so table/other scroll regions are not mislabeled.
 *
 * Labels are numbered per label type ("Code block 1", "Checklist item 1", ...) so pages with
 * several code blocks or task lists keep unique accessible names (axe landmark-unique).
 */
export function DocsA11yLabels() {
  useEffect(() => {
    const apply = () => {
      let checklistCount = 0;
      for (const input of document.querySelectorAll<HTMLInputElement>(
        '.task-list-item input[type="checkbox"]',
      )) {
        checklistCount += 1;
        if (!input.hasAttribute("aria-label")) {
          input.setAttribute("aria-label", `Checklist item ${checklistCount}`);
        }
      }
      let codeBlockCount = 0;
      for (const region of document.querySelectorAll<HTMLElement>(".fd-scroll-container")) {
        if (!region.querySelector("pre")) continue;
        codeBlockCount += 1;
        if (!region.hasAttribute("aria-label")) {
          region.setAttribute("aria-label", `Code block ${codeBlockCount}`);
        }
      }
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
