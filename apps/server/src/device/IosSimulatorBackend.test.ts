import { describe, expect, it } from "vitest";

import {
  formatRuntimeIdentifier,
  normalizeUiNode,
  parseSimctlDevices,
  readPngDimensions,
} from "./IosSimulatorBackend.ts";

const SIMCTL_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAA-1111",
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
      },
      {
        udid: "BBBB-2222",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
      {
        udid: "CCCC-3333",
        name: "iPhone 12",
        state: "Shutdown",
        // Runtime was deleted; booting this would only fail.
        isAvailable: false,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [
      { udid: "DDDD-4444", name: "Apple Watch", state: "Shutting Down", isAvailable: true },
    ],
  },
});

describe("simctl device parsing", () => {
  it("maps simctl states onto the contract's runtime states", () => {
    const devices = parseSimctlDevices(SIMCTL_JSON);

    expect(devices.map((device) => [device.udid, device.state])).toEqual([
      ["AAAA-1111", "booted"],
      ["BBBB-2222", "shutdown"],
      ["DDDD-4444", "shutting-down"],
    ]);
  });

  it("drops devices whose runtime is unavailable", () => {
    expect(parseSimctlDevices(SIMCTL_JSON).map((device) => device.udid)).not.toContain("CCCC-3333");
  });

  it("reports every discovered device as user-booted", () => {
    // Discovery cannot attribute a boot; DeviceManager overrides the field for
    // devices it booted itself.
    expect(parseSimctlDevices(SIMCTL_JSON).every((device) => device.bootSource === "user")).toBe(
      true,
    );
  });

  it("renders a readable runtime label", () => {
    expect(formatRuntimeIdentifier("com.apple.CoreSimulator.SimRuntime.iOS-26-0")).toBe("iOS 26.0");
    expect(formatRuntimeIdentifier("com.apple.CoreSimulator.SimRuntime.watchOS-11-2")).toBe(
      "watchOS 11.2",
    );
  });

  it("returns nothing rather than throwing on an empty or shapeless payload", () => {
    expect(parseSimctlDevices(JSON.stringify({}))).toEqual([]);
    expect(parseSimctlDevices(JSON.stringify({ devices: null }))).toEqual([]);
  });

  it("throws on output that is not JSON at all", () => {
    expect(() => parseSimctlDevices("xcrun: error: unable to find utility")).toThrow();
  });
});

describe("accessibility tree normalization", () => {
  it("fills in the attributes the helper omits rather than sending as null", () => {
    // The helper leaves absent accessibility attributes out of the object
    // entirely; the contract wants explicit nulls and a complete frame.
    expect(normalizeUiNode({ role: "Button" })).toEqual({
      role: "Button",
      label: null,
      value: null,
      frame: { x: 0, y: 0, width: 0, height: 0 },
      children: [],
    });
  });

  it("keeps the attributes the helper does send", () => {
    const node = normalizeUiNode({
      role: "TextField",
      label: "Email",
      value: "a@b.c",
      frame: { x: 12, y: 34, width: 200, height: 44 },
    });

    expect(node).toMatchObject({
      role: "TextField",
      label: "Email",
      value: "a@b.c",
      frame: { x: 12, y: 34, width: 200, height: 44 },
    });
  });

  it("normalizes the whole subtree", () => {
    const node = normalizeUiNode({
      role: "Window",
      children: [{ role: "Button", children: [{ label: "Deep" }] }],
    });

    expect(node.children[0]?.children[0]).toMatchObject({ role: "Unknown", label: "Deep" });
  });

  it("clamps negative sizes and survives a shapeless node", () => {
    expect(normalizeUiNode({ frame: { width: -5, height: 10 } }).frame).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 10,
    });
    expect(normalizeUiNode(null).role).toBe("Unknown");
  });
});

describe("png dimension reading", () => {
  it("reads width and height from the IHDR chunk", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    expect(readPngDimensions(png)).toEqual({ width: 1, height: 1 });
  });

  it("returns null for bytes that are not a PNG", () => {
    expect(readPngDimensions(Buffer.alloc(64))).toBeNull();
    expect(readPngDimensions(Buffer.from("nope"))).toBeNull();
  });
});
