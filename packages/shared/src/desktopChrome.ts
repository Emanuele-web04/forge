// FILE: desktopChrome.ts
// Purpose: Single source of truth for the macOS desktop top-bar chrome geometry that
//          BOTH the Electron main process and the web renderer must agree on.
// Layer: Shared runtime utilities (no deps; safe to import from main + renderer)
//
// Why this exists:
//   The native macOS traffic lights are placed by the Electron main process
//   (apps/desktop), while the chrome bar they must visually sit inside is rendered by
//   the web app (apps/web). Their vertical centers only line up if the two packages
//   agree on the header height and the dot size. These used to be two hand-synced
//   magic numbers in different packages and silently drifted (a 12px-dot assumption
//   left the lights 1px below the controls). Deriving everything from the constants
//   here keeps them locked together: change the height/radius once, in this file.

/**
 * Height (px) of the chat-surface top chrome bar — the row shared by the chat,
 * settings, workspace, and (open) sidebar headers. The web side renders this as the
 * Tailwind class `h-[46px]` (kept literal so Tailwind can scan it; guarded against
 * drift from this number in apps/web/.../chatHeaderControls.tsx).
 */
export const CHAT_SURFACE_HEADER_HEIGHT_PX = 46;

/** Leading inset (px) of the macOS traffic-light cluster from the window's left edge. */
export const MAC_TRAFFIC_LIGHT_INSET_X_PX = 16;

/**
 * Radius (px) of a single macOS traffic-light dot. The dot measures ~14px across, so
 * its radius is 7 — using 6 (a 12px-dot assumption) is what previously misaligned the
 * lights against the renderer's leading controls.
 */
export const MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX = 7;

/**
 * Native `trafficLightPosition` for `BrowserWindow` so the dot's center lands exactly
 * on the header's vertical center:
 *   dotCenterY    = y + radius
 *   headerCenterY = height / 2
 *   ⇒ y = height / 2 − radius
 * A smaller header (or a smaller y) also pulls the whole cluster closer to the top
 * edge while staying centered on the controls.
 */
export function getMacTrafficLightPosition(): { x: number; y: number } {
  return {
    x: MAC_TRAFFIC_LIGHT_INSET_X_PX,
    y: Math.round(CHAT_SURFACE_HEADER_HEIGHT_PX / 2 - MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX),
  };
}

/**
 * Leading inset (CSS px at zoom 1) from the window's left edge to the sidebar toggle /
 * route-nav cluster on macOS Electron. Native traffic lights do not scale with
 * `webContents` zoom, so callers divide this by the live zoom factor.
 */
export const MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX = 90;

/** CSS custom property written by the web shell when macOS desktop zoom changes. */
export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR =
  "--desktop-top-bar-traffic-light-gutter";

/**
 * Coerce an untrusted zoom factor (missing bridge, stale IPC payload) to a usable
 * multiplier. Every zoom-aware conversion in this file funnels through here so a
 * bogus value degrades to "no zoom" instead of collapsing geometry to 0 or NaN.
 */
export function normalizeDesktopZoomFactor(zoomFactor: unknown): number {
  return typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0
    ? zoomFactor
    : 1;
}

/**
 * Gutter width in layout CSS pixels for the current page zoom factor.
 * Inverse-scales so the on-screen gap stays aligned with the native lights.
 */
export function resolveMacDesktopTopBarTrafficLightGutterCssPx(zoomFactor: number): number {
  return Math.round(
    MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX / normalizeDesktopZoomFactor(zoomFactor),
  );
}

/** Axis-aligned rectangle, in whichever pixel space the caller is working in. */
export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Convert a renderer rectangle (`getBoundingClientRect()`, i.e. layout CSS pixels)
 * into the window-relative DIPs that Electron's native view APIs expect.
 *
 * `webContents` zoom scales the renderer's CSS pixel against the window's DIP grid:
 * at zoom z, one CSS px covers z DIPs, so a slot measured as `w` CSS px physically
 * spans `w * z` DIPs. Native views (`WebContentsView.setBounds`, `BrowserWindow`
 * bounds) are never zoomed, so handing them raw CSS numbers makes them miss their
 * DOM slot by exactly `1 / z` — the native browser view overflows the panel when the
 * shell is zoomed out and under-fills it when zoomed in.
 */
export function resolveDesktopDipRectFromCssRect(
  rect: DesktopRect,
  zoomFactor: number,
): DesktopRect {
  const safeZoom = normalizeDesktopZoomFactor(zoomFactor);
  if (safeZoom === 1) {
    return rect;
  }
  return {
    x: rect.x * safeZoom,
    y: rect.y * safeZoom,
    width: rect.width * safeZoom,
    height: rect.height * safeZoom,
  };
}
