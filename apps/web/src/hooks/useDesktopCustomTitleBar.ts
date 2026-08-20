// FILE: useDesktopCustomTitleBar.ts
// Purpose: Track whether the live Electron window is using the frameless custom title bar.
// Layer: Shared web shell chrome
// Depends on: desktop bridge customTitleBar IPC.

import { useEffect, useState } from "react";

import type { DesktopCustomTitleBarState } from "@synara/contracts";

import { isElectron } from "~/env";
import { getNavigatorPlatform, isLinuxPlatform, isWindowsPlatform } from "~/lib/utils";

const DEFAULT_STATE: DesktopCustomTitleBarState = {
  supported: false,
  preference: true,
  active: false,
  restartRequired: false,
};

/**
 * Optimistic default before the bridge replies. Matches the shared platform
 * default (custom title bar on for Windows/Linux) so gutters and caption
 * buttons appear without a one-frame flash on the common path.
 */
export function initialDesktopCustomTitleBarActive(): boolean {
  if (!isElectron) return false;
  const platform = getNavigatorPlatform();
  return isWindowsPlatform(platform) || isLinuxPlatform(platform);
}

export function useDesktopCustomTitleBarState(): DesktopCustomTitleBarState {
  const [state, setState] = useState<DesktopCustomTitleBarState>(() => {
    const active = initialDesktopCustomTitleBarActive();
    return {
      ...DEFAULT_STATE,
      active,
      supported: active,
    };
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.customTitleBar;
    if (!bridge) return;
    let cancelled = false;

    void bridge.getState().then((next) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function useDesktopCustomTitleBarActive(): boolean {
  return useDesktopCustomTitleBarState().active;
}
