import { describe, expect, it, vi } from "vitest";
import { shutdownBrowserServices } from "./browserShutdown";

describe("browser shutdown", () => {
  it("closes pages before awaiting host CDP drain, then clears vault keys", async () => {
    const order: string[] = [];
    let drained!: () => void;
    const host = new Promise<void>((resolve) => {
      drained = resolve;
    });
    await shutdownBrowserServices({
      revokeHost: () => {
        order.push("revoke");
        return host;
      },
      closePages: () => {
        order.push("close-pages");
        drained();
      },
      stopCapture: async () => {
        await host;
        order.push("capture-stopped");
      },
      clearKeys: () => {
        order.push("keys-cleared");
      },
    });
    expect(order).toEqual(["revoke", "close-pages", "capture-stopped", "keys-cleared"]);
  });

  it("drains both services and clears keys even when capture cleanup fails", async () => {
    const clearKeys = vi.fn();
    await expect(
      shutdownBrowserServices({
        revokeHost: async () => {},
        closePages: () => {},
        stopCapture: async () => {
          throw new Error("synthetic-cleanup-error");
        },
        clearKeys,
      }),
    ).rejects.toThrow("synthetic-cleanup-error");
    expect(clearKeys).toHaveBeenCalledTimes(1);
  });

  it("still stops capture and clears keys when closing a page throws synchronously", async () => {
    const stopCapture = vi.fn(async () => {});
    const clearKeys = vi.fn();
    await expect(
      shutdownBrowserServices({
        revokeHost: async () => {
          throw new Error("host-error");
        },
        closePages: () => {
          throw new Error("page-error");
        },
        stopCapture,
        clearKeys,
      }),
    ).rejects.toThrow("host-error");
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(clearKeys).toHaveBeenCalledTimes(1);
  });
});
