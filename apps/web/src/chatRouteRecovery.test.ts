import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  syncServerReadModel: vi.fn(),
  syncServerShellSnapshot: vi.fn(),
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => storeMocks,
  },
}));

import { fetchMissingThreadSnapshots, refreshEmptyRouteRestoreSnapshot } from "./chatRouteRecovery";
import {
  createMissingThreadRecoveryController,
  MISSING_THREAD_RECOVERY_MAX_ATTEMPTS,
} from "./missingThreadRecovery";
import {
  bumpShellRefreshEpoch,
  getShellRefreshEpoch,
  shouldAcceptShellSnapshotSequence,
  shouldSkipShellThreadMutation,
  subscribeShellRefreshEpoch,
} from "./shellRefreshCoordinator";

function shellSnapshot(input: {
  projects?: unknown[];
  threads?: unknown[];
  snapshotSequence?: number;
}): OrchestrationShellSnapshot {
  return {
    projects: input.projects ?? [],
    threads: input.threads ?? [],
    snapshotSequence: input.snapshotSequence ?? 1,
  } as unknown as OrchestrationShellSnapshot;
}

function readModel(input: {
  projects?: unknown[];
  threads?: unknown[];
  snapshotSequence?: number;
}): OrchestrationReadModel {
  return {
    projects: input.projects ?? [],
    threads: input.threads ?? [],
    snapshotSequence: input.snapshotSequence ?? 1,
  } as unknown as OrchestrationReadModel;
}

function makeApi(input: {
  shell: OrchestrationShellSnapshot;
  snapshot: OrchestrationReadModel;
  repaired: OrchestrationReadModel;
}) {
  const orchestration = {
    getShellSnapshot: vi.fn().mockResolvedValue(input.shell),
    getSnapshot: vi.fn().mockResolvedValue(input.snapshot),
    repairState: vi.fn().mockResolvedValue(input.repaired),
  };

  return {
    api: { orchestration } as unknown as NativeApi,
    orchestration,
  };
}

describe("refreshEmptyRouteRestoreSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues to repair when shell and full snapshots only contain projects", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.repairState).toHaveBeenCalledTimes(1);
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
    expect(storeMocks.syncServerReadModel).toHaveBeenCalledWith(repaired);
  });

  it("stops at the shell when the full snapshot is only projects", async () => {
    const shell = shellSnapshot({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.repairState).toHaveBeenCalledTimes(1);
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
    expect(storeMocks.syncServerReadModel).toHaveBeenCalledWith(snapshot);
  });

  it("escalates past a project-only shell when full snapshot already has threads", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.getSnapshot).toHaveBeenCalledTimes(1);
    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
    expect(storeMocks.syncServerReadModel).toHaveBeenCalledWith(snapshot);
  });
});

describe("fetchMissingThreadSnapshots", () => {
  it("returns shell when it already has threads", async () => {
    const shell = shellSnapshot({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1", projectId: "project-1" }],
    });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(fetchMissingThreadSnapshots(api)).resolves.toEqual({
      kind: "shell",
      snapshot: shell,
    });
    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });

  it("escalates to full snapshot for threads without returning project-only shell", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1", projectId: "project-1", deletedAt: null }],
    });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(fetchMissingThreadSnapshots(api)).resolves.toEqual({
      kind: "readModel",
      snapshot,
    });
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });

  it("returns none when both reads stay project-only", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1", projectId: "project-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(fetchMissingThreadSnapshots(api)).resolves.toEqual({ kind: "none" });
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });

  it("ignores soft-deleted-only full snapshots", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({
      projects: [{ id: "project-1" }],
      threads: [
        { id: "thread-deleted", projectId: "project-1", deletedAt: "2026-07-01T00:00:00.000Z" },
      ],
    });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(fetchMissingThreadSnapshots(api)).resolves.toEqual({ kind: "none" });
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });

  it("escalates past shell threads that are missing projects", async () => {
    const shell = shellSnapshot({
      projects: [],
      threads: [{ id: "thread-1", projectId: "project-1" }],
    });
    const snapshot = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1", projectId: "project-1", deletedAt: null }],
    });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(fetchMissingThreadSnapshots(api)).resolves.toEqual({
      kind: "readModel",
      snapshot,
    });
    expect(orchestration.getSnapshot).toHaveBeenCalledTimes(1);
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });

  it("returns repair-projects when readModel threads are also missing projects", async () => {
    const shell = shellSnapshot({
      projects: [],
      threads: [{ id: "thread-1", projectId: "project-1" }],
    });
    const snapshot = readModel({
      projects: [],
      threads: [{ id: "thread-1", projectId: "project-1", deletedAt: null }],
    });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(fetchMissingThreadSnapshots(api)).resolves.toEqual({
      kind: "repair-projects",
    });
    expect(orchestration.getSnapshot).toHaveBeenCalledTimes(1);
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });
});

