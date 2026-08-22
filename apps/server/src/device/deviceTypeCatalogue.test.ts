import { describe, expect, it } from "vitest";

import {
  parseDeviceTypeProfile,
  parseSimctlDeviceTypes,
  readDeviceTypeCatalogue,
} from "./deviceTypeCatalogue.ts";
import type { ProcessRunResult } from "../processRunner.ts";

const DEVICE_TYPES = JSON.stringify({
  devicetypes: [
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      productFamily: "iPhone",
      bundlePath: "/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype",
    },
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
      productFamily: "iPad",
      bundlePath: "/Profiles/DeviceTypes/iPad (A16).simdevicetype",
    },
    // A watch: no chassis to draw it in, so it is skipped rather than made a phone.
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch",
      productFamily: "Apple Watch",
      bundlePath: "/Profiles/DeviceTypes/Apple Watch.simdevicetype",
    },
    { identifier: "no-bundle", productFamily: "iPhone" },
  ],
});

const ok = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

describe("parseSimctlDeviceTypes", () => {
  it("keeps the device types the pane can draw and resolves their profiles", () => {
    expect(parseSimctlDeviceTypes(DEVICE_TYPES)).toEqual([
      {
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        family: "phone",
        profilePath:
          "/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype/Contents/Resources/profile.plist",
      },
      {
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
        family: "tablet",
        profilePath:
          "/Profiles/DeviceTypes/iPad (A16).simdevicetype/Contents/Resources/profile.plist",
      },
    ]);
  });

  it("survives output that is not the JSON it expected", () => {
    expect(parseSimctlDeviceTypes("xcrun: error")).toEqual([]);
    expect(parseSimctlDeviceTypes(JSON.stringify({ devicetypes: null }))).toEqual([]);
  });
});

describe("parseDeviceTypeProfile", () => {
  it("converts the profile's pixel screen into the points input is injected in", () => {
    const profile = parseDeviceTypeProfile(
      JSON.stringify({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 }),
    );

    // The exact iPhone 17 Pro geometry the helper reports once it attaches, so
    // the pre-boot value never has to be corrected downward.
    expect(profile).toEqual({ pointWidth: 402, pointHeight: 874, scale: 3 });
  });

  it("yields nothing rather than a half-filled guess", () => {
    expect(
      parseDeviceTypeProfile(JSON.stringify({ mainScreenWidth: 1206, mainScreenScale: 3 })),
    ).toBeNull();
    expect(
      parseDeviceTypeProfile(
        JSON.stringify({ mainScreenWidth: 0, mainScreenHeight: 2622, mainScreenScale: 3 }),
      ),
    ).toBeNull();
    expect(parseDeviceTypeProfile("not json")).toBeNull();
  });
});

describe("readDeviceTypeCatalogue", () => {
  it("pairs each device type with its geometry", async () => {
    const run = (async (command: string, args: readonly string[]) => {
      if (command === "xcrun") return ok(DEVICE_TYPES);
      const path = args[args.length - 1] ?? "";
      return ok(
        path.includes("iPad")
          ? JSON.stringify({
              mainScreenWidth: 1640,
              mainScreenHeight: 2360,
              mainScreenScale: 2,
            })
          : JSON.stringify({
              mainScreenWidth: 1206,
              mainScreenHeight: 2622,
              mainScreenScale: 3,
            }),
      );
    }) as never;

    const catalogue = await readDeviceTypeCatalogue({ run });

    expect(catalogue.get("com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro")).toEqual({
      family: "phone",
      geometry: { pointWidth: 402, pointHeight: 874, scale: 3 },
    });
    expect(catalogue.get("com.apple.CoreSimulator.SimDeviceType.iPad-A16")).toEqual({
      family: "tablet",
      geometry: { pointWidth: 820, pointHeight: 1180, scale: 2 },
    });
  });

  it("drops one unreadable profile rather than losing the whole catalogue", async () => {
    const run = (async (command: string, args: readonly string[]) => {
      if (command === "xcrun") return ok(DEVICE_TYPES);
      const path = args[args.length - 1] ?? "";
      if (path.includes("iPad")) throw new Error("profile.plist is missing");
      return ok(
        JSON.stringify({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 }),
      );
    }) as never;

    const catalogue = await readDeviceTypeCatalogue({ run });

    expect(catalogue.has("com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro")).toBe(true);
    expect(catalogue.has("com.apple.CoreSimulator.SimDeviceType.iPad-A16")).toBe(false);
  });

  it("is empty when the device type listing itself fails", async () => {
    const run = (async () => ({ ...ok(""), code: 1 })) as never;
    expect((await readDeviceTypeCatalogue({ run })).size).toBe(0);
  });
});
