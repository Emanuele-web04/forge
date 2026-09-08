// FILE: useComputerEventBridge.ts
// Purpose: Capture computer events globally and deliver deferred pane requests to a chat surface.
// Layer: Web event bridge hook
// Exports: useComputerEventBridge, useComputerPaneOpenRequests
// Depends on: nativeApi computer.onEvent, computerStateStore
//
// Mirrors useDeviceEventBridge: the computer engine lives in apps/server, so the
// open-pane signal is a WebSocket push and this works in a plain browser tab as
// well as the desktop app.

import type { ComputerOpenPaneRequestedEvent } from "@synara/contracts";
import { useEffect, useEffectEvent } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { useComputerStateStore } from "../computerStateStore";

/** Mounted once by EventRouter, including while settings or split view is open. */
export function useComputerEventBridge(): void {
  useEffect(() => {
    const api = ensureNativeApi();
    if (!api.computer) {
      return;
    }
    const unsubscribe = api.computer.onEvent((event) => {
      const store = useComputerStateStore.getState();
      switch (event.type) {
        case "computer.thread-state":
          store.upsertThreadState(event.state);
          break;
        case "computer.windows-changed":
          store.applyWindowsChanged(event.windows);
          break;
        case "computer.action":
          store.recordAction(event);
          break;
        case "computer.open-pane-requested":
          // The server sends this once per thread. Retain it until a surface
          // can honor it, even if automatic opening is currently off.
          store.queueOpenRequest(event);
          break;
        case "computer.frame":
          break;
      }
    });
    return unsubscribe;
  }, []);
}

export function useComputerPaneOpenRequests(input: {
  /** Null while automatic opening is disabled or the surface cannot host a computer pane. */
  readonly onOpenPaneRequested: ((event: ComputerOpenPaneRequestedEvent) => void) | null;
}): void {
  const pendingOpenRequests = useComputerStateStore((store) => store.pendingOpenRequests);
  const openEnabled = input.onOpenPaneRequested !== null;
  const deliverPendingRequests = useEffectEvent(() => {
    const onOpen = input.onOpenPaneRequested;
    if (!onOpen) return;
    // Consume before delivery so remounting or closing a pane never replays it.
    for (const event of useComputerStateStore.getState().takeOpenRequests()) onOpen(event);
  });

  useEffect(() => {
    if (openEnabled) deliverPendingRequests();
  }, [openEnabled, pendingOpenRequests]);
}
