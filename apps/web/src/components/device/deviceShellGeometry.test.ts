import { describe, expect, it } from "vitest";

import {
  DEVICE_SHELL_FALLBACK_POINT_SIZE,
  deviceShellClass,
  deviceShellRadiusValue,
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
    expect(metrics.dynamicIsland?.widthPercent).toBeCloseTo(31.3, 1);
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
      expect(up!.topPercent).toBeLessThan(down!.topPercent);
      expect(buttons.find((button) => button.id === "power")?.edge).toBe("right");
    }
  });

  it("keeps every button inside the chassis", () => {
    for (const size of [IPHONE_17_PRO, IPHONE_SE, IPAD_PRO_11]) {
      for (const button of resolveDeviceShellMetrics(size).buttons) {
        expect(button.topPercent).toBeGreaterThan(0);
        expect(button.topPercent + button.heightPercent).toBeLessThan(100);
      }
    }
  });

  it("normalises landscape geometry to the same upright chassis", () => {
    // The pane rotates the view rather than the shell, so a device reporting
    // landscape points must still produce a portrait chassis.
    const portrait = resolveDeviceShellMetrics(IPHONE_17_PRO);
    const landscape = resolveDeviceShellMetrics({ pointWidth: 874, pointHeight: 402 });
    expect(landscape).toEqual(portrait);
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