describe("shouldAcceptShellSnapshotSequence", () => {
  it("accepts any snapshot before the fence is established", () => {
    expect(shouldAcceptShellSnapshotSequence(-1, 0)).toBe(true);
  });

  it("rejects snapshots older than the applied fence", () => {
    expect(shouldAcceptShellSnapshotSequence(5, 4)).toBe(false);
    expect(shouldAcceptShellSnapshotSequence(5, 5)).toBe(true);
    expect(shouldAcceptShellSnapshotSequence(5, 6)).toBe(true);
  });
});

describe("shouldSkipShellThreadMutation", () => {
  it("skips when detail fence is defined and at least as new as the event", () => {
    expect(shouldSkipShellThreadMutation(undefined, 3)).toBe(false);
    expect(shouldSkipShellThreadMutation(2, 3)).toBe(false);
    expect(shouldSkipShellThreadMutation(3, 3)).toBe(true);
    expect(shouldSkipShellThreadMutation(4, 3)).toBe(true);
  });
});

describe("shellRefreshEpoch", () => {
  it("notifies subscribers when bumped so recovery can restart after reconnect", () => {
    const seen: number[] = [];
    const start = getShellRefreshEpoch();
    const unsubscribe = subscribeShellRefreshEpoch(() => {
      seen.push(getShellRefreshEpoch());
    });
    bumpShellRefreshEpoch();
    bumpShellRefreshEpoch();
    unsubscribe();
    expect(seen).toEqual([start + 1, start + 2]);
  });
});

describe("createMissingThreadRecoveryController", () => {
  it("retries after false until threads appear, then stops", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let needed = true;
    let calls = 0;
    const onAttempt = vi.fn();

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => needed,
      refresh: async () => {
        calls += 1;
        if (calls >= 2) {
          needed = false;
          return { applied: true, shellThreadCount: 1, reason: "ok" };
        }
        return { applied: false, shellThreadCount: 0, reason: "empty" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
      onAttempt,
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(1_500);

    timers[0]?.fn();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(timers).toHaveLength(1);
  });

  it("retries after refresh errors without needing an unrelated render", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let needed = true;
    let calls = 0;

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => needed,
      refresh: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("rpc failed");
        }
        needed = false;
        return { applied: true, shellThreadCount: 1, reason: "ok" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
      maxAttempts: 3,
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    timers[0]?.fn();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(timers).toHaveLength(1);
  });

  it("stops on confirmed-empty even when recovery is still classified as needed", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => true,
      refresh: async () => {
        calls += 1;
        return { applied: true, shellThreadCount: 0, reason: "confirmed-empty" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
      maxAttempts: 3,
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(timers).toHaveLength(0);
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("retries inconsistent empty the same as ordinary empty", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => true,
      refresh: async () => {
        calls += 1;
        return { applied: false, shellThreadCount: 0, reason: "empty" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
      maxAttempts: 3,
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(timers).toHaveLength(1);
    timers[0]?.fn();
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it("keeps retrying when applied is true but recovery is still needed", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => true,
      refresh: async () => {
        calls += 1;
        return { applied: true, shellThreadCount: 0, reason: "empty" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
      maxAttempts: 3,
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(timers).toHaveLength(1);
    timers[0]?.fn();
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it("cancels delayed retries on unmount", async () => {
    const clearSchedule = vi.fn();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => true,
      refresh: async () => {
        calls += 1;
        return { applied: false, shellThreadCount: 0, reason: "empty" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return 42 as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule,
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    controller.cancel();
    expect(clearSchedule).toHaveBeenCalledWith(42);
    timers[0]?.fn();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("does not poll forever for a legitimate project-only workspace", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => true,
      refresh: async () => {
        calls += 1;
        return { applied: false, shellThreadCount: 0, reason: "empty" };
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
    });

    controller.start();
    for (let i = 0; i < MISSING_THREAD_RECOVERY_MAX_ATTEMPTS + 2; i += 1) {
      await vi.waitFor(() =>
        expect(calls).toBe(Math.min(i + 1, MISSING_THREAD_RECOVERY_MAX_ATTEMPTS)),
      );
      const next = timers[timers.length - 1];
      if (!next || calls >= MISSING_THREAD_RECOVERY_MAX_ATTEMPTS) {
        break;
      }
      next.fn();
    }

    expect(calls).toBe(MISSING_THREAD_RECOVERY_MAX_ATTEMPTS);
  });

  it("stops immediately when threads arrive through the shell stream", async () => {
    let needed = true;
    let calls = 0;
    const timers: Array<{ fn: () => void }> = [];

    const controller = createMissingThreadRecoveryController({
      isStillNeeded: () => needed,
      refresh: async () => {
        calls += 1;
        return { applied: false, shellThreadCount: 0, reason: "empty" };
      },
      schedule: (fn) => {
        timers.push({ fn });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
    });

    controller.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    needed = false;
    timers[0]?.fn();
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
