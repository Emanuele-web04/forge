export const DIFF_RENDER_SURFACE_SELECTOR = ".diff-render-surface";
export const DIFF_FILE_ANCHOR_SELECTOR = "[data-diff-file-path]";

export interface DiffFileAnchor {
  path: string;
  element: HTMLElement;
}

export function resolveDiffRenderSurface(viewport: HTMLElement | null): HTMLElement | null {
  if (!viewport) {
    return null;
  }
  return viewport.querySelector<HTMLElement>(DIFF_RENDER_SURFACE_SELECTOR);
}

export function readDiffFileAnchors(root: HTMLElement | null): DiffFileAnchor[] {
  if (!root) {
    return [];
  }
  const anchors: DiffFileAnchor[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(DIFF_FILE_ANCHOR_SELECTOR)) {
    const path = element.dataset.diffFilePath;
    if (path) {
      anchors.push({ path, element });
    }
  }
  return anchors;
}

/**
 * Index of the last position whose value is at or below `threshold`, or -1 when
 * none is. Values must be non-decreasing by index; each is read at most
 * O(log n) times, so callers can back it with layout reads.
 */
export function findLastIndexAtOrBelow(
  length: number,
  threshold: number,
  readValue: (index: number) => number,
): number {
  let low = 0;
  let high = length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (readValue(middle) <= threshold) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function findDiffFileAnchor(
  viewport: HTMLElement | null,
  filePath: string,
): HTMLElement | null {
  return readDiffFileAnchors(viewport).find((anchor) => anchor.path === filePath)?.element ?? null;
}

export function scrollDiffFileIntoView(
  viewport: HTMLElement | null,
  filePath: string,
  block: ScrollLogicalPosition,
): boolean {
  const anchor = findDiffFileAnchor(viewport, filePath);
  if (!anchor) {
    return false;
  }
  anchor.scrollIntoView({ block });
  return true;
}
