// FILE: desktopAppIcon.ts
// Purpose: Validate app-icon preferences and map them to platform resources.
// Layer: Desktop-native preference logic

import { DesktopAppIcon } from "@synara/contracts";
import { Schema } from "effect";

type DesktopPlatform = "darwin" | "linux" | "win32";

interface DesktopAppIconResourceInput {
  readonly icon: DesktopAppIcon;
  readonly platform: DesktopPlatform;
  readonly isDarkAppearance: boolean;
}

const APP_ICON_RESOURCE_NAMES = {
  darwin: {
    default: "dock-icon.png",
    icon: "app-icon-macos.png",
    dark: "dock-icon-dark.png",
  },
  // Windows and Linux have no dark artwork yet, so the dark preference falls
  // back to the same default icon those platforms always used.
  linux: {
    default: "icon.png",
    icon: "app-icon-linux.png",
    dark: "icon.png",
  },
  win32: {
    default: "icon.ico",
    icon: "app-icon-windows.ico",
    dark: "icon.ico",
  },
} as const;

export const isDesktopAppIcon = Schema.is(DesktopAppIcon);

export function shouldUpdateDesktopAppIcon(
  currentIcon: DesktopAppIcon,
  requestedIcon: DesktopAppIcon,
): boolean {
  return currentIcon !== requestedIcon;
}

export function desktopAppIconResourceName(input: DesktopAppIconResourceInput): string {
  if (input.platform === "darwin" && input.icon === "default") {
    return input.isDarkAppearance ? "dock-icon-dark.png" : "dock-icon.png";
  }
  return APP_ICON_RESOURCE_NAMES[input.platform][input.icon];
}
