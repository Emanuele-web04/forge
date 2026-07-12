import type { NativeApi } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refreshEmptyRouteRestoreSnapshot } from "./chatRouteRecovery";
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
