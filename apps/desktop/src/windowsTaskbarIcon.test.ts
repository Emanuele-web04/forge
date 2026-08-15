import Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SYNARA_PRODUCTION_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import type { BrowserWindow } from "electron";

import {
  applyWindowsTaskbarIcon,
  clearWindowsTaskbarIconRefresh,
  collectWindowsShortcutPaths,
  syncWindowsShortcutIcons,
  windowsShellIconCachePath,
} from "./windowsTaskbarIcon";

interface FakeWindowState {
  destroyed?: boolean;
  visible?: boolean;
}

function makeWindow({ destroyed = false, visible = true }: FakeWindowState = {}) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    setIcon: vi.fn(),
    setAppDetails: vi.fn(),
    setSkipTaskbar: vi.fn(),
  } as unknown as BrowserWindow;
}

const identity = {
  appId: SYNARA_PRODUCTION_BUNDLE_ID,
  relaunchCommand: "C:\\Program Files\\Synara\\Synara.exe",
  relaunchDisplayName: "Synara",
} as const;

const iconPath = "C:\\Users\\synara\\userdata\\taskbar-icons\\taskbar-icon.ico";

afterEach(() => {
  clearWindowsTaskbarIconRefresh();
  vi.useRealTimers();
});

describe("windowsShellIconCachePath", () => {
  it("keeps a distinct on-disk ICO per preference so Explorer cannot reuse a stale cache entry", () => {
    expect(windowsShellIconCachePath(Path.join("cache"), "default")).toBe(
      Path.join("cache", "taskbar-default.ico"),
    );
    expect(windowsShellIconCachePath(Path.join("cache"), "icon")).toBe(
      Path.join("cache", "taskbar-icon.ico"),
    );
  });
});

describe("collectWindowsShortcutPaths", () => {
  it("includes Start Menu and nested program-folder shortcuts while skipping missing roots", () => {
    const files: Record<string, string[]> = {
      [Path.join("Start Menu", "Programs")]: ["Synara.lnk", "Other", "Readme.txt"],
      [Path.join("Start Menu", "Programs", "Other")]: ["Synara Dev.lnk"],
    };

    expect(
      collectWindowsShortcutPaths({
        directories: [Path.join("Start Menu", "Programs"), "missing"],
        readdir: (directory) => {
          const entries = files[directory];
          if (!entries) throw new Error(`missing ${directory}`);
          return entries;
        },
        isDirectory: (path) => path === Path.join("Start Menu", "Programs", "Other"),
      }),
    ).toEqual([
      Path.join("Start Menu", "Programs", "Synara.lnk"),
      Path.join("Start Menu", "Programs", "Other", "Synara Dev.lnk"),
    ]);
  });
});

describe("syncWindowsShortcutIcons", () => {
  it("updates shortcuts that share the app identity and skips unrelated links", () => {
    const updateShortcut = vi.fn(() => true);

    const updated = syncWindowsShortcutIcons({
      iconPath: Path.join("cache", "taskbar-icon.ico"),
      appId: SYNARA_PRODUCTION_BUNDLE_ID,
      executablePath: Path.join("Program Files", "Synara", "Synara.exe"),
      shortcutPaths: ["synara.lnk", "other.lnk", "already.lnk"],
      readShortcut: (shortcutPath) => {
        if (shortcutPath === "synara.lnk") {
          return {
            appUserModelId: SYNARA_PRODUCTION_BUNDLE_ID,
            target: Path.join("Program Files", "Synara", "Synara.exe"),
            icon: Path.join("Program Files", "Synara", "Synara.exe"),
            iconIndex: 0,
          };
        }
        if (shortcutPath === "already.lnk") {
          return {
            appUserModelId: SYNARA_PRODUCTION_BUNDLE_ID,
            icon: Path.join("cache", "taskbar-icon.ico"),
            iconIndex: 0,
          };
        }
        return { appUserModelId: "com.other.app", target: Path.join("Other", "App.exe") };
      },
      updateShortcut,
    });

    expect(updated).toEqual(["synara.lnk"]);
    expect(updateShortcut).toHaveBeenCalledTimes(1);
    expect(updateShortcut).toHaveBeenCalledWith(
      "synara.lnk",
      Path.join("cache", "taskbar-icon.ico"),
      0,
    );
  });

  it("does not treat the Electron dev binary as a shortcut target", () => {
    const updateShortcut = vi.fn(() => true);

    const updated = syncWindowsShortcutIcons({
      iconPath: Path.join("cache", "taskbar-icon.ico"),
      appId: SYNARA_PRODUCTION_BUNDLE_ID,
      executablePath: Path.join("node_modules", "electron", "electron.exe"),
      shortcutPaths: ["electron.lnk"],
      readShortcut: () => ({
        target: Path.join("node_modules", "electron", "electron.exe"),
      }),
      updateShortcut,
    });

    expect(updated).toEqual([]);
    expect(updateShortcut).not.toHaveBeenCalled();
  });
});

