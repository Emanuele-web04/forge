import { describe, expect, it } from "vitest";

import { NUB_ACTIONS, deviceKindFor, screenGeometry } from "./DeviceFrame";

describe("side button controls", () => {
  it("wires every drawn nub the helper has a button for", () => {
    expect(Object.keys(NUB_ACTIONS).toSorted()).toEqual([
      "power",
      "volumeDown",
      "volumeRocker",
      "volumeUp",
    ]);
    expect(NUB_ACTIONS.power).toMatchObject({ label: "Lock", button: "lock" });
  });

  it("says so when a press lands without any on-screen confirmation", () => {
    // A headless boot paints no volume HUD, so pressing these looks like
    // nothing happened. The hint is what keeps them from reading as broken.
    expect(NUB_ACTIONS.volumeUp?.hint).toMatch(/no volume HUD/);
    expect(NUB_ACTIONS.volumeDown?.hint).toMatch(/no volume HUD/);
    // Lock blanks the screen, so it needs no explanation.
    expect(NUB_ACTIONS.power?.hint).toBeUndefined();
  });
});

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
