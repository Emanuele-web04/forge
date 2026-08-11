// FILE: nativeSurfaceOcclusion.ts
// Purpose: Notify native Electron surfaces when a DOM overlay starts or stops obscuring them.
// Layer: Web cross-surface coordination

// Electron WebContentsViews render above the DOM regardless of CSS z-index. DOM overlays
// broadcast this event so BrowserPanel can hide or restore its native surface after the
// overlay has been committed.
export const NATIVE_SURFACE_OCCLUSION_SYNC_EVENT = "synara:native-surface-occlusion-sync";

export function notifyNativeSurfaceOcclusionChange(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT));
}
