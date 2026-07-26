// FILE: browserShortcuts.ts
// Purpose: Shared key-chord matching for in-app browser shortcuts so the renderer and
//   desktop main process agree on the same bindings without duplicating modifier logic.
// Layer: Shared runtime utility
// Depends on: nothing

export const BROWSER_COPY_LINK_TOAST_TITLE = "Link copied";

// Normalized chord shape both Electron `Input` events and DOM KeyboardEvents map onto.
export interface BrowserShortcutChord {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
  readonly code?: string;
  readonly type?: string;
  readonly repeat?: boolean;
}

export interface KeyboardShortcutPlatform {
  readonly isMac: boolean;
  readonly isWindows: boolean;
}

// Copy-link chord: Cmd+Shift+C on macOS, Ctrl+Shift+C elsewhere.
export function isBrowserCopyLinkChord(chord: BrowserShortcutChord, isMac: boolean): boolean {
  if (chord.key.toLowerCase() !== "c") {
    return false;
  }
  if (!chord.shift || chord.alt) {
    return false;
  }
  return isMac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta;
}

export function isKeyboardShortcutsHelpChord(
  chord: BrowserShortcutChord,
  platform: KeyboardShortcutPlatform,
): boolean {
  if (
    (chord.type !== undefined && chord.type.toLowerCase() !== "keydown") ||
    chord.shift ||
    chord.alt ||
    chord.repeat
  ) {
    return false;
  }

  // Some Windows layouts translate Ctrl+- to "/" while retaining the physical
  // minus code. Outside Windows, "/" stays authoritative for remapped layouts.
  if (
    chord.key === "-" ||
    (platform.isWindows && (chord.code === "Minus" || chord.code === "NumpadSubtract"))
  ) {
    return false;
  }

  const isSlash = chord.code === "Slash" || chord.code === "NumpadDivide" || chord.key === "/";
  if (!isSlash) {
    return false;
  }

  return platform.isMac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta;
}
