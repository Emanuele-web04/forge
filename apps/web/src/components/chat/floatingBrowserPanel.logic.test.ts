import { describe, expect, it } from "vitest";

import {
  clampFloatingBrowserPanelRect,
  initialFloatingBrowserPanelRect,
  moveFloatingBrowserPanelRect,
  resizeFloatingBrowserPanelRect,
  shouldRenderFloatingBrowserPanel,
  isFloatingBrowserDragGesture,
} from "./floatingBrowserPanel.logic";

describe("floating browser panel geometry", () => {
  it("starts compact in the bottom-right of its host", () => {
    expect(initialFloatingBrowserPanelRect({ width: 1_000, height: 700 })).toEqual({
      left: 668,
      top: 488,
      width: 320,
      height: 200,
    });
  });

  it("clamps movement and size inside a small host", () => {
    expect(
      clampFloatingBrowserPanelRect(
        { left: -100, top: 900, width: 900, height: 900 },
        { width: 400, height: 300 },
      ),
    ).toEqual({ left: 12, top: 53, width: 376, height: 235 });

    expect(
      moveFloatingBrowserPanelRect(
        { left: 100, top: 100, width: 480, height: 340 },
        { x: 2_000, y: 2_000 },
        { width: 1_000, height: 700 },
      ),
    ).toEqual({ left: 508, top: 388, width: 480, height: 300 });
  });

  it("keeps the opposite corner fixed when north-west resizing hits minimum size", () => {
    const resized = resizeFloatingBrowserPanelRect(
      { left: 200, top: 180, width: 480, height: 340 },
      { edge: "nw", deltaX: 1_000, deltaY: 1_000 },
      { width: 1_000, height: 700 },
    );

    expect(resized).toEqual({ left: 360, top: 280, width: 320, height: 200 });
    expect(resized.left + resized.width).toBe(680);
    expect(resized.top + resized.height).toBe(480);
  });

  it("caps south-east resizing at the host and the 1280×800 guest aspect", () => {
    expect(
      resizeFloatingBrowserPanelRect(
        { left: 16, top: 16, width: 480, height: 300 },
        { edge: "se", deltaX: 2_000, deltaY: 2_000 },
        { width: 1_000, height: 700 },
      ),
    ).toEqual({ left: 16, top: 16, width: 760, height: 475 });
  });

  it("keeps the frozen guest aspect when stretching one edge", () => {
    expect(
      resizeFloatingBrowserPanelRect(
        { left: 40, top: 40, width: 320, height: 200 },
        { edge: "s", deltaX: 0, deltaY: 120 },
        { width: 1_000, height: 700 },
      ),
    ).toEqual({ left: 40, top: 40, width: 512, height: 320 });
  });
});

describe("floating browser panel visibility", () => {
  const matchingInput = {
    hostThreadId: "thread-a",
    floatingThreadId: "thread-a",
    dockBrowserVisible: false,
  } as const;

  it("renders only for the matching focused thread without a visible dock browser", () => {
    expect(shouldRenderFloatingBrowserPanel(matchingInput)).toBe(true);
    expect(
      shouldRenderFloatingBrowserPanel({ ...matchingInput, floatingThreadId: "thread-b" }),
    ).toBe(false);
    expect(shouldRenderFloatingBrowserPanel({ ...matchingInput, dockBrowserVisible: true })).toBe(
      false,
    );
    expect(shouldRenderFloatingBrowserPanel({ ...matchingInput, isFocused: false })).toBe(false);
  });

  it("restores the card once a matching dock browser is no longer visible", () => {
    expect(shouldRenderFloatingBrowserPanel({ ...matchingInput, dockBrowserVisible: true })).toBe(
      false,
    );
    expect(shouldRenderFloatingBrowserPanel({ ...matchingInput, dockBrowserVisible: false })).toBe(
      true,
    );
  });
});

describe("floating browser drag gesture", () => {
  it("ignores small pointer jitter and treats larger movement as a drag", () => {
    expect(isFloatingBrowserDragGesture({ x: 2, y: 2 })).toBe(false);
    expect(isFloatingBrowserDragGesture({ x: 4, y: 0 })).toBe(true);
  });
});
