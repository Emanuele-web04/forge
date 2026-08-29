// FILE: floatingBrowserRequestStore.ts
// Purpose: Remember which threads have an undocked floating browser across route changes,
//   including the last card rect so switching chats does not reset placement.
// Layer: Chat surface UI state
// A background agent can open a page while another chat is focused. The request
// must survive that visit — and survive a temporarily visible dock browser — so
// the card returns when the owning thread is shown without a docked live guest.

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

import type { FloatingBrowserPanelRect } from "./floatingBrowserPanel.logic";

interface FloatingBrowserRequestStore {
  requestedByThreadId: Record<string, true | undefined>;
  rectByThreadId: Record<string, FloatingBrowserPanelRect | undefined>;
  request: (threadId: ThreadId) => void;
  dismiss: (threadId: ThreadId) => void;
  rememberRect: (threadId: ThreadId, rect: FloatingBrowserPanelRect) => void;
}

function sameFloatingBrowserPanelRect(
  left: FloatingBrowserPanelRect | undefined,
  right: FloatingBrowserPanelRect,
): boolean {
  return (
    left !== undefined &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

export const useFloatingBrowserRequestStore = create<FloatingBrowserRequestStore>((set) => ({
  requestedByThreadId: {},
  rectByThreadId: {},
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
      if (
        !current.requestedByThreadId[threadId] &&
        current.rectByThreadId[threadId] === undefined
      ) {
        return current;
      }
      const requestedByThreadId = { ...current.requestedByThreadId };
      const rectByThreadId = { ...current.rectByThreadId };
      delete requestedByThreadId[threadId];
      delete rectByThreadId[threadId];
      return { requestedByThreadId, rectByThreadId };
    }),
  rememberRect: (threadId, rect) =>
    set((current) => {
      if (sameFloatingBrowserPanelRect(current.rectByThreadId[threadId], rect)) {
        return current;
      }
      return {
        rectByThreadId: {
          ...current.rectByThreadId,
          [threadId]: rect,
        },
      };
    }),
}));

export function selectFloatingBrowserRequested(
  threadId: ThreadId,
): (store: FloatingBrowserRequestStore) => boolean {
  return (store) => store.requestedByThreadId[threadId] === true;
}

export function selectFloatingBrowserPanelRect(
  threadId: ThreadId,
): (store: FloatingBrowserRequestStore) => FloatingBrowserPanelRect | undefined {
  return (store) => store.rectByThreadId[threadId];
}
