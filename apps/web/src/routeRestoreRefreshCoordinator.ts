import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";

type EmptyRouteRestoreRefreshHandler = () => Promise<boolean>;

/** Wait for projection catch-up before a full rebuild on large state DBs. */
export const EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS = 12;
export const EMPTY_ROUTE_PROJECTION_POLL_INTERVAL_MS = 500;

let activeEmptyRouteRestoreRefreshHandler: EmptyRouteRestoreRefreshHandler | null = null;

export function registerEmptyRouteRestoreRefresh(
  handler: EmptyRouteRestoreRefreshHandler,
): () => void {
  let inFlight: Promise<boolean> | null = null;
  const singleFlightHandler = () => {
    if (inFlight) {
      return inFlight;
    }

    const recovery = Promise.resolve().then(handler);
    const sharedRecovery = recovery.finally(() => {
      if (inFlight === sharedRecovery) {
        inFlight = null;
      }
    });
    inFlight = sharedRecovery;
    return sharedRecovery;
  };

  activeEmptyRouteRestoreRefreshHandler = singleFlightHandler;
  return () => {
    if (activeEmptyRouteRestoreRefreshHandler === singleFlightHandler) {
      activeEmptyRouteRestoreRefreshHandler = null;
    }
  };
}

export function requestEmptyRouteRestoreRefresh(): Promise<boolean> {
  return activeEmptyRouteRestoreRefreshHandler?.() ?? Promise.resolve(false);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

/**
 * Recover an empty route shell without bypassing EventRouter's sequence fence.
 *
 * Full projection rebuilds thrash multi-GB state DBs and hold the server
 * maintenance lock for minutes. Poll the lightweight shell first so catch-up
 * can win, then use one full snapshot probe before calling repair.
 */
export async function runEmptyRouteRestoreRefresh(input: {
  readonly getShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
  readonly getSnapshot: () => Promise<OrchestrationReadModel>;
  readonly repairState: () => Promise<OrchestrationReadModel>;
  readonly applyShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  readonly hasThreads: () => boolean;
}): Promise<boolean> {
  const applyFreshShellSnapshot = async () => {
    const snapshot = await input.getShellSnapshot();
    input.applyShellSnapshot(snapshot);
    return input.hasThreads();
  };

  for (let attempt = 0; attempt < EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS; attempt += 1) {
    if (await applyFreshShellSnapshot()) {
      return true;
    }

    if (attempt + 1 < EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS) {
      await delay(EMPTY_ROUTE_PROJECTION_POLL_INTERVAL_MS);
    }
  }

  // The full projection is only a recovery probe. Applying it here would bypass
  // EventRouter's shell sequence fence, which is the race this coordinator exists
  // to remove. If it already contains threads, re-read the shell projection and
  // let EventRouter apply that snapshot through its normal fenced path.
  const readModel = await input.getSnapshot();
  if (readModel.threads.length > 0) {
    return await applyFreshShellSnapshot();
  }

  // Repair may rebuild projections, but its returned full read model has no
  // EventRouter shell fence. Ignore the payload and consume a fresh shell
  // snapshot after repair instead. Server-side repairState also coalesces and
  // cools down concurrent rebuilds on large DBs.
  await input.repairState();
  return await applyFreshShellSnapshot();
}
