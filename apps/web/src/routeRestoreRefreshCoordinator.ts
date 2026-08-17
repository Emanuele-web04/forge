import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";

type EmptyRouteRestoreRefreshHandler = () => Promise<boolean>;

let activeEmptyRouteRestoreRefreshHandler: EmptyRouteRestoreRefreshHandler | null = null;

export function registerEmptyRouteRestoreRefresh(
  handler: EmptyRouteRestoreRefreshHandler,
): () => void {
  activeEmptyRouteRestoreRefreshHandler = handler;
  return () => {
    if (activeEmptyRouteRestoreRefreshHandler === handler) {
      activeEmptyRouteRestoreRefreshHandler = null;
    }
  };
}

export function requestEmptyRouteRestoreRefresh(): Promise<boolean> {
  return activeEmptyRouteRestoreRefreshHandler?.() ?? Promise.resolve(false);
}

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

  if (await applyFreshShellSnapshot()) {
    return true;
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
  // snapshot after repair instead.
  await input.repairState();
  return await applyFreshShellSnapshot();
}
