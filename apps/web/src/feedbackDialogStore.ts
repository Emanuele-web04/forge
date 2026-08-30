// FILE: feedbackDialogStore.ts
// Purpose: Owns the single global Feedback Synara dialog state.
// Layer: Web UI state
// Depends on: The feedback feature context and category contracts and Zustand.

import { create } from "zustand";

import type { FeedbackCategory } from "./feedback";
import type { FeedbackThreadContext } from "./feedback";

interface FeedbackDialogStore {
  isOpen: boolean;
  context: FeedbackThreadContext | null;
  initialCategory: FeedbackCategory | null;
  openDialog: (context?: FeedbackThreadContext, initialCategory?: FeedbackCategory) => void;
  setOpen: (open: boolean) => void;
}

export const useFeedbackDialogStore = create<FeedbackDialogStore>((set) => ({
  isOpen: false,
  context: null,
  initialCategory: null,
  openDialog: (context, initialCategory) =>
    set({
      isOpen: true,
      context: context ?? null,
      initialCategory: initialCategory ?? null,
    }),
  setOpen: (open) =>
    set(
      open
        ? { isOpen: true }
        : {
            isOpen: false,
            context: null,
            initialCategory: null,
          },
    ),
}));
