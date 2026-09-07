// FILE: onboardingDialogStore.ts
// Purpose: Imperative "open the welcome tour" signal so Settings can replay it without
//          threading callbacks through the router tree.
// Layer: Web UI store

import { create } from "zustand";

interface OnboardingDialogStore {
  isOpen: boolean;
  openDialog: () => void;
  setOpen: (open: boolean) => void;
}

export const useOnboardingDialogStore = create<OnboardingDialogStore>((set) => ({
  isOpen: false,
  openDialog: () => set({ isOpen: true }),
  setOpen: (open) => set({ isOpen: open }),
}));
