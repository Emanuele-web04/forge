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
    expect(isDesktopAppIcon("unknown")).toBe(false);
  });

  it("selects the alternate native asset on every desktop platform", () => {
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "darwin", useLegacyMacDefault: false }),
    ).toBe("app-icon-macos.png");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "win32", useLegacyMacDefault: false }),
    ).toBe("app-icon-windows.ico");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "linux", useLegacyMacDefault: false }),
    ).toBe("app-icon-linux.png");
  });

  it("keeps the legacy macOS default compatible with older releases", () => {
    expect(
      desktopAppIconResourceName({
        icon: "default",
        platform: "darwin",
        useLegacyMacDefault: true,
      }),
    ).toBe("dock-icon.png");
    expect(
      desktopAppIconResourceName({
        icon: "default",
        platform: "darwin",
        useLegacyMacDefault: false,
      }),
    ).toBe("icon.icns");
  });

  it("does not reapply the icon when renderer hydration matches native state", () => {
    expect(shouldUpdateDesktopAppIcon("default", "default")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("icon", "icon")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("default", "icon")).toBe(true);
    expect(shouldUpdateDesktopAppIcon("icon", "default")).toBe(true);
  });
});
