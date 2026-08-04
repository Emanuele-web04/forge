import { describe, expect, it } from "vitest";

import { deviceKindFor, screenGeometry } from "./DeviceFrame";

describe("deviceKindFor", () => {
  it("draws the chassis the device's own product family names", () => {
    expect(deviceKindFor({ platform: "ios-simulator", name: "iPad (A16)", family: "tablet" })).toBe(
      "iPad",
    );
    expect(
      deviceKindFor({ platform: "ios-simulator", name: "iPhone 17 Pro", family: "phone" }),
    ).toBe("iPhone");
  });

  it("trusts the family over a name that disagrees with it", () => {
    // The name heuristic only holds while every Apple tablet says "iPad"; the
    // profile's family is what makes a rename harmless.
    expect(
      deviceKindFor({ platform: "ios-simulator", name: "Magic Slate", family: "tablet" }),
    ).toBe("iPad");
  });

  it("falls back to the name when no family was reported", () => {
    expect(deviceKindFor({ platform: "ios-simulator", name: "iPad Air 13-inch (M3)" })).toBe(
      "iPad",
    );
    expect(deviceKindFor({ platform: "ios-simulator", name: "iPhone SE (3rd generation)" })).toBe(
      "iPhone",
    );
  });
});

describe("screenGeometry", () => {
  it("takes its aspect from the device's own pixel dimensions", () => {
    // An iPhone SE is far squarer than an iPhone 17 Pro, and the chassis has to
    // follow the moment the device is picked rather than after it streams.
    const tall = screenGeometry("iPhone", 1206, 2622);
    const short = screenGeometry("iPhone", 750, 1334);

    expect(short.aspect).toBeGreaterThan(tall.aspect);
  });

  it("is wider for a tablet than for a phone", () => {
    expect(screenGeometry("iPad", 1640, 2360).aspect).toBeGreaterThan(
      screenGeometry("iPhone", 1206, 2622).aspect,
    );
  });
});
