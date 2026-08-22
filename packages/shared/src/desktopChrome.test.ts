import { describe, expect, it } from "vitest";

import {
  MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
  resolveDesktopDipRectFromCssRect,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "./desktopChrome";

describe("resolveMacDesktopTopBarTrafficLightGutterCssPx", () => {
  it("returns the base gutter at zoom 1", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(1)).toBe(
      MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
    );
  });

  it("inverse-scales the gutter as zoom increases", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(1.1)).toBe(82);
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(2)).toBe(45);
  });

  it("inverse-scales the gutter as zoom decreases", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(0.8)).toBe(113);
  });

  it("falls back to zoom 1 for invalid factors", () => {
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(0)).toBe(
      MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
    );
    expect(resolveMacDesktopTopBarTrafficLightGutterCssPx(Number.NaN)).toBe(
      MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
    );
  });
});

describe("resolveDesktopDipRectFromCssRect", () => {
  const rect = { x: 320, y: 46, width: 800, height: 600 };

  it("passes the rect through untouched at zoom 1", () => {
    expect(resolveDesktopDipRectFromCssRect(rect, 1)).toEqual(rect);
  });

  it("grows the DIP rect when the shell is zoomed in", () => {
    expect(resolveDesktopDipRectFromCssRect(rect, 2)).toEqual({
      x: 640,
      y: 92,
      width: 1600,
      height: 1200,
    });
  });

  it("shrinks the DIP rect when the shell is zoomed out", () => {
    // The regression this guards: a zoomed-out shell measures a slot wider in CSS px
    // than it physically occupies, so an unconverted rect overflowed the panel.
    expect(resolveDesktopDipRectFromCssRect(rect, 0.5)).toEqual({
      x: 160,
      y: 23,
      width: 400,
      height: 300,
    });
  });

  it("falls back to zoom 1 for invalid factors", () => {
    expect(resolveDesktopDipRectFromCssRect(rect, 0)).toEqual(rect);
    expect(resolveDesktopDipRectFromCssRect(rect, Number.NaN)).toEqual(rect);
  });
});
