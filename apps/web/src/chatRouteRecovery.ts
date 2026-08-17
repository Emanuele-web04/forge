// FILE: chatRouteRecovery.ts
// Purpose: Gives route restore flows one authoritative backend refresh before falling back.
// Layer: Routing support
// Exports: empty-startup snapshot recovery helper shared by chat index and thread routes.

import type { NativeApi } from "@synara/contracts";

import { EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS } from "./chatRouteRestore";
import { requestEmptyRouteRestoreRefresh } from "./routeRestoreRefreshCoordinator";

export function waitForEmptyRouteRestoreFallbackDelay(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS);
  });
}

// EventRouter owns the live shell sequence fence. Route restore must request its
// recovery path instead of applying backend snapshots directly to the store.
export async function refreshEmptyRouteRestoreSnapshot(
  api: NativeApi | undefined,
): Promise<boolean> {
  if (!api) {
    return false;
  }

  return await requestEmptyRouteRestoreRefresh();
}
