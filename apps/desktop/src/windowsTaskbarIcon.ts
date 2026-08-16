// FILE: windowsTaskbarIcon.ts
// Purpose: Force the Windows shell to re-read the taskbar icon after a runtime change.
// Layer: Desktop-native preference logic

import type { BrowserWindow } from "electron";

// Explorer coalesces a synchronous setSkipTaskbar(true) -> setSkipTaskbar(false)
// toggle and keeps rendering its cached button icon, so the button must stay
// detached long enough for the shell to process the removal before it is
// re-registered and re-reads the window icon.
const WINDOWS_TASKBAR_ICON_REFRESH_DELAY_MS = 250;

export function refreshWindowsTaskbarIcon(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || !window.isVisible()) {
    return;
  }
  window.setSkipTaskbar(true);
  setTimeout(() => {
    if (!window.isDestroyed()) {
      window.setSkipTaskbar(false);
    }
  }, WINDOWS_TASKBAR_ICON_REFRESH_DELAY_MS);
}
