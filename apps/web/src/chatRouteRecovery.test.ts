import type { NativeApi } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  refreshEmptyRouteRestoreSnapshot,
  refreshMissingThreadSnapshots,
} from "./chatRouteRecovery";
import { registerEmptyRouteRestoreRefresh } from "./routeRestoreRefreshCoordinator";

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("refreshEmptyRouteRestoreSnapshot", () => {
  it("returns false when the backend is unavailable", async () => {
    await expect(refreshEmptyRouteRestoreSnapshot(undefined)).resolves.toBe(false);
  });

  it("delegates snapshot recovery to EventRouter's registered coordinator", async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    unregister = registerEmptyRouteRestoreRefresh(refresh);

    await expect(refreshEmptyRouteRestoreSnapshot({} as NativeApi)).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(1);
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

describe("refreshMissingThreadSnapshots", () => {
  beforeEach(() => {
    storeMocks.syncServerReadModel.mockClear();
    storeMocks.syncServerShellSnapshot.mockClear();
  });

  it("syncs shell when it already has threads and never repairs", async () => {
    const shell = shellSnapshot({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshMissingThreadSnapshots(api)).resolves.toBe(true);

    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
  });

  it("escalates to full snapshot for threads without applying project-only shell", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const repaired = readModel({ projects: [{ id: "project-1" }] });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshMissingThreadSnapshots(api)).resolves.toBe(true);

    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).not.toHaveBeenCalled();
    expect(storeMocks.syncServerReadModel).toHaveBeenCalledWith(snapshot);
  });

  it("returns false without repair when both reads stay project-only", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshMissingThreadSnapshots(api)).resolves.toBe(false);

    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).not.toHaveBeenCalled();
    expect(storeMocks.syncServerReadModel).not.toHaveBeenCalled();
  });
});
