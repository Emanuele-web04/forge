import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS,
  registerEmptyRouteRestoreRefresh,
  requestEmptyRouteRestoreRefresh,
  runEmptyRouteRestoreRefresh,
} from "./routeRestoreRefreshCoordinator";

function shellSnapshot(threadIds: readonly string[]): OrchestrationShellSnapshot {
  return {
    projects: [],
    spaces: [],
    threads: threadIds.map((id) => ({ id })),
    snapshotSequence: 1,
  } as unknown as OrchestrationShellSnapshot;
}

function readModel(threadIds: readonly string[]): OrchestrationReadModel {
  return {
    projects: [],
    threads: threadIds.map((id) => ({ id })),
  } as unknown as OrchestrationReadModel;
}

function emptyUntilRepairShell(getShellSnapshotCalls: { count: number }) {
  return vi.fn().mockImplementation(async () => {
    getShellSnapshotCalls.count += 1;
    if (getShellSnapshotCalls.count <= EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS) {
      return shellSnapshot([]);
    }
    return shellSnapshot(["thread-repaired"]);
  });
}

let unregister: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  vi.useRealTimers();
});

describe("route restore refresh coordinator", () => {
  it("delegates requests to the registered EventRouter handler", async () => {
    const handler = vi.fn().mockResolvedValue(true);
    unregister = registerEmptyRouteRestoreRefresh(handler);

    await expect(requestEmptyRouteRestoreRefresh()).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not let an older unregister clear a newer handler", async () => {
    const first = vi.fn().mockResolvedValue(false);
    const second = vi.fn().mockResolvedValue(true);
    const unregisterFirst = registerEmptyRouteRestoreRefresh(first);
    unregister = registerEmptyRouteRestoreRefresh(second);

    unregisterFirst();

    await expect(requestEmptyRouteRestoreRefresh()).resolves.toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops after the fenced shell refresh restores threads", async () => {
    let hasThreads = false;
    const getShellSnapshot = vi.fn().mockResolvedValue(shellSnapshot(["thread-1"]));
    const getSnapshot = vi.fn();
    const repairState = vi.fn();

    await expect(
      runEmptyRouteRestoreRefresh({
        getShellSnapshot,
        getSnapshot,
        repairState,
        applyShellSnapshot: (snapshot) => {
          hasThreads = snapshot.threads.length > 0;
        },
        hasThreads: () => hasThreads,
      }),
    ).resolves.toBe(true);

    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(repairState).not.toHaveBeenCalled();
  });

  it("uses one full snapshot only as a probe and re-reads the fenced shell", async () => {
    let hasThreads = false;
    let fullSnapshotProbed = false;
    const getShellSnapshot = vi
      .fn()
      .mockImplementation(async () =>
        fullSnapshotProbed ? shellSnapshot(["thread-1"]) : shellSnapshot([]),
      );
    const getSnapshot = vi.fn().mockImplementation(async () => {
      fullSnapshotProbed = true;
      return readModel(["thread-1"]);
    });
    const repairState = vi.fn();
    const appliedShellSnapshots: OrchestrationShellSnapshot[] = [];

    const recovery = runEmptyRouteRestoreRefresh({
      getShellSnapshot,
      getSnapshot,
      repairState,
      applyShellSnapshot: (snapshot) => {
        appliedShellSnapshots.push(snapshot);
        hasThreads = snapshot.threads.length > 0;
      },
      hasThreads: () => hasThreads,
    });
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toBe(true);

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(repairState).not.toHaveBeenCalled();
    expect(getShellSnapshot).toHaveBeenCalledTimes(EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS + 1);
    expect(appliedShellSnapshots).toHaveLength(EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS + 1);
  });

  it("polls before repairing when projections stay empty during catch-up", async () => {
    let hasThreads = false;
    const shellCalls = { count: 0 };
    const getShellSnapshot = emptyUntilRepairShell(shellCalls);
    const getSnapshot = vi.fn().mockResolvedValue(readModel([]));
    const repairState = vi.fn().mockResolvedValue(readModel(["thread-repaired"]));

    const recovery = runEmptyRouteRestoreRefresh({
      getShellSnapshot,
      getSnapshot,
      repairState,
      applyShellSnapshot: (snapshot) => {
        hasThreads = snapshot.threads.length > 0;
      },
      hasThreads: () => hasThreads,
    });
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toBe(true);

    expect(getShellSnapshot).toHaveBeenCalledTimes(EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS + 1);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(repairState).toHaveBeenCalledTimes(1);
  });

  it("stops early when threads appear during the poll window", async () => {
    let hasThreads = false;
    let shellCalls = 0;
    const getShellSnapshot = vi.fn().mockImplementation(async () => {
      shellCalls += 1;
      return shellCalls === 1 ? shellSnapshot([]) : shellSnapshot(["thread-1"]);
    });
    const getSnapshot = vi.fn().mockResolvedValue(readModel([]));
    const repairState = vi.fn();

    const recovery = runEmptyRouteRestoreRefresh({
      getShellSnapshot,
      getSnapshot,
      repairState,
      applyShellSnapshot: (snapshot) => {
        hasThreads = snapshot.threads.length > 0;
      },
      hasThreads: () => hasThreads,
    });
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toBe(true);

    expect(getShellSnapshot).toHaveBeenCalledTimes(2);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(repairState).not.toHaveBeenCalled();
  });

  it("coalesces concurrent empty-route recoveries into one repair", async () => {
    let hasThreads = false;
    const shellCalls = { count: 0 };
    const repairControl = {
      resolve: (): void => {
        throw new Error("repair promise resolver was not initialized");
      },
    };
    const getShellSnapshot = emptyUntilRepairShell(shellCalls);
    const getSnapshot = vi.fn().mockResolvedValue(readModel([]));
    const repairState = vi.fn(
      () =>
        new Promise<OrchestrationReadModel>((resolve) => {
          repairControl.resolve = () => resolve(readModel(["thread-repaired"]));
        }),
    );

    unregister = registerEmptyRouteRestoreRefresh(() =>
      runEmptyRouteRestoreRefresh({
        getShellSnapshot,
        getSnapshot,
        repairState,
        applyShellSnapshot: (snapshot) => {
          hasThreads = snapshot.threads.length > 0;
        },
        hasThreads: () => hasThreads,
      }),
    );
    const first = requestEmptyRouteRestoreRefresh();
    const second = requestEmptyRouteRestoreRefresh();

    await vi.runAllTimersAsync();
    expect(repairState).toHaveBeenCalledTimes(1);
    repairControl.resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("starts a fresh recovery when the registered EventRouter changes", async () => {
    const firstControl = {
      resolve: (_value: boolean): void => {
        throw new Error("first recovery resolver was not initialized");
      },
    };
    const firstHandler = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          firstControl.resolve = resolve;
        }),
    );
    const unregisterFirst = registerEmptyRouteRestoreRefresh(firstHandler);
    const first = requestEmptyRouteRestoreRefresh();

    unregisterFirst();
    const secondHandler = vi.fn().mockResolvedValue(true);
    unregister = registerEmptyRouteRestoreRefresh(secondHandler);
    const second = requestEmptyRouteRestoreRefresh();

    await expect(second).resolves.toBe(true);
    expect(secondHandler).toHaveBeenCalledTimes(1);

    firstControl.resolve(false);
    await expect(first).resolves.toBe(false);
  });

  it("repairs an empty projection then consumes a fresh fenced shell snapshot", async () => {
    let hasThreads = false;
    const shellCalls = { count: 0 };
    const getShellSnapshot = emptyUntilRepairShell(shellCalls);
    const getSnapshot = vi.fn().mockResolvedValue(readModel([]));
    const repairState = vi.fn().mockResolvedValue(readModel(["thread-repaired"]));

    const recovery = runEmptyRouteRestoreRefresh({
      getShellSnapshot,
      getSnapshot,
      repairState,
      applyShellSnapshot: (snapshot) => {
        hasThreads = snapshot.threads.length > 0;
      },
      hasThreads: () => hasThreads,
    });
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toBe(true);

    expect(repairState).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getShellSnapshot).toHaveBeenCalledTimes(EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS + 1);
  });
});
