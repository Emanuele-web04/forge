import { describe, expect, it, vi } from "vitest";

import { waitForBackendStartupReady } from "./backendStartupReadiness";

describe("waitForBackendStartupReady", () => {
  it("resolves from http when no listening promise is provided", async () => {
    const waitForHttpReady = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const cancelHttpWait = vi.fn();

    await expect(
      waitForBackendStartupReady({
        waitForHttpReady,
        cancelHttpWait,
      }),
    ).resolves.toBe("http");

    expect(waitForHttpReady).toHaveBeenCalledTimes(1);
    expect(cancelHttpWait).not.toHaveBeenCalled();
  });

  it("prefers the listening signal and cancels the http wait", async () => {
    let resolveListening!: () => void;
    const listeningPromise = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    const waitForHttpReady = vi.fn(() => new Promise<void>(() => {}));
    const cancelHttpWait = vi.fn();

    const resultPromise = waitForBackendStartupReady({
      listeningPromise,
      waitForHttpReady,
      cancelHttpWait,
    });

    resolveListening();

    await expect(resultPromise).resolves.toBe("listening");
    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });

  it("rejects when the listening promise fails before http is ready", async () => {
    const error = new Error("backend exited");
    const cancelHttpWait = vi.fn();

    await expect(
      waitForBackendStartupReady({
        listeningPromise: Promise.reject(error),
        waitForHttpReady: () => new Promise<void>(() => {}),
        cancelHttpWait,
      }),
    ).rejects.toThrow("backend exited");

    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });

  it("does not cancel http after http readiness already won", async () => {
    let resolveHttpReady!: () => void;
    let rejectListening!: (error: Error) => void;
    const listeningPromise = new Promise<void>((_resolve, reject) => {
      rejectListening = reject;
    });
    const waitForHttpReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHttpReady = resolve;
        }),
    );
    const cancelHttpWait = vi.fn();

    const resultPromise = waitForBackendStartupReady({
      listeningPromise,
      waitForHttpReady,
      cancelHttpWait,
    });

    resolveHttpReady();
    await expect(resultPromise).resolves.toBe("http");

    rejectListening(new Error("late backend exit"));
    await Promise.resolve();

    expect(cancelHttpWait).not.toHaveBeenCalled();
  });
});
