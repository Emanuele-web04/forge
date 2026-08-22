// FILE: initialBackendWindowOpen.test.ts
// Purpose: Locks desktop startup behavior so packaged windows appear before backend readiness.

import { describe, expect, it, vi } from "vitest";

import {
  openInitialBackendWindow,
  type InitialBackendWindowOpenOptions,
} from "./initialBackendWindowOpen";

function createOptions(
  overrides: Partial<InitialBackendWindowOpenOptions> = {},
): InitialBackendWindowOpenOptions {
  let readinessInFlight: Promise<void> | null = null;

  return {
    isDevelopment: false,
    baseUrl: "http://127.0.0.1:49152",
    hasExistingWindow: vi.fn(() => false),
    createWindow: vi.fn(),
    getReadinessInFlight: vi.fn(() => readinessInFlight),
    setReadinessInFlight: vi.fn((promise) => {
      readinessInFlight = promise;
    }),
    waitForBackendWindowReady: vi.fn<InitialBackendWindowOpenOptions["waitForBackendWindowReady"]>(
      async () => "listening",
    ),
    writeLog: vi.fn(),
    isReadinessAborted: vi.fn(() => false),
    formatErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("openInitialBackendWindow", () => {
  it("creates the packaged window before backend readiness resolves", async () => {
    const order: string[] = [];
    let resolveBackendReady!: () => void;
    const backendReady = new Promise<"listening">((resolve) => {
      resolveBackendReady = () => resolve("listening");
    });
    const options = createOptions({
      createWindow: vi.fn<InitialBackendWindowOpenOptions["createWindow"]>(() => {
        order.push("create-window");
      }),
      waitForBackendWindowReady: vi.fn<
        InitialBackendWindowOpenOptions["waitForBackendWindowReady"]
      >(() => {
        order.push("wait-backend");
        return backendReady;
      }),
    });

    openInitialBackendWindow(options);

    const setReadinessInFlight = vi.mocked(options.setReadinessInFlight);
    const watchedPromise = setReadinessInFlight.mock.calls[0]?.[0];

    expect(order).toEqual(["create-window", "wait-backend"]);
    expect(watchedPromise).toBeInstanceOf(Promise);
    expect(options.writeLog).toHaveBeenCalledWith("bootstrap main window created");
    if (!watchedPromise) {
      throw new Error("Expected startup readiness watcher to be registered.");
    }

    resolveBackendReady();
    await expect(watchedPromise).resolves.toBeUndefined();
  });

  it("still opens a missing window without duplicating an active readiness watch", () => {
    const activeWatch = Promise.resolve();
    const options = createOptions({
      getReadinessInFlight: vi.fn(() => activeWatch),
    });

    openInitialBackendWindow(options);

    expect(options.createWindow).toHaveBeenCalledTimes(1);
    expect(options.waitForBackendWindowReady).not.toHaveBeenCalled();
    expect(options.setReadinessInFlight).not.toHaveBeenCalled();
  });

  it("keeps observing readiness when a packaged window already exists", () => {
    const options = createOptions({
      hasExistingWindow: vi.fn(() => true),
    });

    openInitialBackendWindow(options);

    expect(options.createWindow).not.toHaveBeenCalled();
    expect(options.waitForBackendWindowReady).toHaveBeenCalledTimes(1);
    expect(options.setReadinessInFlight).toHaveBeenCalledWith(expect.any(Promise));
  });
});
