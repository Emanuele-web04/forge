// FILE: chatRouteRecovery.ts
// Purpose: Gives route restore flows one authoritative backend refresh before falling back.
// Layer: Routing support
// Exports: empty-startup snapshot recovery helper shared by chat index and thread routes.

import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@synara/contracts";

import { EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS } from "./chatRouteRestore";
import { requestEmptyRouteRestoreRefresh } from "./routeRestoreRefreshCoordinator";
import { useStore } from "./store";

function shellSnapshotHasProjectsOrThreads(snapshot: OrchestrationShellSnapshot): boolean {
  return snapshot.projects.length > 0 || snapshot.threads.length > 0;
}

function shellSnapshotHasThreads(snapshot: OrchestrationShellSnapshot): boolean {
  return snapshot.threads.length > 0;
}

function readModelHasProjectsOrThreads(snapshot: OrchestrationReadModel): boolean {
  return snapshot.projects.length > 0 || snapshot.threads.length > 0;
}

function readModelHasThreads(snapshot: OrchestrationReadModel): boolean {
  return snapshot.threads.length > 0;
}

export function waitForEmptyRouteRestoreFallbackDelay(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS);
  });
}

/**
 * Home/sidebar stuck case: projects hydrated, threads empty.
 * Only pulls shell + full snapshot; never repairState (projects-only rebuild).
 * Only syncs payloads that actually include threads, so a project-only response
 * cannot wipe a concurrent thread upsert.
 */
export async function refreshMissingThreadSnapshots(api: NativeApi | undefined): Promise<boolean> {
  if (!api) {
    return false;
  }

  const shellSnapshot = await api.orchestration.getShellSnapshot();
  if (shellSnapshotHasThreads(shellSnapshot)) {
    useStore.getState().syncServerShellSnapshot(shellSnapshot);
    return true;
  }

  const readModel = await api.orchestration.getSnapshot();
  if (readModelHasThreads(readModel)) {
    useStore.getState().syncServerReadModel(readModel);
    return true;
  }

  return false;
}

// Empty shell snapshots can arrive before desktop projection startup catches up.
// Try progressively stronger reads so route guards do not replace valid thread URLs.
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
