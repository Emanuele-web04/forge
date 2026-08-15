// FILE: windowsTaskbarIcon.ts
// Purpose: Bind a shell-visible ICO to the Windows taskbar and force Explorer to re-read it.
// Layer: Desktop-native preference logic

import Path from "node:path";

import type { BrowserWindow } from "electron";

// Explorer coalesces a synchronous setSkipTaskbar(true) -> setSkipTaskbar(false)
// toggle and keeps rendering its cached button icon, so the button must stay
// detached long enough for the shell to process the removal before it is
// re-registered and re-reads the window icon and AppUserModel properties.
const WINDOWS_TASKBAR_ICON_REFRESH_DELAY_MS = 250;

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

export function windowsShellIconCachePath(cacheDirectory: string, iconKey: string): string {
  return Path.join(cacheDirectory, `taskbar-${iconKey}.ico`);
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
}): string[] {
  const iconIndex = input.iconIndex ?? 0;
  const normalizedExe = Path.normalize(input.executablePath);
  const canMatchByTarget = !/^electron(?:\.exe)?$/i.test(Path.basename(input.executablePath));
  const updated: string[] = [];
  for (const shortcutPath of input.shortcutPaths) {
    const details = input.readShortcut(shortcutPath);
    if (!details) continue;
    const matchesId = details.appUserModelId === input.appId;
    const matchesTarget =
      canMatchByTarget &&
      typeof details.target === "string" &&
      Path.normalize(details.target) === normalizedExe;
    if (!matchesId && !matchesTarget) continue;
    if (details.icon === input.iconPath && (details.iconIndex ?? 0) === iconIndex) continue;
    if (input.updateShortcut(shortcutPath, input.iconPath, iconIndex)) {
      updated.push(shortcutPath);
    }
  }
  return updated;
}

export function clearWindowsTaskbarIconRefresh(): void {
  if (taskbarReregisterTimer === null) return;
  clearTimeout(taskbarReregisterTimer);
  taskbarReregisterTimer = null;
}

export function applyWindowsTaskbarIcon(input: ApplyWindowsTaskbarIconInput): void {
  const { window } = input;
  if (!window || window.isDestroyed()) return;

  bindWindowsTaskbarIcon(window, input);
  if (!window.isVisible() || input.reregisterTaskbarButton === false) return;

  scheduleWindowsTaskbarReregister(window, input);
}

function bindWindowsTaskbarIcon(window: BrowserWindow, input: ApplyWindowsTaskbarIconInput): void {
  // Pass a real filesystem path. NativeImage flattening and asar-backed paths
  // update window chrome, but Explorer's taskbar button reads an ICO from disk
  // through the window's AppUserModel properties.
  window.setIcon(input.iconPath);
  try {
    window.setAppDetails({
      appId: input.identity.appId,
      appIconPath: input.iconPath,
      appIconIndex: 0,
      relaunchCommand: input.identity.relaunchCommand,
      relaunchDisplayName: input.identity.relaunchDisplayName,
    });
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
    window.setSkipTaskbar(false);
  }, WINDOWS_TASKBAR_ICON_REFRESH_DELAY_MS);
}
