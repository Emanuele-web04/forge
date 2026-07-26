// FILE: menuShortcuts.test.ts
// Purpose: Verifies desktop menu accelerator choices that affect native keyboard behavior.

import { describe, expect, it } from "vitest";

import {
  resolveDesktopMenuAccelerator,
  resolveDesktopPhysicalZoomAction,
  resolveKeyboardShortcutsMenuAccelerator,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";

describe("resolveDesktopPhysicalZoomAction", () => {
  const windowsCtrlInput = {
    type: "keyDown",
    key: "",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  };

  it("handles both physical minus keys as zoom-out on Windows", () => {
    expect(
      resolveDesktopPhysicalZoomAction("win32", { ...windowsCtrlInput, code: "Minus" }),
    ).toBe("zoomOut");
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        code: "NumpadSubtract",
      }),
    ).toBe("zoomOut");
  });

  it("uses the translated minus value for Windows layouts whose physical code is Slash", () => {
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        key: "-",
        code: "Slash",
      }),
    ).toBe("zoomOut");
  });

  it("does not intercept slash or modified minus chords", () => {
    expect(
      resolveDesktopPhysicalZoomAction("win32", { ...windowsCtrlInput, code: "Slash" }),
    ).toBeNull();
    expect(
      resolveDesktopPhysicalZoomAction("win32", {
        ...windowsCtrlInput,
        code: "Minus",
        shift: true,
      }),
    ).toBeNull();
  });

  it("leaves macOS keyboard handling unchanged", () => {
    expect(
      resolveDesktopPhysicalZoomAction("darwin", { ...windowsCtrlInput, code: "Minus" }),
    ).toBeNull();
  });
});

describe("resolveDesktopMenuAccelerator", () => {
  it("disables custom native menu accelerators on Linux", () => {
    expect(resolveDesktopMenuAccelerator("linux", "CmdOrCtrl+B")).toBeUndefined();
  });

  it("keeps custom native menu accelerators on macOS and Windows", () => {
    expect(resolveDesktopMenuAccelerator("darwin", "CmdOrCtrl+B")).toBe("CmdOrCtrl+B");
    expect(resolveDesktopMenuAccelerator("win32", "CmdOrCtrl+B")).toBe("CmdOrCtrl+B");
  });
});

describe("shouldUseNativeZoomMenuRoles", () => {
  it("avoids Electron's role-provided zoom accelerators on Linux", () => {
    expect(shouldUseNativeZoomMenuRoles("linux")).toBe(false);
  });

  it("keeps native zoom roles on macOS and Windows", () => {
    expect(shouldUseNativeZoomMenuRoles("darwin")).toBe(true);
    expect(shouldUseNativeZoomMenuRoles("win32")).toBe(true);
  });
});

describe("resolveKeyboardShortcutsMenuAccelerator", () => {
  it("uses the native shortcuts help accelerator on macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("darwin")).toBe("Cmd+/");
  });

  it("does not assign a global shortcuts help accelerator outside macOS", () => {
    expect(resolveKeyboardShortcutsMenuAccelerator("win32")).toBeUndefined();
    expect(resolveKeyboardShortcutsMenuAccelerator("linux")).toBeUndefined();
  });
});
