// FILE: desktopZoom.ts
// Purpose: Single renderer-side accessor for the Electron shell's page zoom factor.
// Layer: Web shell utility
// Depends on: desktopBridge preload API, shared desktop chrome geometry.
//
// Why this exists:
//   Zoom is the conversion factor between the renderer's CSS pixels and the window
//   DIPs that native surfaces (traffic lights, the native browser WebContentsView)
//   are positioned in. Every consumer needs the same defensive read — the preload
//   bridge can be absent (web build) or predate the zoom channel — so the read and
//   the subscription live here instead of being re-derived per call site.

import { normalizeDesktopZoomFactor } from "@synara/shared/desktopChrome";

/** Current shell zoom factor, or 1 when the desktop bridge cannot report one. */
export function readDesktopZoomFactor(): number {
  const bridge = window.desktopBridge;
  if (!bridge?.getZoomFactor) return 1;
  return normalizeDesktopZoomFactor(bridge.getZoomFactor());
}

/**
 * Subscribe to shell zoom changes. Returns an unsubscribe function; when the bridge
 * cannot report zoom the listener simply never fires.
 */
export function subscribeDesktopZoomFactor(listener: (zoomFactor: number) => void): () => void {
  const bridge = window.desktopBridge;
  const unsubscribe = bridge?.onZoomFactorChange?.((zoomFactor) => {
    listener(normalizeDesktopZoomFactor(zoomFactor));
  });
  return () => {
    unsubscribe?.();
  };
}
