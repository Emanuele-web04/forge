// FILE: useTimelineRowOverlapGuard.ts
// Purpose: Pre-paint correction for LegendList's one-frame row overlap. The
//          list positions each row's container absolutely from its size model,
//          but on web the model→DOM write goes through a default-priority React
//          update that flushes in a macrotask — after the frame in which a row
//          changed height has already painted. Every frame where a row grows
//          (streaming text, tool calls landing, the 220ms disclosure animation)
//          therefore paints with the rows below still at stale offsets, drawn
//          on top of the grown row. This hook closes that window: a
//          ResizeObserver fires in the same frame as the height change but
//          before paint, and pushes the stale containers down with direct
//          style writes. LegendList's own commit lands next frame with the
//          same cumulative positions, so the manual writes are transient and
//          never fight the list's model.
// Layer: React hooks (chat timeline)

import { useCallback, useEffect, useRef } from "react";

// LegendList parks recycled containers at top: -10000000; anything that far up
// is not part of the visible layout.
const OUT_OF_VIEW_THRESHOLD_PX = -100_000;
// Sub-pixel rounding between the list's integer size model and border-box
// measurement; intrusions this small are not visible.
const OVERLAP_EPSILON_PX = 1;
// A row's positioned container is expected within a few wrappers; walking to
// the document root would mean the row is not inside a LegendList container.
const MAX_CONTAINER_ANCESTOR_DEPTH = 8;

/**
 * Finds the LegendList container that positions this row: the nearest ancestor
 * with an inline `position: absolute` and an inline `top`. That shape is the
 * virtualizer's core placement contract, not a private detail.
 */
function resolvePositionedContainer(row: HTMLElement): HTMLElement | null {
  let candidate = row.parentElement;
  for (let depth = 0; candidate && depth < MAX_CONTAINER_ANCESTOR_DEPTH; depth += 1) {
    if (candidate.style.position === "absolute" && candidate.style.top !== "") {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

/**
 * Observes timeline row elements and, whenever any row's size changes, pushes
 * the containers below a grown row down so no two rows paint on top of each
 * other. Only ever moves containers down: a transient gap (a row shrank and
 * the rows below catch up next frame) is invisible, while pulling rows up
 * would fight the list's deliberate deferred-shrink handling.
 *
 * Returns a ref callback to attach to every timeline row wrapper.
 */
export function useTimelineRowOverlapGuard(): (element: HTMLElement | null) => (() => void) | void {
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRowsRef = useRef(new Set<HTMLElement>());

  const closeOverlaps = useCallback((entries?: readonly ResizeObserverEntry[]) => {
    // Inline-style reads only — no forced layout yet.
    const containerTops = new Map<HTMLElement, number>();
    for (const row of observedRowsRef.current) {
      if (!row.isConnected) {
        continue;
      }
      const container = resolvePositionedContainer(row);
      if (!container || containerTops.has(container)) {
        continue;
      }
      const top = Number.parseFloat(container.style.top);
      if (!Number.isFinite(top) || top < OUT_OF_VIEW_THRESHOLD_PX) {
        continue;
      }
      containerTops.set(container, top);
    }
    if (containerTops.size < 2) {
      return;
    }

    // Fast path: while text streams, the only row changing size each frame is
    // the growing tail. A resize confined to the single bottom-most placed
    // container cannot intrude on anything (nothing is placed below it, and
    // this guard only ever pushes rows down), so the measurement pass — the
    // one getBoundingClientRect per frame — is skipped entirely.
    if (entries !== undefined) {
      let maxTop = Number.NEGATIVE_INFINITY;
      let maxTopCount = 0;
      for (const top of containerTops.values()) {
        if (top > maxTop) {
          maxTop = top;
          maxTopCount = 1;
        } else if (top === maxTop) {
          maxTopCount += 1;
        }
      }
      if (maxTopCount === 1) {
        let onlyBottomMostResized = true;
        for (const entry of entries) {
          const target = entry.target;
          if (!(target instanceof HTMLElement) || !target.isConnected) {
            continue;
          }
          const container = resolvePositionedContainer(target);
          // Rows outside a placed container (parked/recycled) can't intrude
          // on the visible layout — same as being dropped from `placed` below.
          if (!container) {
            continue;
          }
          const top = containerTops.get(container);
          if (top === undefined) {
            continue;
          }
          if (top !== maxTop) {
            onlyBottomMostResized = false;
            break;
          }
        }
        if (onlyBottomMostResized) {
          return;
        }
      }
    }

    const placed: { container: HTMLElement; top: number; height: number }[] = [];
    for (const [container, top] of containerTops) {
      const height = container.getBoundingClientRect().height;
      if (height <= 0) {
        continue;
      }
      placed.push({ container, top, height });
    }
    placed.sort((left, right) => left.top - right.top);

    for (let index = 1; index < placed.length; index += 1) {
      const previous = placed[index - 1]!;
      const current = placed[index]!;
      const minTop = previous.top + previous.height;
      if (current.top < minTop - OVERLAP_EPSILON_PX) {
        current.top = minTop;
        current.container.style.top = `${minTop}px`;
      }
    }
  }, []);

  useEffect(() => {
    const observedRows = observedRowsRef.current;
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRows.clear();
    };
  }, []);

  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) {
        return;
      }
      // ResizeObserver callbacks run after layout but before paint, so the
      // correction below lands in the same frame as the size change.
      observerRef.current ??= new ResizeObserver(closeOverlaps);
      const observer = observerRef.current;
      observer.observe(element);
      observedRowsRef.current.add(element);
      return () => {
        observer.unobserve(element);
        observedRowsRef.current.delete(element);
      };
    },
    [closeOverlaps],
  );
}
