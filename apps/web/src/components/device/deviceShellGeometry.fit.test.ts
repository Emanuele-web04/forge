import { describe, expect, it } from "vitest";

import { deviceShellFitWidth, fitDeviceShellSize } from "./deviceShellGeometry";

describe("deviceShellFitWidth", () => {
  it("emits two comparable lengths so neither term is dropped", () => {
    // A length times a bare number is not a valid CSS calculation: written that
    // way the whole `min()` was invalid and the height constraint vanished,
    // leaving a landscape device in a fraction of the pane.
    const css = deviceShellFitWidth(2.16);
    expect(css).toMatch(/^min\(\d+(\.\d+)?cqw, \d+(\.\d+)?cqh\)$/u);
    expect(css).not.toContain("*");
  });

  it("scales the height term by the aspect so the tighter axis wins", () => {
    const portrait = deviceShellFitWidth(0.46);
    const landscape = deviceShellFitWidth(2.16);
    const portraitHeight = Number(/([\d.]+)cqh/u.exec(portrait)?.[1]);
    const landscapeHeight = Number(/([\d.]+)cqh/u.exec(landscape)?.[1]);
    expect(landscapeHeight).toBeGreaterThan(portraitHeight);
  });
});

describe("fitDeviceShellSize", () => {
  it("is height-bound for a portrait phone in a tall narrow pane", () => {
    const fit = fitDeviceShellSize({ width: 400, height: 1200 }, 0.46);
    expect(fit.width).toBeCloseTo(376, 0);
  });

  it("is width-bound for the same phone turned", () => {
    const fit = fitDeviceShellSize({ width: 400, height: 1200 }, 2.16);
    expect(fit.width).toBeCloseTo(376, 0);
    expect(fit.height).toBeCloseTo(376 / 2.16, 0);
  });
});
