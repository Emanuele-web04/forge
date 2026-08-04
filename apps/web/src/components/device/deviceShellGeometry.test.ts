import { describe, expect, it } from "vitest";

import {
  DEVICE_SHELL_FALLBACK_POINT_SIZE,
  deviceShellClass,
  deviceShellRadiusValue,
  fitDeviceShellSize,
  resolveDeviceShellMetrics,
} from "./deviceShellGeometry";

/** Point sizes of the devices the pane actually has to frame. */
const IPHONE_17_PRO = { pointWidth: 402, pointHeight: 874 };
const IPHONE_SE = { pointWidth: 375, pointHeight: 667 };
const IPAD_PRO_11 = { pointWidth: 834, pointHeight: 1194 };

describe("deviceShellClass", () => {
  it("separates the three hardware shapes by point size and aspect", () => {
    expect(deviceShellClass(402, 874)).toBe("modern-phone");
    expect(deviceShellClass(440, 956)).toBe("modern-phone");
    expect(deviceShellClass(375, 667)).toBe("classic-phone");
    expect(deviceShellClass(834, 1194)).toBe("tablet");
    expect(deviceShellClass(744, 1133)).toBe("tablet");
  });

  it("classifies an iPad by width, not aspect", () => {
    // An 820x1180 iPad's 1.44 aspect is below the modern-phone threshold, so
    // the aspect check alone would call it a classic phone and hand it an
    // SE-sized chin. Width is what actually separates them.
    expect(deviceShellClass(820, 1180)).toBe("tablet");
  });
});

describe("resolveDeviceShellMetrics", () => {
  it("gives an edge-to-edge iPhone a Dynamic Island", () => {
    const metrics = resolveDeviceShellMetrics(IPHONE_17_PRO);
    expect(metrics.shellClass).toBe("modern-phone");
    expect(metrics.dynamicIsland).not.toBeNull();
    // 126pt of a 402pt-wide screen.
    expect(metrics.dynamicIsland?.edge).toBe("top");
    expect(metrics.dynamicIsland?.lengthPercent).toBeCloseTo(31.3, 1);
  });

  it("withholds the Dynamic Island from devices that have none", () => {
    expect(resolveDeviceShellMetrics(IPHONE_SE).dynamicIsland).toBeNull();
    expect(resolveDeviceShellMetrics(IPAD_PRO_11).dynamicIsland).toBeNull();
  });

  it("keeps the screen aspect exactly as the device reports it", () => {
    const metrics = resolveDeviceShellMetrics(IPHONE_17_PRO);
    expect(metrics.screenAspectRatio).toBeCloseTo(402 / 874, 6);
    // The chassis is wider *and* taller than the screen, so it is always the
    // squatter of the two; a chassis narrower than its screen would clip.
    expect(metrics.chassisAspectRatio).toBeGreaterThan(metrics.screenAspectRatio);
  });

  it("draws concentric corners: chassis radius exceeds screen radius by the bezel", () => {
    const metrics = resolveDeviceShellMetrics(IPHONE_17_PRO);
    // Compared in points rather than percent, since the two radii are expressed
    // against differently sized boxes.
    const chassisWidth = 402 * (1 + 0.028 * 2);
    const chassisRadiusPoints = (metrics.chassisRadius.xPercent / 100) * chassisWidth;
    const screenRadiusPoints = (metrics.screenRadius.xPercent / 100) * 402;
    expect(chassisRadiusPoints - screenRadiusPoints).toBeCloseTo(402 * 0.028, 4);
  });

  it("keeps a percentage radius circular by expressing it on both axes", () => {
    const metrics = resolveDeviceShellMetrics(IPHONE_17_PRO);
    // The chassis is far taller than it is wide, so an honest radius must be a
    // much smaller share of the height than of the width.
    expect(metrics.chassisRadius.yPercent).toBeLessThan(metrics.chassisRadius.xPercent);
    expect(deviceShellRadiusValue({ xPercent: 12, yPercent: 5 })).toBe("12% / 5%");
  });

  it("puts volume up above volume down on every phone", () => {
    for (const size of [IPHONE_17_PRO, IPHONE_SE]) {
      const buttons = resolveDeviceShellMetrics(size).buttons;
      const up = buttons.find((button) => button.id === "volume-up");
      const down = buttons.find((button) => button.id === "volume-down");
      expect(up?.edge).toBe("left");
      expect(down?.edge).toBe("left");
      expect(up!.offsetPercent).toBeLessThan(down!.offsetPercent);
      expect(buttons.find((button) => button.id === "power")?.edge).toBe("right");
    }
  });

  it("keeps every button inside the chassis", () => {
    for (const size of [IPHONE_17_PRO, IPHONE_SE, IPAD_PRO_11]) {
      for (const landscape of [false, true]) {
        for (const button of resolveDeviceShellMetrics({ ...size, landscape }).buttons) {
          expect(button.offsetPercent).toBeGreaterThan(0);
          expect(button.offsetPercent + button.lengthPercent).toBeLessThan(100);
        }
      }
    }
  });

  it("normalises a device reporting landscape points to the same upright chassis", () => {
    // Orientation is the pane's own state, driven by its rotate control, so a
    // device that happens to report its points the long way round must not
    // silently draw a turned phone.
    const portrait = resolveDeviceShellMetrics(IPHONE_17_PRO);
    const reversed = resolveDeviceShellMetrics({ pointWidth: 874, pointHeight: 402 });
    expect(reversed).toEqual(portrait);
  });
});

