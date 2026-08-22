// FILE: useDeviceEventBridge.ts
// Purpose: Route the server's device.event push into the device state store and the dock.
// Layer: Web event bridge hook
// Exports: useDeviceEventBridge
// Depends on: nativeApi device.onEvent, deviceStateStore
//
// The browser pane gets its open requests over desktop IPC; the device engine
// lives in apps/server, so the equivalent signal is a WebSocket push and this
// works in a plain browser tab as well as the desktop app.

import type { DeviceOpenPaneRequestedEvent } from "@synara/contracts";
import { useEffect, useEffectEvent } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { useDeviceStateStore } from "../deviceStateStore";

export function useDeviceEventBridge(input: {
  /** Null while the surface cannot host a device pane (non-macOS server). */
  readonly onOpenPaneRequested: ((event: DeviceOpenPaneRequestedEvent) => void) | null;
}): void {
  const { onOpenPaneRequested } = input;
  const handleOpen = useEffectEvent((event: DeviceOpenPaneRequestedEvent) =>
    onOpenPaneRequested?.(event),
  );
  const openEnabled = onOpenPaneRequested !== null;

  useEffect(() => {
    // The state half of the subscription runs regardless of whether this surface
    // can open panes: a pane on another thread still needs fresh state, and the
    // store is version-gated so duplicate delivery is harmless.
    const unsubscribe = ensureNativeApi().device.onEvent((event) => {
      if (event.type === "device.thread-state") {
        useDeviceStateStore.getState().upsertThreadState(event.state);
        return;
      }
      if (openEnabled) handleOpen(event);
    });
    return () => {
      unsubscribe();
    };
  }, [openEnabled]);
}
