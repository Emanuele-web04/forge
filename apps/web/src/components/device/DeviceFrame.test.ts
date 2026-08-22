import { describe, expect, it } from "vitest";

import { NUB_ACTIONS, deviceKindFor, screenGeometry } from "./DeviceFrame";

describe("side button controls", () => {
  it("presses every nub the hardware has", () => {
    // Lock lands: it blanks the screen and shows up in SpringBoard's log.
    expect(NUB_ACTIONS.power).toMatchObject({ label: "Lock", button: "lock" });
    // Volume travels as a HID Consumer-page event rather than an Indigo button
    // source, which is how Simulator.app's own menu items send it. Verified
    // against the volume HUD in the framebuffer.
    expect(NUB_ACTIONS.volumeUp).toMatchObject({ button: "volume-up" });
    expect(NUB_ACTIONS.volumeDown).toMatchObject({ button: "volume-down" });
  });

  it("offers no hint for a nub that works", () => {
    // A hint exists to answer "why did nothing happen?", so a working control
    // must not carry one.
    for (const nub of ["power", "volumeUp", "volumeDown"]) {
      expect(NUB_ACTIONS[nub]?.hint).toBeUndefined();
    }
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
