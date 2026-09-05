// FILE: lib/scrollToAnchor.ts
// Purpose: The one reduced-motion-aware smooth anchor jump used by every in-page
//          nav (changelog rail + picker, homepage rail), so the scroll feel and
//          the URL-hash bookkeeping stay identical across the site.
// Layer: Client helper.

"use client";

/**
 * Scrolls to the element with id `anchor` — smoothly, or instantly under
 * `prefers-reduced-motion` — and syncs the URL hash without adding a history
 * entry. Pass the click event to suppress the browser's default instant jump.
 *
 * Returns `false` when no such element exists, leaving the event untouched so a
 * native anchor jump can still handle it.
 */
export function scrollToAnchor(anchor: string, event?: { preventDefault: () => void }): boolean {
  const target = document.getElementById(anchor);
  if (!target) return false;
  event?.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "start",
  });
  history.replaceState(null, "", `#${anchor}`);
  return true;
}
