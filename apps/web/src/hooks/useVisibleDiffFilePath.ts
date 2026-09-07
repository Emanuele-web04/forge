import { useEffect, useState, type RefObject } from "react";

import {
  findLastIndexAtOrBelow,
  readDiffFileAnchors,
  resolveDiffRenderSurface,
} from "../lib/diffScrollSurface";

const VISIBLE_DIFF_FILE_TOLERANCE_PX = 8;

export function resolveVisibleDiffFilePath(surface: HTMLElement): string | null {
  const anchors = readDiffFileAnchors(surface);
  if (anchors.length === 0) {
    return null;
  }
  // Anchors stack vertically in DOM order, so the file under the viewport top
  // is found by binary search with O(log n) layout reads per scroll frame
  // instead of measuring every file.
  const surfaceTop = surface.getBoundingClientRect().top - surface.scrollTop;
  const threshold = surface.scrollTop + VISIBLE_DIFF_FILE_TOLERANCE_PX;
  const index = findLastIndexAtOrBelow(
    anchors.length,
    threshold,
    (candidate) => (anchors[candidate]?.element.getBoundingClientRect().top ?? 0) - surfaceTop,
  );
  return anchors[Math.max(index, 0)]?.path ?? null;
}

export function useVisibleDiffFilePath(
  viewportRef: RefObject<HTMLElement | null>,
  contentKey: unknown,
): string | null {
  const [visibleFilePath, setVisibleFilePath] = useState<string | null>(null);

  useEffect(() => {
    const surface = resolveDiffRenderSurface(viewportRef.current);
    if (!surface) {
      setVisibleFilePath(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      if (surface.clientHeight === 0) {
        return;
      }
      const nextPath = resolveVisibleDiffFilePath(surface);
      setVisibleFilePath((previous) => (previous === nextPath ? previous : nextPath));
    };
    const schedule = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    surface.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface);
    for (const anchor of readDiffFileAnchors(surface)) {
      resizeObserver.observe(anchor.element);
    }

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      surface.removeEventListener("scroll", schedule);
      resizeObserver.disconnect();
    };
  }, [contentKey, viewportRef]);

  return visibleFilePath;
}
