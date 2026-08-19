// FILE: floatingBrowserPanel.logic.ts
// Purpose: Pure placement, resize, and visibility rules for the floating browser host.
// Layer: Chat surface UI logic

import { BROWSER_FLOATING_PANEL_MARGIN_PX } from "@synara/shared/browserSession";

export interface FloatingBrowserPanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FloatingBrowserPanelHostSize {
  width: number;
  height: number;
}

export interface FloatingBrowserPanelSize {
  width: number;
  height: number;
}

export type FloatingBrowserResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

export const FLOATING_BROWSER_PANEL_MARGIN_PX = BROWSER_FLOATING_PANEL_MARGIN_PX;
export const FLOATING_BROWSER_PANEL_DEFAULT_SIZE: FloatingBrowserPanelSize = {
  width: 320,
  height: 200,
};
export const FLOATING_BROWSER_PANEL_MIN_SIZE: FloatingBrowserPanelSize = {
  width: 320,
  height: 200,
};
export const FLOATING_BROWSER_PANEL_MAX_SIZE: FloatingBrowserPanelSize = {
  width: 760,
  height: 620,
};

interface FloatingBrowserPanelConstraints {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function resolveAxisConstraints(
  hostLength: number,
  minLength: number,
  maxLength: number,
): { min: number; max: number } {
  const availableLength = Math.max(1, hostLength - FLOATING_BROWSER_PANEL_MARGIN_PX * 2);
  const resolvedMin = Math.min(minLength, availableLength);
  return {
    min: resolvedMin,
    max: Math.max(resolvedMin, Math.min(maxLength, availableLength)),
  };
}

function resolveConstraints(
  host: FloatingBrowserPanelHostSize,
  minSize: FloatingBrowserPanelSize,
  maxSize: FloatingBrowserPanelSize,
): FloatingBrowserPanelConstraints {
  const width = resolveAxisConstraints(host.width, minSize.width, maxSize.width);
  const height = resolveAxisConstraints(host.height, minSize.height, maxSize.height);
  return {
    minWidth: width.min,
    maxWidth: width.max,
    minHeight: height.min,
    maxHeight: height.max,
  };
}

function resolveHostLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function clampFloatingBrowserPanelRect(
  rect: FloatingBrowserPanelRect,
  host: FloatingBrowserPanelHostSize,
  options: {
    minSize?: FloatingBrowserPanelSize;
    maxSize?: FloatingBrowserPanelSize;
  } = {},
): FloatingBrowserPanelRect {
  const hostWidth = resolveHostLength(host.width);
  const hostHeight = resolveHostLength(host.height);
  const constraints = resolveConstraints(
    { width: hostWidth, height: hostHeight },
    options.minSize ?? FLOATING_BROWSER_PANEL_MIN_SIZE,
    options.maxSize ?? FLOATING_BROWSER_PANEL_MAX_SIZE,
  );
  const width = clamp(rect.width, constraints.minWidth, constraints.maxWidth);
  const height = clamp(rect.height, constraints.minHeight, constraints.maxHeight);
  const maxLeft = Math.max(0, hostWidth - FLOATING_BROWSER_PANEL_MARGIN_PX - width);
  const maxTop = Math.max(0, hostHeight - FLOATING_BROWSER_PANEL_MARGIN_PX - height);

  return {
    left: clamp(rect.left, Math.min(FLOATING_BROWSER_PANEL_MARGIN_PX, maxLeft), maxLeft),
    top: clamp(rect.top, Math.min(FLOATING_BROWSER_PANEL_MARGIN_PX, maxTop), maxTop),
    width,
    height,
  };
}

export function initialFloatingBrowserPanelRect(
  host: FloatingBrowserPanelHostSize,
  options: {
    defaultSize?: FloatingBrowserPanelSize;
    minSize?: FloatingBrowserPanelSize;
    maxSize?: FloatingBrowserPanelSize;
  } = {},
): FloatingBrowserPanelRect {
  const hostWidth = resolveHostLength(host.width);
  const hostHeight = resolveHostLength(host.height);
  const defaultSize = options.defaultSize ?? FLOATING_BROWSER_PANEL_DEFAULT_SIZE;
  const width = defaultSize.width;
  const height = defaultSize.height;
  return clampFloatingBrowserPanelRect(
    {
      left: hostWidth - FLOATING_BROWSER_PANEL_MARGIN_PX - width,
      top: hostHeight - FLOATING_BROWSER_PANEL_MARGIN_PX - height,
      width,
      height,
    },
    { width: hostWidth, height: hostHeight },
    options,
  );
}

export function moveFloatingBrowserPanelRect(
  rect: FloatingBrowserPanelRect,
  delta: { x: number; y: number },
  host: FloatingBrowserPanelHostSize,
  options: {
    minSize?: FloatingBrowserPanelSize;
    maxSize?: FloatingBrowserPanelSize;
  } = {},
): FloatingBrowserPanelRect {
  return clampFloatingBrowserPanelRect(
    { ...rect, left: rect.left + delta.x, top: rect.top + delta.y },
    host,
    options,
  );
}

export function resizeFloatingBrowserPanelRect(
  rect: FloatingBrowserPanelRect,
  input: {
    edge: FloatingBrowserResizeEdge;
    deltaX: number;
    deltaY: number;
  },
  host: FloatingBrowserPanelHostSize,
  options: {
    minSize?: FloatingBrowserPanelSize;
    maxSize?: FloatingBrowserPanelSize;
  } = {},
): FloatingBrowserPanelRect {
  const clampedRect = clampFloatingBrowserPanelRect(rect, host, options);
  const constraints = resolveConstraints(
    {
      width: resolveHostLength(host.width),
      height: resolveHostLength(host.height),
    },
    options.minSize ?? FLOATING_BROWSER_PANEL_MIN_SIZE,
    options.maxSize ?? FLOATING_BROWSER_PANEL_MAX_SIZE,
  );
  const next = { ...clampedRect };
  const resizeWest = input.edge.includes("w");
  const resizeNorth = input.edge.includes("n");

  if (resizeWest) {
    next.width = clamp(
      clampedRect.width - input.deltaX,
      constraints.minWidth,
      constraints.maxWidth,
    );
    next.left = clampedRect.left + clampedRect.width - next.width;
  } else if (input.edge.includes("e")) {
    next.width = clamp(
      clampedRect.width + input.deltaX,
      constraints.minWidth,
      constraints.maxWidth,
    );
  }

  if (resizeNorth) {
    next.height = clamp(
      clampedRect.height - input.deltaY,
      constraints.minHeight,
      constraints.maxHeight,
    );
    next.top = clampedRect.top + clampedRect.height - next.height;
  } else if (input.edge.includes("s")) {
    next.height = clamp(
      clampedRect.height + input.deltaY,
      constraints.minHeight,
      constraints.maxHeight,
    );
  }

  return clampFloatingBrowserPanelRect(next, host, options);
}

export function floatingBrowserResizeCursor(edge: FloatingBrowserResizeEdge): string {
  if (edge === "n" || edge === "s") return "ns-resize";
  if (edge === "e" || edge === "w") return "ew-resize";
  if (edge === "ne" || edge === "sw") return "nesw-resize";
  return "nwse-resize";
}

export const FLOATING_BROWSER_DRAG_THRESHOLD_PX = 4;

export function isFloatingBrowserDragGesture(
  delta: { x: number; y: number },
  thresholdPx = FLOATING_BROWSER_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(delta.x, delta.y) >= thresholdPx;
}

// Keep this decision shared by single and split surfaces so a stale request can never
// reappear over another thread or duplicate a browser that is already docked and visible.
export function shouldRenderFloatingBrowserPanel(input: {
  hostThreadId: string | null;
  floatingThreadId: string | null;
  dockBrowserVisible: boolean;
  isFocused?: boolean;
}): boolean {
  return (
    input.hostThreadId !== null &&
    input.hostThreadId === input.floatingThreadId &&
    input.dockBrowserVisible === false &&
    input.isFocused !== false
  );
}
