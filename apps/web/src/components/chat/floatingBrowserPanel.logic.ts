// FILE: floatingBrowserPanel.logic.ts
// Purpose: Pure placement, resize, and visibility rules for the floating browser host.
// Layer: Chat surface UI logic

import {
  BROWSER_AUTOMATION_VIEWPORT_HEIGHT,
  BROWSER_AUTOMATION_VIEWPORT_WIDTH,
  BROWSER_FLOATING_PANEL_MARGIN_PX,
} from "@synara/shared/browserSession";

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
export const FLOATING_BROWSER_PANEL_ASPECT_RATIO =
  BROWSER_AUTOMATION_VIEWPORT_WIDTH / BROWSER_AUTOMATION_VIEWPORT_HEIGHT;
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
  height: 475,
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

function heightForGuestWidth(width: number): number {
  return Math.max(
    1,
    Math.round((width * BROWSER_AUTOMATION_VIEWPORT_HEIGHT) / BROWSER_AUTOMATION_VIEWPORT_WIDTH),
  );
}

function widthForGuestHeight(height: number): number {
  return Math.max(
    1,
    Math.round((height * BROWSER_AUTOMATION_VIEWPORT_WIDTH) / BROWSER_AUTOMATION_VIEWPORT_HEIGHT),
  );
}

function hugGuestAspectSize(
  preferred: FloatingBrowserPanelSize,
  constraints: FloatingBrowserPanelConstraints,
  lock: "width" | "height" | "auto" = "auto",
): FloatingBrowserPanelSize {
  const fitFromWidth = (width: number): FloatingBrowserPanelSize => {
    const nextWidth = clamp(width, constraints.minWidth, constraints.maxWidth);
    let nextHeight = heightForGuestWidth(nextWidth);
    if (nextHeight < constraints.minHeight || nextHeight > constraints.maxHeight) {
      nextHeight = clamp(nextHeight, constraints.minHeight, constraints.maxHeight);
      return {
        width: clamp(widthForGuestHeight(nextHeight), constraints.minWidth, constraints.maxWidth),
        height: nextHeight,
      };
    }
    return { width: nextWidth, height: nextHeight };
  };
  const fitFromHeight = (height: number): FloatingBrowserPanelSize => {
    const nextHeight = clamp(height, constraints.minHeight, constraints.maxHeight);
    let nextWidth = widthForGuestHeight(nextHeight);
    if (nextWidth < constraints.minWidth || nextWidth > constraints.maxWidth) {
      nextWidth = clamp(nextWidth, constraints.minWidth, constraints.maxWidth);
      return { width: nextWidth, height: heightForGuestWidth(nextWidth) };
    }
    return { width: nextWidth, height: nextHeight };
  };

  if (lock === "width") {
    return fitFromWidth(preferred.width);
  }
  if (lock === "height") {
    return fitFromHeight(preferred.height);
  }

  const widthLimited = fitFromWidth(Math.min(preferred.width, constraints.maxWidth));
  if (widthLimited.height <= Math.min(preferred.height, constraints.maxHeight)) {
    return widthLimited;
  }
  return fitFromHeight(Math.min(preferred.height, constraints.maxHeight));
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
  const hugged = hugGuestAspectSize(
    {
      width: clamp(rect.width, constraints.minWidth, constraints.maxWidth),
      height: clamp(rect.height, constraints.minHeight, constraints.maxHeight),
    },
    constraints,
  );
  const width = hugged.width;
  const height = hugged.height;
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
  const resizeEast = input.edge.includes("e");
  const resizeSouth = input.edge.includes("s");
  const proposedWidth = resizeWest
    ? clampedRect.width - input.deltaX
    : resizeEast
      ? clampedRect.width + input.deltaX
      : clampedRect.width;
  const proposedHeight = resizeNorth
    ? clampedRect.height - input.deltaY
    : resizeSouth
      ? clampedRect.height + input.deltaY
      : clampedRect.height;
  const lock: "width" | "height" =
    resizeEast || resizeWest
      ? resizeNorth || resizeSouth
        ? Math.abs(proposedWidth / FLOATING_BROWSER_PANEL_ASPECT_RATIO - proposedHeight) <=
          Math.abs(widthForGuestHeight(proposedHeight) - proposedWidth)
          ? "width"
          : "height"
        : "width"
      : "height";
  const hugged = hugGuestAspectSize(
    { width: proposedWidth, height: proposedHeight },
    constraints,
    lock,
  );
  next.width = hugged.width;
  next.height = hugged.height;
  if (resizeWest) {
    next.left = clampedRect.left + clampedRect.width - next.width;
  }
  if (resizeNorth) {
    next.top = clampedRect.top + clampedRect.height - next.height;
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
  // Hide while a docked live browser is on screen, but do not treat that as
  // dismissing the request — collapsing the dock should restore the card.
  return (
    input.hostThreadId !== null &&
    input.hostThreadId === input.floatingThreadId &&
    input.dockBrowserVisible === false &&
    input.isFocused !== false
  );
}
