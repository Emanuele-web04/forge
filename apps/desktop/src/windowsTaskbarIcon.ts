// FILE: windowsTaskbarIcon.ts
// Purpose: Bind a shell-visible ICO to the Windows taskbar and force Explorer to re-read it.
// Layer: Desktop-native preference logic

import Crypto from "node:crypto";
import Path from "node:path";

import type { BrowserWindow } from "electron";

// Explorer coalesces a synchronous setSkipTaskbar(true) -> setSkipTaskbar(false)
// toggle and keeps rendering its cached button icon, so the button must stay
// detached long enough for the shell to process the removal before it is
// re-registered and re-reads the window icon and AppUserModel properties.
export const WINDOWS_TASKBAR_ICON_REFRESH_DELAY_MS = 400;

export interface WindowsTaskbarIconIdentity {
  readonly appId: string;
  readonly relaunchCommand: string;
  readonly relaunchDisplayName: string;
}

export interface ApplyWindowsTaskbarIconInput {
  readonly window: BrowserWindow | null;
  readonly iconPath: string;
  readonly identity: WindowsTaskbarIconIdentity;
  readonly reregisterTaskbarButton?: boolean;
}

let taskbarReregisterTimer: ReturnType<typeof setTimeout> | null = null;

let windowsShellIconGeneration = 0;
let lastMaterializedIconKey: string | null = null;

export function windowsShellIconCachePath(cacheDirectory: string, iconKey: string): string {
  return Path.join(cacheDirectory, `taskbar-${iconKey}.ico`);
}

export function windowsShellIconContentKey(iconKey: string, ico: Buffer): string {
  const digest = Crypto.createHash("sha256").update(ico).digest("hex").slice(0, 12);
  return `${iconKey}-${digest}`;
}

export function resolveWindowsShellIconCacheDirectory(input: {
  readonly executablePath: string;
  readonly fallbackDirectory: string;
}): string {
  // Packaged installs: put the live ICO next to the exe so Explorer and the
  // pinned shortcut load it from the same directory as the process identity.
  // The Electron dev binary is not that identity, so keep using userdata.
  if (/^electron(?:\.exe)?$/i.test(Path.basename(input.executablePath))) {
    return input.fallbackDirectory;
  }
  return Path.dirname(input.executablePath);
}

// Explorer caches taskbar artwork by path. Keep the same file while the
// preference is unchanged, but change the path whenever the user switches
// default <-> custom so reverting is not a stale cache hit.
export function nextWindowsShellIconCacheKey(iconKey: string): string {
  if (lastMaterializedIconKey !== iconKey) {
    windowsShellIconGeneration += 1;
    lastMaterializedIconKey = iconKey;
  }
  return `${iconKey}-${windowsShellIconGeneration}`;
}

export function resetWindowsShellIconGenerationForTests(): void {
  windowsShellIconGeneration = 0;
  lastMaterializedIconKey = null;
}

export function isWindowsTaskbarIconRefreshPending(): boolean {
  return taskbarReregisterTimer !== null;
}

export interface WindowsShortcutDetails {
  readonly target?: string;
  readonly appUserModelId?: string;
  readonly icon?: string;
  readonly iconIndex?: number;
}

export function collectWindowsShortcutPaths(input: {
  readonly directories: readonly string[];
  readonly readdir: (directory: string) => readonly string[];
  readonly isDirectory: (path: string) => boolean;
}): string[] {
  const shortcuts: string[] = [];
  for (const directory of input.directories) {
    let entries: readonly string[] = [];
    try {
      entries = input.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = Path.join(directory, entry);
      if (entry.toLowerCase().endsWith(".lnk")) {
        shortcuts.push(fullPath);
        continue;
      }
      if (!input.isDirectory(fullPath)) continue;
      let nested: readonly string[] = [];
      try {
        nested = input.readdir(fullPath);
      } catch {
        continue;
      }
      for (const nestedEntry of nested) {
        if (nestedEntry.toLowerCase().endsWith(".lnk")) {
          shortcuts.push(Path.join(fullPath, nestedEntry));
        }
      }
    }
  }
  return shortcuts;
}

