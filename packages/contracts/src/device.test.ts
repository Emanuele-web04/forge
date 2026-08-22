import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DeviceDescriptor,
  DeviceListResult,
  DeviceScrollToElementInput,
  DeviceSwipeInput,
  ThreadDeviceState,
} from "./device";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

const BASE_DEVICE = {
  platform: "ios-simulator",
  udid: "11111111-2222-3333-4444-555555555555",
  name: "iPhone 17 Pro",
  runtime: "iOS 26.0",
  state: "booted",
  bootSource: "synara",
} as const;

/** iPhone 17 Pro: the geometry that exposed the pixel-vs-point tap bug. */
const GEOMETRY = { pointWidth: 402, pointHeight: 874, scale: 3 } as const;

describe("DeviceDescriptor geometry", () => {
  it("carries point dimensions and scale for an attached device", () => {
    const decoded = decodeSync(DeviceDescriptor, { ...BASE_DEVICE, geometry: GEOMETRY });
    expect(decoded.geometry).toEqual(GEOMETRY);
  });

  it("accepts a device that has never been attached", () => {
    // Geometry comes from the native helper's attachment, so a listing on a
    // host where the helper is not built yet must still validate.
    const decoded = decodeSync(DeviceDescriptor, BASE_DEVICE);
    expect(decoded.geometry).toBeUndefined();
  });

  it("rejects non-positive or non-finite dimensions rather than passing them to a divide", () => {
    for (const bad of [
      { ...GEOMETRY, pointWidth: 0 },
      { ...GEOMETRY, pointHeight: -874 },
      { ...GEOMETRY, scale: 0 },
      { ...GEOMETRY, scale: Number.POSITIVE_INFINITY },
      { ...GEOMETRY, pointWidth: Number.NaN },
    ]) {
      expect(decodes(DeviceDescriptor, { ...BASE_DEVICE, geometry: bad })).toBe(false);
    }
  });

  it("requires every field once geometry is present", () => {
    expect(decodes(DeviceDescriptor, { ...BASE_DEVICE, geometry: { pointWidth: 402 } })).toBe(
      false,
    );
    expect(
      decodes(DeviceDescriptor, {
        ...BASE_DEVICE,
        geometry: { pointWidth: 402, pointHeight: 874 },
      }),
    ).toBe(false);
  });

  it("accepts a fractional scale, which non-integral-scale devices report", () => {
    expect(
      decodes(DeviceDescriptor, {
        ...BASE_DEVICE,
        geometry: { pointWidth: 320, pointHeight: 568, scale: 2.46 },
      }),
    ).toBe(true);
  });
});

describe("geometry on the wire", () => {
  it("survives a device.list result", () => {
    const decoded = decodeSync(DeviceListResult, {
      devices: [{ ...BASE_DEVICE, geometry: GEOMETRY }, BASE_DEVICE],
      availability: { kind: "available" },
    });
    expect(decoded.devices[0]?.geometry).toEqual(GEOMETRY);
    expect(decoded.devices[1]?.geometry).toBeUndefined();
  });

  it("survives a thread state push", () => {
    const decoded = decodeSync(ThreadDeviceState, {
      threadId: "thread-1",
      version: 3,
      attachedDeviceUdid: BASE_DEVICE.udid,
      devices: [{ ...BASE_DEVICE, geometry: GEOMETRY }],
      agentActive: false,
      availability: { kind: "available" },
      lastError: null,
    });
    const attached = decoded.devices.find((device) => device.udid === decoded.attachedDeviceUdid);
    expect(attached?.geometry).toEqual(GEOMETRY);
  });
});

describe("device control limits", () => {
  it("keeps swipe duration and scroll budgets bounded to safe integers", () => {
    const swipe = {
      udid: BASE_DEVICE.udid,
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 10,
    };
    const scroll = { udid: BASE_DEVICE.udid, label: "Continue" };

    expect(decodes(DeviceSwipeInput, { ...swipe, durationMs: 10_000 })).toBe(true);
    expect(decodes(DeviceSwipeInput, { ...swipe, durationMs: 10_001 })).toBe(false);
    expect(decodes(DeviceSwipeInput, { ...swipe, durationMs: 10.5 })).toBe(false);
    expect(decodes(DeviceScrollToElementInput, { ...scroll, maxSwipes: 32 })).toBe(true);
    expect(decodes(DeviceScrollToElementInput, { ...scroll, maxSwipes: 33 })).toBe(false);
    expect(decodes(DeviceScrollToElementInput, { ...scroll, maxSwipes: 1.5 })).toBe(false);
  });
});
