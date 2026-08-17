import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS,
  registerEmptyRouteRestoreRefresh,
  requestEmptyRouteRestoreRefresh,
  resetEmptyRouteRestoreSingleFlightForTests,
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
  resetEmptyRouteRestoreSingleFlightForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  resetEmptyRouteRestoreSingleFlightForTests();
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

  it("uses the full snapshot only as a probe and re-reads the fenced shell", async () => {
    let hasThreads = false;
    const getShellSnapshot = vi
      .fn()
      .mockResolvedValueOnce(shellSnapshot([]))
      .mockResolvedValueOnce(shellSnapshot(["thread-1"]));
    const getSnapshot = vi.fn().mockResolvedValue(readModel(["thread-1"]));
    const repairState = vi.fn();
    const appliedShellSnapshots: OrchestrationShellSnapshot[] = [];

    await expect(
      runEmptyRouteRestoreRefresh({
        getShellSnapshot,
        getSnapshot,
        repairState,
        applyShellSnapshot: (snapshot) => {
          appliedShellSnapshots.push(snapshot);
          hasThreads = snapshot.threads.length > 0;
        },
        hasThreads: () => hasThreads,
      }),
    ).resolves.toBe(true);

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(repairState).not.toHaveBeenCalled();
    expect(getShellSnapshot).toHaveBeenCalledTimes(2);
    expect(appliedShellSnapshots).toHaveLength(2);
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
    expect(getSnapshot).toHaveBeenCalledTimes(EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS);
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
    expect(repairState).not.toHaveBeenCalled();
  });

  it("coalesces concurrent empty-route recoveries into one repair", async () => {
    let hasThreads = false;
    const shellCalls = { count: 0 };
    let resolveRepair: (() => void) | null = null;
    const getShellSnapshot = emptyUntilRepairShell(shellCalls);
    const getSnapshot = vi.fn().mockResolvedValue(readModel([]));
    const repairState = vi.fn(
      () =>
        new Promise<OrchestrationReadModel>((resolve) => {
          resolveRepair = () => resolve(readModel(["thread-repaired"]));
        }),
    );

    const first = runEmptyRouteRestoreRefresh({
      getShellSnapshot,
      getSnapshot,
      repairState,
      applyShellSnapshot: (snapshot) => {
        hasThreads = snapshot.threads.length > 0;
      },
      hasThreads: () => hasThreads,
    });
    const second = runEmptyRouteRestoreRefresh({
      getShellSnapshot,
      getSnapshot,
      repairState,
      applyShellSnapshot: (snapshot) => {
        hasThreads = snapshot.threads.length > 0;
      },
      hasThreads: () => hasThreads,
    });

    await vi.runAllTimersAsync();
    expect(repairState).toHaveBeenCalledTimes(1);
    resolveRepair?.();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
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
    expect(getShellSnapshot).toHaveBeenCalledTimes(EMPTY_ROUTE_PROJECTION_POLL_ATTEMPTS + 1);
  });
});
