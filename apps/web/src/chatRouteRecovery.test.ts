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
});
