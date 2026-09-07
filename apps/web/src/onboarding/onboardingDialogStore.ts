// FILE: onboardingDialogStore.ts
// Purpose: Open/close state for the welcome tour shared between the first-run gate, the
//          Settings "replay" button, and the dialog itself.
// Layer: Web UI store

import { create } from "zustand";

export type OnboardingOpenReason = "first-run" | "replay";

interface OnboardingDialogStore {
  isOpen: boolean;
  /** Why the dialog is open; null when closed. */
  openReason: OnboardingOpenReason | null;
  /**
   * True once the user reached a setup step. A first-run dialog opened from a
   * provisional (possibly transient) empty snapshot may be auto-closed when later
   * authoritative data proves the install is not new, but never once the user has
   * started making choices in it.
   */
  engaged: boolean;
  open: (reason: OnboardingOpenReason) => void;
  /** Settings → "Open welcome tour". */
  openDialog: () => void;
  close: () => void;
  markEngaged: () => void;
}

export const useOnboardingDialogStore = create<OnboardingDialogStore>((set) => ({
  isOpen: false,
  openReason: null,
  engaged: false,
  open: (reason) => set({ isOpen: true, openReason: reason, engaged: false }),
  openDialog: () => set({ isOpen: true, openReason: "replay", engaged: false }),
  close: () => set({ isOpen: false, openReason: null, engaged: false }),
  markEngaged: () => set({ engaged: true }),
}));
