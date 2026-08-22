import { describe, expect, it } from "vitest";

import { desktopAppIconsForPlatform } from "./AppIconPicker";

describe("desktop app icon availability", () => {
  it("offers the dark icon on macOS", () => {
    expect(desktopAppIconsForPlatform("MacIntel")).toEqual(["default", "icon", "dark"]);
  });

  it("hides the unsupported dark icon off macOS", () => {
    expect(desktopAppIconsForPlatform("Win32")).toEqual(["default", "icon"]);
    expect(desktopAppIconsForPlatform("Linux x86_64")).toEqual(["default", "icon"]);
  });
});
