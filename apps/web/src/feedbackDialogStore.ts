// FILE: feedbackDialogStore.ts
// Purpose: Owns the single global Feedback Synara dialog state.
// Layer: Web UI state
// Depends on: The feedback feature context contract and Zustand.

import { create } from "zustand";

import type { FeedbackThreadContext } from "./feedback";

interface FeedbackDialogStore {
  isOpen: boolean;
  context: FeedbackThreadContext | null;
  openDialog: (context?: FeedbackThreadContext) => void;
  setOpen: (open: boolean) => void;
}

export const useFeedbackDialogStore = create<FeedbackDialogStore>((set) => ({
  isOpen: false,
  context: null,
  openDialog: (context) => set({ isOpen: true, context: context ?? null }),
  setOpen: (open) => set(open ? { isOpen: true } : { isOpen: false, context: null }),
}));
