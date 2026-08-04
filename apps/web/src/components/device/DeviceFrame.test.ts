import { describe, expect, it } from "vitest";

import { NUB_ACTIONS, deviceKindFor, screenGeometry } from "./DeviceFrame";

describe("side button controls", () => {
  it("only offers a press for the nubs the transport can deliver", () => {
    // Lock lands: it blanks the screen and shows up in SpringBoard's log.
    expect(NUB_ACTIONS.power).toMatchObject({ label: "Lock", button: "lock" });
    // Volume is a Consumer-page usage the simulator's HID transport does not
    // carry, so no press is offered — a control that always refuses is the
    // "button that lies" state the pane must never ship.
    for (const nub of ["volumeUp", "volumeDown", "volumeRocker"]) {
      expect(NUB_ACTIONS[nub]?.button).toBeUndefined();
    }
  });

  it("explains the nubs it cannot press rather than dropping them silently", () => {
    // The hardware is still drawn, so the tooltip has to answer "why did
    // nothing happen when I clicked this?" before the user asks it.
    expect(NUB_ACTIONS.volumeUp?.hint).toMatch(/cannot receive volume/);
    expect(NUB_ACTIONS.volumeDown?.hint).toMatch(/cannot receive volume/);
    // Lock works, so it needs no explanation.
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
