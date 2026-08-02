import type { DeviceScreenshotResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deviceScreenshotAttachmentName, promptLooksLikeDeviceTask } from "./devicePromptContext";

describe("promptLooksLikeDeviceTask", () => {
  it("matches prompts that name the simulator and ask to look at it", () => {
    expect(promptLooksLikeDeviceTask("what do you see in the simulator?")).toBe(true);
    expect(promptLooksLikeDeviceTask("Describe the simulator screen")).toBe(true);
    expect(promptLooksLikeDeviceTask("read the text on the device")).toBe(true);
    expect(promptLooksLikeDeviceTask("check the iOS Simulator for layout issues")).toBe(true);
  });

  it("matches the Italian phrasings the browser helper also covers", () => {
    expect(promptLooksLikeDeviceTask("guarda nel simulatore")).toBe(true);
    expect(promptLooksLikeDeviceTask("descrivi lo schermo del simulatore")).toBe(true);
  });

  it("ignores a scope mention with no action verb", () => {
    // Otherwise a build-configuration request would silently attach a screenshot.
    expect(promptLooksLikeDeviceTask("add a simulator target to the build")).toBe(false);
    expect(promptLooksLikeDeviceTask("the simulator is configured in Package.swift")).toBe(false);
  });

  it("ignores an action verb with no simulator scope", () => {
    expect(promptLooksLikeDeviceTask("describe this function")).toBe(false);
    expect(promptLooksLikeDeviceTask("what do you see in the diff?")).toBe(false);
  });

  it("is insensitive to case and surrounding whitespace", () => {
    expect(promptLooksLikeDeviceTask("  WHAT   DO  YOU SEE  IN THE SIMULATOR  ")).toBe(true);
  });
});

describe("deviceScreenshotAttachmentName", () => {
  const base = {
    udid: "udid",
    mimeType: "image/png",
    width: 100,
    height: 200,
    sizeBytes: 10,
    bytesBase64: "AAAA",
    capturedAt: "2026-08-02T00:00:00.000Z",
  } as unknown as DeviceScreenshotResult;

  it("prefers the server-provided name", () => {
    expect(deviceScreenshotAttachmentName({ ...base, name: "iPhone 16 Pro.png" })).toBe(
      "iPhone 16 Pro.png",
    );
  });

  it("falls back to a generated name when the server sent only whitespace", () => {
    expect(deviceScreenshotAttachmentName({ ...base, name: "   " })).toMatch(
      /^simulator-\d+\.png$/,
    );
  });
});
