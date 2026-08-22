import { describe, expect, it, vi } from "vitest";

import { createDesktopAppIconSynchronizer } from "./useDesktopAppIcon";

describe("desktop app icon synchronization", () => {
  it("hydrates renderer settings from the durable native preference without overwriting it", async () => {
    const setAppIcon = vi.fn();
    const updateRendererIcon = vi.fn();
    const synchronizer = createDesktopAppIconSynchronizer({
      getAppIcon: vi.fn().mockResolvedValue("icon"),
      setAppIcon,
      updateRendererIcon,
    });

    await synchronizer.hydrate("default");

    expect(updateRendererIcon).toHaveBeenCalledWith("icon");
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  it("does not apply renderer defaults before native hydration completes", async () => {
    const setAppIcon = vi.fn();
    const synchronizer = createDesktopAppIconSynchronizer({
      getAppIcon: vi.fn().mockResolvedValue("icon"),
      setAppIcon,
      updateRendererIcon: vi.fn(),
    });

    await synchronizer.apply("default");

    expect(setAppIcon).not.toHaveBeenCalled();
  });

  it("persists user selections after native hydration", async () => {
    const setAppIcon = vi.fn().mockResolvedValue(undefined);
    const synchronizer = createDesktopAppIconSynchronizer({
      getAppIcon: vi.fn().mockResolvedValue("icon"),
      setAppIcon,
      updateRendererIcon: vi.fn(),
    });
    await synchronizer.hydrate("icon");

    await synchronizer.apply("default");

    expect(setAppIcon).toHaveBeenCalledWith("default");
  });

  it("keeps later selections writable when native hydration fails", async () => {
    const setAppIcon = vi.fn().mockResolvedValue(undefined);
    const synchronizer = createDesktopAppIconSynchronizer({
      getAppIcon: vi.fn().mockRejectedValue(new Error("unavailable")),
      setAppIcon,
      updateRendererIcon: vi.fn(),
    });
    await synchronizer.hydrate("default");

    await synchronizer.apply("icon");

    expect(setAppIcon).toHaveBeenCalledWith("icon");
  });

  it("restores renderer settings when native persistence fails", async () => {
    const updateRendererIcon = vi.fn();
    const synchronizer = createDesktopAppIconSynchronizer({
      getAppIcon: vi.fn().mockResolvedValue("default"),
      setAppIcon: vi.fn().mockRejectedValue(new Error("read-only")),
      updateRendererIcon,
    });
    await synchronizer.hydrate("default");

    await expect(synchronizer.apply("icon")).rejects.toThrow("read-only");

    expect(updateRendererIcon).toHaveBeenCalledWith("default");
  });
});
