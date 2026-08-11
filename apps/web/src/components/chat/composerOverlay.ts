// FILE: composerOverlay.ts
// Purpose: Geometry for the floating composer — the transcript scrolls *under* the
//   frosted composer, so its measured height becomes the transcript's bottom content inset.
// Layer: Chat composer layout helper
// Exports: useComposerOverlayHeight (measure), composerTranscriptBottomInsetPx (derive inset)
//
// The composer is absolutely positioned at `bottom-full` of the in-flow block that
// carries the trailing gutter (and the git BranchToolbar), so the transcript's scroll
// viewport ends exactly at the composer's BOTTOM edge. Content stays fully painted
// while it scrolls behind the glass (the frosted surface is what dims and blurs it);
// a viewport mask only dissolves it in a short band just above the composer's footer
// row, so nothing ever shows behind the send controls or the padding strip below.

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

/**
 * Transcript content is fully dissolved this far above the composer's bottom edge,
 * keeping the footer row (attach, access mode, model picker, send) clear of any
 * content scrolling underneath — only the editor region reveals the transcript.
 */
export const COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX = 52;

export function composerOverlayBottomClearancePx(
  surfaceBottomPx: number,
  footerTopPx: number,
): number {
  return Math.max(
    COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX,
    Math.ceil(Math.max(0, surfaceBottomPx - footerTopPx)),
  );
}

/**
 * Height of the dissolve band above the footer clearance. Content scrolling behind
 * the glass stays fully painted (blurred and tinted by the surface) until it reaches
 * this band, then fades out before the footer row.
 */
export const COMPOSER_OVERLAY_MASK_FADE_PX = 40;

/**
 * Mask for the transcript scroll viewport while the composer floats over it:
 * opaque through the composer's editor region — the frosted surface, not the mask,
 * is what obscures content there — then dissolving to fully transparent
 * `COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX` above the composer's bottom edge (which is
 * also the viewport's bottom edge). Derived from the same bottom inset the viewport
 * uses for padding so both always track the measured composer height together.
 */
export function composerOverlayScrollMaskImage(
  bottomInsetPx: number,
  bottomClearancePx = COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX,
): string | null {
  if (bottomInsetPx <= 0) return null;
  const overlayHeightPx = Math.max(0, Math.round(bottomInsetPx) + COMPOSER_OVERLAY_TUCK_PX);

  const fadeEndPx = Math.min(
    overlayHeightPx,
    Math.max(COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX, Math.round(bottomClearancePx)),
  );
  const fadeStartPx = Math.min(overlayHeightPx, fadeEndPx + COMPOSER_OVERLAY_MASK_FADE_PX);
  return `linear-gradient(to bottom, #000 calc(100% - ${fadeStartPx}px), transparent calc(100% - ${fadeEndPx}px))`;
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
  overlayBottomClearancePx: number;
} {
  const [measurement, setMeasurement] = useState({
    overlayHeightPx: 0,
    overlayBottomClearancePx: COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX,
  });
  const observerRef = useRef<ResizeObserver | null>(null);
  const overlayRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      setMeasurement({
        overlayHeightPx: 0,
        overlayBottomClearancePx: COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX,
      });
      return;
    }
    const commit = (height: number) => {
      const footer = node.querySelector<HTMLElement>("[data-chat-composer-footer]");
      const surface = footer?.closest<HTMLElement>(".chat-composer-surface");
      const overlayBottomClearancePx =
        footer && surface
          ? composerOverlayBottomClearancePx(
              surface.getBoundingClientRect().bottom,
              footer.getBoundingClientRect().top,
            )
          : COMPOSER_OVERLAY_BOTTOM_CLEARANCE_PX;
      const next = {
        overlayHeightPx: Math.round(height),
        overlayBottomClearancePx,
      };
      setMeasurement((current) =>
        current.overlayHeightPx === next.overlayHeightPx &&
        current.overlayBottomClearancePx === next.overlayBottomClearancePx
          ? current
          : next,
      );
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
  return { overlayRef, ...measurement };
}
