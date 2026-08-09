// FILE: useDesktopAppIcon.ts
// Purpose: Keep the persisted app-icon preference applied to the native desktop shell.
// Layer: Web-to-desktop lifecycle bridge

import { useEffect } from "react";

import type { DesktopAppIcon } from "@synara/contracts";
import { useAppSettings } from "~/appSettings";

let lastAppliedIcon: DesktopAppIcon | null = null;

export function useDesktopAppIcon(): void {
  const { settings } = useAppSettings();

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || lastAppliedIcon === settings.desktopAppIcon) return;

    lastAppliedIcon = settings.desktopAppIcon;
    void bridge.setAppIcon(settings.desktopAppIcon).catch(() => {
      if (lastAppliedIcon === settings.desktopAppIcon) {
        lastAppliedIcon = null;
      }
    });
  }, [settings.desktopAppIcon]);
}
