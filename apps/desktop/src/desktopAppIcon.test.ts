import { describe, expect, it } from "vitest";

import {
  desktopAppIconResourceName,
  isDesktopAppIcon,
  shouldUpdateDesktopAppIcon,
} from "./desktopAppIcon";

describe("desktop app icons", () => {
  it("accepts only supported preferences", () => {
    expect(isDesktopAppIcon("default")).toBe(true);
    expect(isDesktopAppIcon("icon")).toBe(true);
    expect(isDesktopAppIcon("dark")).toBe(true);
    expect(isDesktopAppIcon("unknown")).toBe(false);
  });

  it("selects the alternate native asset on every desktop platform", () => {
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "darwin", isDarkAppearance: false }),
    ).toBe("app-icon-macos.png");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "win32", isDarkAppearance: false }),
    ).toBe("app-icon-windows.ico");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "linux", isDarkAppearance: false }),
    ).toBe("app-icon-linux.png");
  });

  it("uses a PNG for the macOS default icon in light and dark mode", () => {
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon.png");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-dark.png");
  });

  it("always uses the dark artwork when the dark preference is selected", () => {
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon-dark.png");
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-dark.png");
  });

  it("falls back to the default icon for the dark preference off macOS", () => {
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "linux", isDarkAppearance: false }),
    ).toBe("icon.png");
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "win32", isDarkAppearance: false }),
    ).toBe("icon.ico");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "linux", isDarkAppearance: true }),
    ).toBe("icon.png");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "win32", isDarkAppearance: true }),
    ).toBe("icon.ico");
  });

  it("does not reapply the icon when renderer hydration matches native state", () => {
    expect(shouldUpdateDesktopAppIcon("default", "default")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("icon", "icon")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("dark", "dark")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("default", "dark")).toBe(true);
    expect(shouldUpdateDesktopAppIcon("dark", "icon")).toBe(true);
  });
});