export function syncWindowsShortcutIcons(input: {
  readonly iconPath: string;
  readonly iconIndex?: number;
  readonly appId: string;
  readonly executablePath: string;
  readonly shortcutPaths: readonly string[];
  readonly readShortcut: (shortcutPath: string) => WindowsShortcutDetails | null;
  readonly updateShortcut: (shortcutPath: string, iconPath: string, iconIndex: number) => boolean;
  readonly onMatched?: (shortcutPath: string) => void;
}): { matched: string[]; updated: string[] } {
  const iconIndex = input.iconIndex ?? 0;
  const normalizedExe = Path.normalize(input.executablePath);
  const canMatchByTarget = !/^electron(?:\.exe)?$/i.test(Path.basename(input.executablePath));
  const matched: string[] = [];
  const updated: string[] = [];
  for (const shortcutPath of input.shortcutPaths) {
    const details = input.readShortcut(shortcutPath);
    if (!details) continue;
    const matchesId = details.appUserModelId === input.appId;
    const matchesTarget =
      canMatchByTarget &&
      typeof details.target === "string" &&
      (Path.normalize(details.target) === normalizedExe ||
        Path.basename(details.target).toLowerCase() === Path.basename(normalizedExe).toLowerCase());
    if (!matchesId && !matchesTarget) continue;
    matched.push(shortcutPath);
    input.onMatched?.(shortcutPath);
    if (details.icon === input.iconPath && (details.iconIndex ?? 0) === iconIndex) continue;
    if (input.updateShortcut(shortcutPath, input.iconPath, iconIndex)) {
      updated.push(shortcutPath);
    }
  }
  return { matched, updated };
}

export function clearWindowsTaskbarIconRefresh(): void {
  if (taskbarReregisterTimer === null) return;
  clearTimeout(taskbarReregisterTimer);
  taskbarReregisterTimer = null;
}

export function windowsTaskbarIconPropertyUpdates(input: {
  readonly iconPath: string;
  readonly identity: WindowsTaskbarIconIdentity;
}): {
  readonly iconOnly: {
    readonly appIconPath: string;
    readonly appIconIndex: number;
    readonly relaunchCommand: string;
    readonly relaunchDisplayName: string;
  };
  readonly withAppId: {
    readonly appId: string;
    readonly appIconPath: string;
    readonly appIconIndex: number;
    readonly relaunchCommand: string;
    readonly relaunchDisplayName: string;
  };
} {
  const iconOnly = {
    appIconPath: input.iconPath,
    appIconIndex: 0,
    relaunchCommand: input.identity.relaunchCommand,
    relaunchDisplayName: input.identity.relaunchDisplayName,
  };
  return {
    iconOnly,
    withAppId: {
      appId: input.identity.appId,
      ...iconOnly,
    },
  };
}

export function applyWindowsTaskbarIcon(input: ApplyWindowsTaskbarIconInput): void {
  const { window } = input;
  if (!window || window.isDestroyed()) return;

  bindWindowsTaskbarIcon(window, input);
  if (input.reregisterTaskbarButton !== true) return;
  if (!window.isVisible()) return;

  scheduleWindowsTaskbarReregister(window, input);
}

function bindWindowsTaskbarIcon(window: BrowserWindow, input: ApplyWindowsTaskbarIconInput): void {
  // Pass a real filesystem path. NativeImage flattening and asar-backed paths
  // update window chrome, but Explorer's taskbar button reads an ICO from disk
  // through the window's AppUserModel properties.
  window.setIcon(input.iconPath);
  const updates = windowsTaskbarIconPropertyUpdates(input);
  try {
    // Microsoft requires RelaunchIconResource (and relaunch command/name) to be
    // on the window before AppUserModelID is set. Chromium's setAppDetails writes
    // the ID first and notifies Explorer immediately, so a single call publishes
    // the exe icon. Write the icon without an ID, then set the ID to notify.
    window.setAppDetails(updates.iconOnly);
    window.setAppDetails(updates.withAppId);
  } catch {
    // setAppDetails can throw on a window that is not yet fully realized.
    // The ICO path and skip-taskbar refresh still give Explorer a new button.
  }
}

function scheduleWindowsTaskbarReregister(
  window: BrowserWindow,
  input: ApplyWindowsTaskbarIconInput,
): void {
  clearWindowsTaskbarIconRefresh();
  window.setSkipTaskbar(true);
  taskbarReregisterTimer = setTimeout(() => {
    taskbarReregisterTimer = null;
    if (window.isDestroyed()) return;
    bindWindowsTaskbarIcon(window, input);
    // Restoring the button only when the window is actually visible keeps a
    // hidden window (close-to-tray) off the bar.
    window.setSkipTaskbar(!window.isVisible());
    if (window.isVisible()) {
      bindWindowsTaskbarIcon(window, input);
    }
  }, WINDOWS_TASKBAR_ICON_REFRESH_DELAY_MS);
}
