import { describe, expect, it } from "vitest";

import { isViewerFacingDeviceError } from "./deviceTools.ts";

describe("isViewerFacingDeviceError", () => {
  it("keeps the agent's own recoverable failures out of the pane", () => {
    for (const message of [
      'Scrolling stopped moving "Settings" after 2 swipes; the list appears to be at its end and the element is still out of reach.',
      'No element matching label "Dark mode" is on screen.',
      'Label "Save" matched more than one element.',
      'Element "Developer" is not visible on screen.',
    ]) {
      expect(isViewerFacingDeviceError(new Error(message))).toBe(false);
    }
  });

  it("still surfaces failures the person watching has to act on", () => {
    for (const message of [
      "Device helper could not be built: xcodebuild exited with code 65",
      "simulator B9802326 is not booted (state 1)",
      "display has no framebuffer surface yet",
      "Xcode is not installed",
    ]) {
      expect(isViewerFacingDeviceError(new Error(message))).toBe(true);
    }
  });
});
