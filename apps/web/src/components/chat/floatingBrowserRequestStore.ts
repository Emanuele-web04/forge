// FILE: floatingBrowserRequestStore.ts
// Purpose: Remember which threads have an undocked floating browser across route changes.
// Layer: Chat surface UI state
// A background agent can open a page while another chat is focused. The request
// must survive that visit — and survive a temporarily visible dock browser — so
// the card returns when the owning thread is shown without a docked live guest.

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface FloatingBrowserRequestStore {
  requestedByThreadId: Record<string, true | undefined>;
  request: (threadId: ThreadId) => void;
  dismiss: (threadId: ThreadId) => void;
}

export const useFloatingBrowserRequestStore = create<FloatingBrowserRequestStore>((set) => ({
  requestedByThreadId: {},
  request: (threadId) =>
    set((current) => {
      if (current.requestedByThreadId[threadId]) {
        return current;
      }
      return {
        requestedByThreadId: {
          ...current.requestedByThreadId,
          [threadId]: true,
        },
      };
    }),
  dismiss: (threadId) =>
    set((current) => {
      if (!current.requestedByThreadId[threadId]) {
        return current;
      }
      const requestedByThreadId = { ...current.requestedByThreadId };
      delete requestedByThreadId[threadId];
      return { requestedByThreadId };
    }),
}));

export function selectFloatingBrowserRequested(
  threadId: ThreadId,
): (store: FloatingBrowserRequestStore) => boolean {
  return (store) => store.requestedByThreadId[threadId] === true;
}
