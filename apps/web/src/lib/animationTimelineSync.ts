// FILE: animationTimelineSync.ts
// Purpose: Pin always-on CSS animations to the document timeline origin so every instance
//          steps in the same frame.
// Layer: Web UI animation utility
// Exports: syncAnimationsToTimelineOrigin, useTimelineSynchronizedAnimations
// Why: Independently mounted stepped spinners otherwise advance at different moments.
//      Aligning their phases reduces separate repaint opportunities on the blurred sidebar.
//      The earlier Chromium probe measured GPU-process CPU, not hardware GPU utilization.

import { useLayoutEffect, type RefObject } from "react";

/**
 * Restart every animation on `element` from the document timeline origin. The animation's
 * period is unchanged, so two instances with the same keyframes and duration are in phase
 * from then on. Safe to call on elements without animations (reduced motion, not yet
 * styled) and in environments without the Web Animations API.
 */
export function syncAnimationsToTimelineOrigin(element: Element | null): void {
  if (!element || typeof element.getAnimations !== "function") {
    return;
  }
  for (const animation of element.getAnimations()) {
    try {
      animation.startTime = 0;
    } catch {
      // A detached or already-finished animation cannot be re-timed; leave it alone.
    }
  }
}

/** Synchronize the animations of the referenced element once it is mounted. */
export function useTimelineSynchronizedAnimations(ref: RefObject<Element | null>): void {
  useLayoutEffect(() => {
    syncAnimationsToTimelineOrigin(ref.current);
  }, [ref]);
}
