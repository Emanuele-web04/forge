// FILE: composerOverlay.ts
// Purpose: Geometry for the floating composer — the transcript scrolls *under* the
//   frosted composer, so its measured height becomes the transcript's bottom content inset.
// Layer: Chat composer layout helper
// Exports: useComposerOverlayHeight (measure), composerTranscriptBottomInsetPx (derive inset)
//
// The composer is absolutely positioned at `bottom-full` of the in-flow block that
// carries the trailing gutter (and the git BranchToolbar), so the transcript's scroll
// viewport ends exactly at the composer's BOTTOM edge: content dissolves behind the
// glass and is clipped there, never appearing in the padding strip below it.

import { useCallback, useRef, useState } from "react";

/**
 * How far transcript content tucks under the composer's top edge at rest.
 * Mirrors the `-mt-5` overlap the in-flow composer used to have, so the resting
 * gap between the last row and the composer is unchanged — but now those 20px are
 * real content sliding behind the glass instead of a solid backing.
 */
export const COMPOSER_OVERLAY_TUCK_PX = 20;

/**
 * Bottom content inset for the transcript given the measured composer overlay height.
 * Keep this the single conversion: the pane and the timeline must agree on it exactly,
 * or rows either hide behind the composer or float above a gap.
 */
export function composerTranscriptBottomInsetPx(overlayHeightPx: number): number {
  return Math.max(0, Math.round(overlayHeightPx) - COMPOSER_OVERLAY_TUCK_PX);
}

/** Gap between the composer's top edge and floating transcript affordances. */
const COMPOSER_OVERLAY_AFFORDANCE_GAP_PX = 8;

/**
 * Bottom offset for affordances that must float clear of the composer (the
 * scroll-to-bottom arrow). Derived from the same inset so it tracks composer growth.
 */
export function composerOverlayAffordanceBottomPx(bottomInsetPx: number): number {
  return bottomInsetPx + COMPOSER_OVERLAY_TUCK_PX + COMPOSER_OVERLAY_AFFORDANCE_GAP_PX;
}

/**
 * Measures the composer overlay's border box. Rounded to whole pixels and only
 * committed on change, so a resize that settles on the same height never re-renders
 * the transcript (the composer resizes on every wrap of typed text).
 */
export function useComposerOverlayHeight(): {
  overlayRef: (node: HTMLElement | null) => void;
  overlayHeightPx: number;
} {
  const [overlayHeightPx, setOverlayHeightPx] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const overlayRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      setOverlayHeightPx(0);
      return;
    }
    const commit = (height: number) => {
      const next = Math.round(height);
      setOverlayHeightPx((current) => (current === next ? current : next));
    };
    commit(node.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        commit(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      }
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  return { overlayRef, overlayHeightPx };
}
