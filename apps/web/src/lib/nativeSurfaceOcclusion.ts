// FILE: nativeSurfaceOcclusion.ts
// Purpose: Notify native Electron surfaces when a DOM overlay starts or stops obscuring them.
// Layer: Web cross-surface coordination

// Electron WebContentsViews render above the DOM regardless of CSS z-index. DOM overlays
// broadcast this event so BrowserPanel can hide or restore its native surface after the
// overlay has been committed.
export const NATIVE_SURFACE_OCCLUSION_SYNC_EVENT = "synara:native-surface-occlusion-sync";
export const NATIVE_SURFACE_MENU_OVERLAY_SELECTOR = "[data-slot='menu-positioner']";

export function notifyNativeSurfaceOcclusionChange(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT));
}

/** React callback ref: track only the mounted popup, not mutations across the app. */
export function observeNativeSurfaceOverlay(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return;
  const resizeObserver = new ResizeObserver(notifyNativeSurfaceOcclusionChange);
  const mutationObserver = new MutationObserver(notifyNativeSurfaceOcclusionChange);
  resizeObserver.observe(element);
  // Positioners can move or become hidden without resizing, including collision
  // adjustments and keep-mounted menus. Their style changes must resync too.
  mutationObserver.observe(element, { attributes: true });
  notifyNativeSurfaceOcclusionChange();
  return () => {
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    notifyNativeSurfaceOcclusionChange();
  };
}
