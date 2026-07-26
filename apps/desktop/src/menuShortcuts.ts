// FILE: menuShortcuts.ts
// Purpose: Keeps native desktop menu accelerators consistent across operating systems.
// Layer: Desktop main-process helper
// Exports: menu accelerator resolvers

import type { MenuItemConstructorOptions } from "electron";

export interface DesktopKeyboardInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export type DesktopPhysicalZoomAction = "zoomOut" | null;

export interface DesktopNativeZoomTarget {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

export function resolveDesktopPhysicalZoomAction(
  platform: NodeJS.Platform,
  input: DesktopKeyboardInput,
): DesktopPhysicalZoomAction {
  if (
    platform !== "win32" ||
    input.type !== "keyDown" ||
    !input.control ||
    input.meta ||
    input.shift ||
    input.alt
  ) {
    return null;
  }

  const isMinusKey = input.key === "-" || input.code === "Minus" || input.code === "NumpadSubtract";
  return isMinusKey ? "zoomOut" : null;
}

export function applyDesktopPhysicalZoomAction(
  target: DesktopNativeZoomTarget,
  action: Exclude<DesktopPhysicalZoomAction, null>,
): void {
  if (action === "zoomOut") {
    // Electron's native zoomOut role subtracts half a zoom level. Reuse that
    // exact step so alternating native zoom-in and fallback zoom-out cannot drift.
    target.setZoomLevel(target.getZoomLevel() - 0.5);
  }
}

export function resolveDesktopMenuAccelerator(
  platform: NodeJS.Platform,
  accelerator: MenuItemConstructorOptions["accelerator"],
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Several Linux desktops surface Electron menu accelerators as noisy native
  // keybinding notifications; the web app handles these shortcuts itself.
  return platform === "linux" ? undefined : accelerator;
}

export function shouldUseNativeZoomMenuRoles(platform: NodeJS.Platform): boolean {
  // Zoom roles provide their own accelerators when Electron builds the menu.
  // Linux uses custom click handlers so no hidden native keybindings are registered.
  return platform !== "linux";
}

export function resolveKeyboardShortcutsMenuAccelerator(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Windows Electron can treat Ctrl+- as Ctrl+/ on some keyboard layouts,
  // which steals the native zoom-out accelerator before the page receives it.
  return platform === "darwin" ? "Cmd+/" : undefined;
}
