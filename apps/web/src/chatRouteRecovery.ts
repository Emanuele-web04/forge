// FILE: chatRouteRecovery.ts
// Purpose: Gives route restore flows one authoritative backend refresh before falling back.
// Layer: Routing support
// Exports: empty-startup snapshot recovery helper shared by chat index and thread routes.

import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@synara/contracts";

import {
  hasClientLiveThreadEvidence,
  hasLiveThreadsWithMissingProjects,
  resolveRepairedShellApplication,
} from "./lib/desktopProjectRecovery";
import { EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS } from "./chatRouteRestore";
import {
  getRecoveryMutationLease,
  isShellSnapshotApplyRegistered,
  requestRepairState,
  tryApplyShellSnapshot,
} from "./shellRefreshCoordinator";
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
// Route restores can race with DesktopProjectBootstrap recovery; if the recovery
// lease is bumped while we're in flight, discard stale results so the recovery
// retry path stays in control.
export async function refreshEmptyRouteRestoreSnapshot(
  api: NativeApi | undefined,
): Promise<boolean> {
  if (!api) {
    return false;
  }
  // Hydration owns the store but the fenced apply is unavailable (EventRouter
  // remount window): every install below is either unfenced or escalates to
  // one, so install nothing and report not-done. The caller retries after
  // remount, when the registered apply preserves newer thread detail.
  if (useStore.getState().threadsHydrated === true && !isShellSnapshotApplyRegistered()) {
    return false;
  }

  const lease = getRecoveryMutationLease();
  const shellSnapshot = await api.orchestration.getShellSnapshot();
  if (lease !== getRecoveryMutationLease()) {
    return false;
  }
  if (shellSnapshotHasProjectsOrThreads(shellSnapshot)) {
    // The registered apply preserves newer thread detail and runs draft
    // promotion; the direct write below only runs before hydration, when no
    // detail can exist yet.
    if (isShellSnapshotApplyRegistered()) {
      tryApplyShellSnapshot(shellSnapshot);
    } else {
      useStore.getState().syncServerShellSnapshot(shellSnapshot);
    }
    if (shellSnapshotHasThreads(shellSnapshot)) {
      return true;
    }
    // Project-only shell snapshots do not prove route recovery is done; thread
    // projections may still need the full snapshot or repair path below.
  }

  const readModel = await api.orchestration.getSnapshot();
  if (lease !== getRecoveryMutationLease()) {
    return false;
  }
  if (readModelHasProjectsOrThreads(readModel)) {
    // A project-only full snapshot that contradicts live threads the client
    // already holds is the empty-thread-list bug shape, not newer truth:
    // installing it would evict held detail. Shelve it and let the guarded
    // repair below decide instead.
    const storeState = useStore.getState();
    const contradictsHeldEvidence =
      !readModelHasLiveThreads(readModel) && hasClientLiveThreadEvidence(storeState);
    if (!contradictsHeldEvidence) {
      storeState.syncServerReadModel(readModel);
    }
    if (readModelHasLiveThreads(readModel)) {
      return true;
    }
    // A project-only read model can still be repaired into thread projections.
  }
  // Only pay for the repair round-trip when the shell and full snapshot both
  // failed to produce live thread projections.
  const repairedReadModel = await requestRepairState(api);
  if (lease !== getRecoveryMutationLease()) {
    return false;
  }
  // A repair that contradicts live threads the client already holds (or an
  // incomplete repair missing projects) must not be installed: route the
  // decision through the same guard the bootstrap recovery uses.
  const decision = resolveRepairedShellApplication({
    repaired: repairedReadModel,
    observedLiveThreadEvidence:
      hasClientLiveThreadEvidence(useStore.getState()) || readModelHasLiveThreads(readModel),
  });
  if (decision.action === "apply") {
    // Same fence as the shell branch above: without the registered apply,
    // only install before hydration.
    const applyRegistered = isShellSnapshotApplyRegistered();
    const applyHydrated = useStore.getState().threadsHydrated === true;
    if (applyRegistered) {
      tryApplyShellSnapshot(decision.shell);
    } else if (!applyHydrated) {
      useStore.getState().syncServerShellSnapshot(decision.shell);
    }
    return decision.shell.threads.length > 0 && (applyRegistered || !applyHydrated);
  }
  return false;
}

