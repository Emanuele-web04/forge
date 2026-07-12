// FILE: chatRouteRecovery.ts
// Purpose: Gives route restore flows one authoritative backend refresh before falling back.
// Layer: Routing support
// Exports: empty-startup snapshot recovery helper shared by chat index and thread routes.

import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@synara/contracts";

import { hasLiveThreadsWithMissingProjects } from "./lib/desktopProjectRecovery";
import { EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS } from "./chatRouteRestore";
import { requestRepairState } from "./shellRefreshCoordinator";
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

function readModelHasLiveThreads(snapshot: OrchestrationReadModel): boolean {
  return snapshot.threads.some((thread) => thread.deletedAt == null);
}

export function waitForEmptyRouteRestoreFallbackDelay(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS);
  });
}

/**
 * Fetch-only ladder for projects-present / threads-empty.
 * Does not write the store — EventRouter applies via requestShellRefresh.
 * Incomplete shells (threads without projects) escalate; incomplete read models
 * return repair-projects so the refresh path repairs without installing them.
 */
export async function fetchMissingThreadSnapshots(
  api: NativeApi,
): Promise<
  | { kind: "shell"; snapshot: OrchestrationShellSnapshot }
  | { kind: "readModel"; snapshot: OrchestrationReadModel }
  | { kind: "repair-projects" }
  | { kind: "none" }
> {
  const shellSnapshot = await api.orchestration.getShellSnapshot();
  if (shellSnapshotHasThreads(shellSnapshot) && !hasLiveThreadsWithMissingProjects(shellSnapshot)) {
    return { kind: "shell", snapshot: shellSnapshot };
  }

  const readModel = await api.orchestration.getSnapshot();
  if (readModelHasLiveThreads(readModel)) {
    if (hasLiveThreadsWithMissingProjects(readModel)) {
      return { kind: "repair-projects" };
    }
    return { kind: "readModel", snapshot: readModel };
  }

  return { kind: "none" };
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

  const shellSnapshot = await api.orchestration.getShellSnapshot();
  if (shellSnapshotHasProjectsOrThreads(shellSnapshot)) {
    useStore.getState().syncServerShellSnapshot(shellSnapshot);
    if (shellSnapshotHasThreads(shellSnapshot)) {
      return true;
    }
    // Project-only shell snapshots do not prove route recovery is done; thread
    // projections may still need the full snapshot or repair path below.
  }

  const readModel = await api.orchestration.getSnapshot();
  if (readModelHasProjectsOrThreads(readModel)) {
    useStore.getState().syncServerReadModel(readModel);
    if (readModelHasLiveThreads(readModel)) {
      return true;
    }
    // A project-only read model can still be repaired into thread projections.
  }

  const repairedReadModel = await requestRepairState(api);
  if (readModelHasProjectsOrThreads(repairedReadModel)) {
    useStore.getState().syncServerReadModel(repairedReadModel);
  }
  if (readModelHasLiveThreads(repairedReadModel)) {
    return true;
  }

  return false;
}

export { readModelHasLiveThreads, shellSnapshotHasThreads };
