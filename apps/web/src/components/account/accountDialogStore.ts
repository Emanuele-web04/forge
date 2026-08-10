// FILE: accountDialogStore.ts
// Purpose: Owns the single global account sign-in / onboarding dialog state, so the
// sidebar footer, the signed-out menu, and a finished sign-in can all drive one modal.
// Layer: Web UI state (mirrors feedbackDialogStore).

import { create } from "zustand";

type AccountDialogView = "closed" | "sign-in" | "onboarding";

interface AccountDialogStore {
  view: AccountDialogView;
  openSignIn: () => void;
  openOnboarding: () => void;
  close: () => void;
}

export const useAccountDialogStore = create<AccountDialogStore>((set) => ({
  view: "closed",
  openSignIn: () => set({ view: "sign-in" }),
  openOnboarding: () => set({ view: "onboarding" }),
  close: () => set({ view: "closed" }),
}));
