// FILE: useDesktopTopBarGutter.ts
// Purpose: Decide when desktop top bars must clear the macOS traffic light buttons.
// Layer: Shared web shell chrome
// Depends on: sidebar context, electron env detection.

import {
  DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "@synara/shared/desktopChrome";
import { useLayoutEffect } from "react";

import { isElectron } from "~/env";
import { useSidebar } from "~/components/ui/sidebar";
import { useDesktopCustomTitleBarActive } from "~/hooks/useDesktopCustomTitleBar";
import { readDesktopZoomFactor, subscribeDesktopZoomFactor } from "~/lib/desktopZoom";
import { isMacNavigatorPlatform } from "~/lib/utils";

/**
 * Class name backed by `index.css` (not Tailwind) so the gutter survives zoom
 * retuning via {@link DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR}.
 */
export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS = "desktop-top-bar-traffic-light-gutter";

/**
 * Pure helper: should a top bar at the left edge of the desktop window reserve
 * space for the macOS traffic light buttons?
 *
 * The traffic lights live in the renderer area (titleBarStyle = "hiddenInset"),
 * so any chrome surface that sits flush against the window's left edge needs a
 * gutter, or its leading controls will collide with the close/minimize/zoom
 * buttons. The sidebar always sits on the left and provides that gutter while it
 * is open; when it is collapsed — or on mobile, where the drawer floats over
 * content instead of reserving a column — the next surface to the right has to
 * provide it instead.
 */
export function shouldReserveDesktopTopBarTrafficLightGutter(input: {
  isElectron: boolean;
  isMacDesktop: boolean;
  sidebarOpen: boolean;
  isMobile: boolean;
}): boolean {
  if (!input.isElectron) return false;
  if (!input.isMacDesktop) return false;
  // Mobile drawers float above content rather than reserving a column,
  // so the chat header always owns the left edge in that mode.
  if (input.isMobile) return true;
  return !input.sidebarOpen;
}

function applyTrafficLightGutterCssVar(zoomFactor: number): void {
  document.documentElement.style.setProperty(
    DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR,
    `${resolveMacDesktopTopBarTrafficLightGutterCssPx(zoomFactor)}px`,
  );
}

/**
 * Keeps the macOS traffic-light gutter CSS variable aligned with Electron page zoom.
 * Mount once near the app root (see `__root.tsx`).
 */
export function useSyncDesktopTopBarTrafficLightGutterZoom(): void {
  const isMacDesktop = isMacNavigatorPlatform();

  useLayoutEffect(() => {
    if (!isElectron || !isMacDesktop) {
      return;
    }

    applyTrafficLightGutterCssVar(readDesktopZoomFactor());

    const unsubscribe = subscribeDesktopZoomFactor(applyTrafficLightGutterCssVar);

    // Preload can attach after the first layout pass; re-apply on the next frame.
    const frame = requestAnimationFrame(() => {
      applyTrafficLightGutterCssVar(readDesktopZoomFactor());
    });

    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      document.documentElement.style.removeProperty(DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR);
    };
  }, [isMacDesktop]);
}

/**
 * React hook variant of {@link shouldReserveDesktopTopBarTrafficLightGutter}
 * that returns the gutter className (or `null` when no gutter is needed).
 *
 * Use this for any chrome surface whose top bar can sit flush against the
 * window's left edge: chat header, settings header, workspace header, etc.
 */
export function useDesktopTopBarTrafficLightGutterClassName(): string | null {
  const { isMobile, open } = useSidebar();
  const isMacDesktop = isMacNavigatorPlatform();
  return shouldReserveDesktopTopBarTrafficLightGutter({
    isElectron,
    isMacDesktop,
    sidebarOpen: open,
    isMobile,
  })
    ? DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS
    : null;
}

/**
 * Tailwind padding that clears the frameless caption-button cluster.
 *
 * On Windows/Linux the Electron shell can be frameless (`frame: false`, see
 * apps/desktop main) and the renderer owns the minimize/maximize/close buttons.
 * They are rendered ONCE as a viewport-fixed cluster pinned to the window's
 * top-right corner (see {@link DesktopWindowControls} mounted in the root route),
 * mirroring how macOS insets its traffic lights at the top-left.
 *
 * Each caption button is 46px wide (matching {@link CHAT_SURFACE_HEADER_HEIGHT_PX}),
 * so the three-button cluster spans 138px. Any top bar that can sit flush against
 * the window's right edge reserves that width here so its trailing controls never
 * slide underneath the floating buttons.
 *
 * The `!` (important) modifier is required for the same reason as the traffic-light
 * gutter: host headers carry their own `px-*` padding that `twMerge` does not treat
 * as conflicting with `pr-*`, so the override must win the cascade outright. Both the
 * base and `sm:` variants are emitted so it also beats `sm:px-*`.
 */
export const DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS = "pr-[138px]! sm:pr-[138px]!";

/**
 * Pure helper: should a top bar at the right edge of the desktop window reserve
 * space for the custom caption buttons? Unlike the macOS traffic lights (whose
 * column is usually owned by the sidebar), the caption cluster always floats at
 * the window's top-right, so every right-flush chrome surface reserves the gutter
 * whenever the live window is frameless.
 */
export function shouldReserveDesktopTopBarWindowControlsGutter(input: {
  isElectron: boolean;
  customTitleBarActive: boolean;
}): boolean {
  return input.isElectron && input.customTitleBarActive;
}

/**
 * React hook variant of {@link shouldReserveDesktopTopBarWindowControlsGutter}
 * that returns the gutter className (or `null` when no gutter is needed).
 *
 * Use this for any chrome surface whose top bar can sit flush against the window's
 * right edge: chat header, workspace header, plugin nav, the right dock header, etc.
 */
export function useDesktopTopBarWindowControlsGutterClassName(): string | null {
  const customTitleBarActive = useDesktopCustomTitleBarActive();
  return shouldReserveDesktopTopBarWindowControlsGutter({
    isElectron,
    customTitleBarActive,
  })
    ? DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS
    : null;
}
