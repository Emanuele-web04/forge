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