describe("resolveDeviceShellMetrics in landscape", () => {
  const portrait = resolveDeviceShellMetrics(IPHONE_17_PRO);
  const landscape = resolveDeviceShellMetrics({ ...IPHONE_17_PRO, landscape: true });

  it("transposes the chassis rather than squashing it", () => {
    // A true quarter turn: the wide chassis is exactly as wide as the upright
    // one was tall. The bug this replaces produced a chassis far squatter than
    // the reciprocal, because percentage padding inflated the bezel.
    expect(landscape.chassisAspectRatio).toBeCloseTo(1 / portrait.chassisAspectRatio, 6);
    expect(landscape.screenAspectRatio).toBeCloseTo(1 / portrait.screenAspectRatio, 6);
  });

  it("keeps the chassis the same thickness on every edge as it was upright", () => {
    // Resolved back into points, both bezels must come out at the same 11.3pt
    // they were upright. Percentage padding is what broke this: `padding-block`
    // resolves against width, so on a wide chassis the top and bottom bezels
    // ballooned to a share of the long axis and ate the screen.
    const bezelPoints = 402 * 0.028;
    const chassisWidth = 402 + bezelPoints * 2;
    const chassisHeight = 874 + bezelPoints * 2;

    // Landscape chassis is the portrait one transposed.
    expect((landscape.bezelInsetPercent.x / 100) * chassisHeight).toBeCloseTo(bezelPoints, 6);
    expect((landscape.bezelInsetPercent.y / 100) * chassisWidth).toBeCloseTo(bezelPoints, 6);
    expect((portrait.bezelInsetPercent.x / 100) * chassisWidth).toBeCloseTo(bezelPoints, 6);
    expect((portrait.bezelInsetPercent.y / 100) * chassisHeight).toBeCloseTo(bezelPoints, 6);
  });

  it("draws concentric corners after the turn too", () => {
    // The turned chassis is as wide as the upright one was tall, and its screen
    // as wide as the screen was tall.
    const chassisWidth = 874 + 402 * 0.028 * 2;
    const chassisRadiusPoints = (landscape.chassisRadius.xPercent / 100) * chassisWidth;
    const screenRadiusPoints = (landscape.screenRadius.xPercent / 100) * 874;
    expect(chassisRadiusPoints - screenRadiusPoints).toBeCloseTo(402 * 0.028, 4);
  });

  it("keeps the corner radius circular on the transposed box", () => {
    // Wide box now, so the honest radius is the larger share of the height.
    expect(landscape.chassisRadius.xPercent).toBeLessThan(landscape.chassisRadius.yPercent);
  });

  it("rotates the side buttons onto the edges they physically end up on", () => {
    const byId = new Map(landscape.buttons.map((button) => [button.id, button]));
    // Turning the phone clockwise puts the volume rocker along the top edge and
    // the power button along the bottom. Leaving them on left/right is what
    // made the first landscape build read as a phone lying inside a frame that
    // had not moved with it.
    expect(byId.get("volume-up")?.edge).toBe("top");
    expect(byId.get("volume-down")?.edge).toBe("top");
    expect(byId.get("action")?.edge).toBe("top");
    expect(byId.get("power")?.edge).toBe("bottom");
  });

  it("reverses the order along the edge, since the turn reverses its direction", () => {
    const byId = new Map(landscape.buttons.map((button) => [button.id, button]));
    // Volume up sat above volume down; lying down it sits to the *right* of it.
    expect(byId.get("volume-up")!.offsetPercent).toBeGreaterThan(
      byId.get("volume-down")!.offsetPercent,
    );
    // Same run of chassis, measured from the other end.
    const portraitUp = portrait.buttons.find((button) => button.id === "volume-up")!;
    const landscapeUp = byId.get("volume-up")!;
    expect(landscapeUp.offsetPercent + landscapeUp.lengthPercent).toBeCloseTo(
      100 - portraitUp.offsetPercent,
      6,
    );
    expect(landscapeUp.lengthPercent).toBeCloseTo(portraitUp.lengthPercent, 6);
  });

  it("carries the Dynamic Island around to the leading edge", () => {
    expect(portrait.dynamicIsland?.edge).toBe("top");
    expect(landscape.dynamicIsland?.edge).toBe("right");
    // Same cutout, same size — only the axis it is measured against changes.
    expect(landscape.dynamicIsland?.lengthPercent).toBeCloseTo(
      portrait.dynamicIsland!.lengthPercent,
      6,
    );
    expect(landscape.dynamicIsland?.thicknessPercent).toBeCloseTo(
      portrait.dynamicIsland!.thicknessPercent,
      6,
    );
  });

  it("turns an iPhone SE without giving it an island or a phantom action button", () => {
    const se = resolveDeviceShellMetrics({ ...IPHONE_SE, landscape: true });
    expect(se.shellClass).toBe("classic-phone");
    expect(se.dynamicIsland).toBeNull();
    expect(se.chassisAspectRatio).toBeGreaterThan(1);
    // The SE's deep forehead and chin become deep left and right bezels, which
    // is exactly what the hardware looks like on its side.
    const portraitSe = resolveDeviceShellMetrics(IPHONE_SE);
    expect(se.bezelInsetPercent.x).toBeCloseTo(portraitSe.bezelInsetPercent.y, 6);
    expect(se.bezelInsetPercent.y).toBeCloseTo(portraitSe.bezelInsetPercent.x, 6);
  });
});

