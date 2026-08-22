// FILE: desktopTitleBar.ts
// Purpose: Resolve whether Electron should use a frameless custom title bar on
//          Windows/Linux. Shared by the desktop main process and the web renderer.
// Layer: Shared runtime utilities (no deps; safe to import from main + renderer)

/**
 * Custom (frameless) title bars are supported on Windows and Linux. macOS keeps
 * native traffic lights via `titleBarStyle: "hiddenInset"` and is not toggled.
 */
export function supportsCustomTitleBar(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Default preference when nothing is persisted yet.
 * Windows already shipped frameless; Linux defaults on so the chrome matches
 * the app without an extra opt-in step (users can switch back for tiling WMs).
 */
export function defaultCustomTitleBarPreference(platform: string): boolean {
  return supportsCustomTitleBar(platform);
}

/**
 * Whether the BrowserWindow should be created with `frame: false`.
 * `preference` is `null` when the user has never set an explicit value.
 */
export function resolveCustomTitleBarActive(input: {
  readonly platform: string;
  readonly preference: boolean | null;
}): boolean {
  if (!supportsCustomTitleBar(input.platform)) {
    return false;
  }
  if (input.preference === null) {
    return defaultCustomTitleBarPreference(input.platform);
  }
  return input.preference;
}