describe("applyWindowsTaskbarIcon", () => {
  it("binds a shell-visible ICO before recreating the taskbar button, then rebinds it after the delay", () => {
    vi.useFakeTimers();
    const window = makeWindow();

    applyWindowsTaskbarIcon({ window, iconPath, identity });

    expect(window.setIcon).toHaveBeenCalledWith(iconPath);
    expect(window.setAppDetails).toHaveBeenCalledWith({
      appId: identity.appId,
      appIconPath: iconPath,
      appIconIndex: 0,
      relaunchCommand: identity.relaunchCommand,
      relaunchDisplayName: identity.relaunchDisplayName,
    });
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(1);
    expect(window.setIcon).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(window.setIcon).toHaveBeenLastCalledWith(iconPath);
    expect(window.setAppDetails).toHaveBeenCalledTimes(2);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(2);
  });

  it("binds a visible window without recreating the taskbar button when reregister is disabled", () => {
    vi.useFakeTimers();
    const window = makeWindow();

    applyWindowsTaskbarIcon({
      window,
      iconPath,
      identity,
      reregisterTaskbarButton: false,
    });

    expect(window.setIcon).toHaveBeenCalledWith(iconPath);
    expect(window.setAppDetails).toHaveBeenCalledTimes(1);
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("binds the icon on a hidden window without touching the taskbar button", () => {
    vi.useFakeTimers();
    const window = makeWindow({ visible: false });

    applyWindowsTaskbarIcon({ window, iconPath, identity });

    expect(window.setIcon).toHaveBeenCalledWith(iconPath);
    expect(window.setAppDetails).toHaveBeenCalledTimes(1);
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("does nothing when there is no window", () => {
    vi.useFakeTimers();
    expect(() => applyWindowsTaskbarIcon({ window: null, iconPath, identity })).not.toThrow();
  });

  it("does nothing when the window is destroyed", () => {
    vi.useFakeTimers();
    const window = makeWindow({ destroyed: true });

    applyWindowsTaskbarIcon({ window, iconPath, identity });

    expect(window.setIcon).not.toHaveBeenCalled();
    expect(window.setAppDetails).not.toHaveBeenCalled();
    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("never re-registers the button when the window is destroyed before the delay elapses", () => {
    vi.useFakeTimers();
    const window = makeWindow();

    applyWindowsTaskbarIcon({ window, iconPath, identity });
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(249);
    (window.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    vi.advanceTimersByTime(1);

    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(1);
    expect(window.setIcon).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight reregister when a newer icon is applied", () => {
    vi.useFakeTimers();
    const window = makeWindow();
    const nextIconPath = "C:\\Users\\synara\\userdata\\taskbar-icons\\taskbar-default.ico";

    applyWindowsTaskbarIcon({ window, iconPath, identity });
    applyWindowsTaskbarIcon({ window, iconPath: nextIconPath, identity });

    expect(window.setSkipTaskbar).toHaveBeenNthCalledWith(1, true);
    expect(window.setSkipTaskbar).toHaveBeenNthCalledWith(2, true);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(250);
    expect(window.setIcon).toHaveBeenLastCalledWith(nextIconPath);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(3);
  });
});