describe("fitDeviceShellSize", () => {
  const PORTRAIT_ASPECT = resolveDeviceShellMetrics(IPHONE_17_PRO).chassisAspectRatio;
  const LANDSCAPE_ASPECT = resolveDeviceShellMetrics({
    ...IPHONE_17_PRO,
    landscape: true,
  }).chassisAspectRatio;

  it("fills a tall pane by height when the device is upright", () => {
    const fit = fitDeviceShellSize({ width: 480, height: 900 }, PORTRAIT_ASPECT, 1);
    expect(fit.height).toBeCloseTo(900, 6);
    expect(fit.width).toBeLessThanOrEqual(480);
    expect(fit.width / fit.height).toBeCloseTo(PORTRAIT_ASPECT, 6);
  });

  it("fills the same pane by width once the device is turned", () => {
    // The landscape case the pane was getting wrong: a wide device in a tall
    // pane is bound by width, and anything that only looked at height left it
    // a fraction of the size it could be.
    const fit = fitDeviceShellSize({ width: 480, height: 900 }, LANDSCAPE_ASPECT, 1);
    expect(fit.width).toBeCloseTo(480, 6);
    expect(fit.height).toBeLessThanOrEqual(900);
    expect(fit.width / fit.height).toBeCloseTo(LANDSCAPE_ASPECT, 6);
  });

  it("never exceeds the box it was given, in either orientation or aspect", () => {
    const panes = [
      { width: 480, height: 900 },
      { width: 1200, height: 300 },
      { width: 400, height: 400 },
    ];
    for (const pane of panes) {
      for (const aspect of [PORTRAIT_ASPECT, LANDSCAPE_ASPECT, 0.75, 1.33]) {
        const fit = fitDeviceShellSize(pane, aspect);
        expect(fit.width).toBeLessThanOrEqual(pane.width);
        expect(fit.height).toBeLessThanOrEqual(pane.height);
        expect(fit.width / fit.height).toBeCloseTo(aspect, 6);
      }
    }
  });

  it("leaves a margin so the protruding side buttons are not clipped", () => {
    const fit = fitDeviceShellSize({ width: 480, height: 900 }, LANDSCAPE_ASPECT);
    expect(fit.width).toBeLessThan(480);
    expect(fit.width).toBeGreaterThan(480 * 0.9);
  });

  it("returns nothing for a pane that has not been measured yet", () => {
    expect(fitDeviceShellSize({ width: 0, height: 900 }, PORTRAIT_ASPECT)).toEqual({
      width: 0,
      height: 0,
    });
    expect(fitDeviceShellSize({ width: 480, height: Number.NaN }, PORTRAIT_ASPECT)).toEqual({
      width: 0,
      height: 0,
    });
  });

  it("falls back to a phone shape for absent or nonsensical geometry", () => {
    const fallback = resolveDeviceShellMetrics({
      pointWidth: DEVICE_SHELL_FALLBACK_POINT_SIZE.width,
      pointHeight: DEVICE_SHELL_FALLBACK_POINT_SIZE.height,
    });
    expect(resolveDeviceShellMetrics({ pointWidth: 0, pointHeight: 0 })).toEqual(fallback);
    expect(resolveDeviceShellMetrics({ pointWidth: -1, pointHeight: 800 })).toEqual(fallback);
    expect(resolveDeviceShellMetrics({ pointWidth: Number.NaN, pointHeight: Number.NaN })).toEqual(
      fallback,
    );
  });
});
