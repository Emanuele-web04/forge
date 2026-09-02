import { EventEmitter } from "node:events";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_BACKEND_SHUTDOWN_PATH,
  PosixBackendShutdownTimeoutError,
  retainLiveBackendAfterShutdownFailure,
  requireWindowsBackendExit,
  runAfterDesktopShutdown,
  shouldDeferDesktopWindowClose,
  startDesktopBackendShutdownRequest,
  stopPosixBackendAndWait,
  stopWindowsBackendAndWait,
  WindowsBackendShutdownTimeoutError,
  type BackendShutdownProcess,
  type DesktopBackendShutdownRequestOutcome,
  type PendingDesktopBackendShutdownRequest,
} from "./backendShutdown";

class FakeBackendProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  exitOnKill = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.exitOnKill) {
      this.exit(null, typeof signal === "string" ? signal : "SIGTERM");
    }
    return true;
  }

  exit(exitCode: number | null = 0, signalCode: NodeJS.Signals | null = null): void {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.emit("exit", exitCode, signalCode);
  }
}

type TestBackendShutdownProcess = FakeBackendProcess & BackendShutdownProcess;

function makeTestBackendShutdownProcess(): TestBackendShutdownProcess {
  return new FakeBackendProcess() as unknown as TestBackendShutdownProcess;
}

function makePendingRequest(
  outcome: Promise<DesktopBackendShutdownRequestOutcome> = new Promise(() => {}),
): PendingDesktopBackendShutdownRequest & {
  readonly cancel: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    outcome,
    cancel: vi.fn<() => void>(),
  };
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("retainLiveBackendAfterShutdownFailure", () => {
  it("restores ownership only when the attempted child is still alive", () => {
    const liveChild = makeTestBackendShutdownProcess();
    expect(retainLiveBackendAfterShutdownFailure(null, liveChild)).toBe(liveChild);

    liveChild.exit(0);
    expect(retainLiveBackendAfterShutdownFailure(null, liveChild)).toBeNull();

    const replacement = makeTestBackendShutdownProcess();
    expect(retainLiveBackendAfterShutdownFailure(replacement, liveChild)).toBe(replacement);
  });
});

describe("stopPosixBackendAndWait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests graceful shutdown and resolves only after the child exits", async () => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest(
      Promise.resolve({ type: "response", statusCode: 202 }),
    );
    const startRequest = vi.fn(() => pendingRequest);
    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest,
    });

    expect(startRequest).toHaveBeenCalledOnce();
    expect(child.killSignals).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_999);
    await expectPromisePending(shutdown);

    child.exit(0);

    await expect(shutdown).resolves.toBeUndefined();
    expect(child.killSignals).toEqual([]);
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();
  });

  it("retries transport failures while the backend is still starting", async () => {
    const child = makeTestBackendShutdownProcess();
    const failedRequest = makePendingRequest(Promise.resolve({ type: "error" }));
    const acceptedRequest = makePendingRequest(
      Promise.resolve({ type: "response", statusCode: 202 }),
    );
    const startRequest = vi
      .fn()
      .mockReturnValueOnce(failedRequest)
      .mockImplementationOnce(() => {
        child.exit(0);
        return acceptedRequest;
      });
    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest,
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(startRequest).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);

    await expect(shutdown).resolves.toBeUndefined();
    expect(startRequest).toHaveBeenCalledTimes(2);
    expect(child.killSignals).toEqual([]);
    expect(acceptedRequest.cancel).toHaveBeenCalledOnce();
  });

  it("stops retrying transport failures when TERM fallback begins", async () => {
    const child = makeTestBackendShutdownProcess();
    child.exitOnKill = true;
    const startRequest = vi.fn(() => makePendingRequest(Promise.resolve({ type: "error" })));
    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 600,
      forceKillDelayMs: 800,
      timeoutMs: 1_000,
      startRequest,
    });

    await vi.advanceTimersByTimeAsync(599);
    expect(startRequest).toHaveBeenCalledTimes(3);
    expect(child.killSignals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    await expect(shutdown).resolves.toBeUndefined();
    expect(startRequest).toHaveBeenCalledTimes(3);
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("escalates from graceful shutdown to TERM and KILL while still requiring exit", async () => {
    const child = makeTestBackendShutdownProcess();
    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => makePendingRequest(),
    });

    await vi.advanceTimersByTimeAsync(5_999);
    expect(child.killSignals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await expectPromisePending(shutdown);

    child.exit(null, "SIGKILL");
    await expect(shutdown).resolves.toBeUndefined();
  });

  it("rejects instead of allowing updater handoff while the child is still alive", async () => {
    const child = makeTestBackendShutdownProcess();
    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => makePendingRequest(),
    });

    const rejection = expect(shutdown).rejects.toMatchObject({
      name: "PosixBackendShutdownTimeoutError",
      forced: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("shares duplicate shutdown calls for the same process", async () => {
    const child = makeTestBackendShutdownProcess();
    const input = {
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: vi.fn(() => makePendingRequest()),
    };

    const first = stopPosixBackendAndWait(input);
    const second = stopPosixBackendAndWait(input);
    expect(second).toBe(first);
    expect(child.killSignals).toEqual([]);
    expect(input.startRequest).toHaveBeenCalledOnce();

    child.exit(0);
    await expect(first).resolves.toBeUndefined();
  });

  it("validates timing before signaling the child", async () => {
    const child = makeTestBackendShutdownProcess();

    await expect(
      stopPosixBackendAndWait({
        child,
        backendHttpUrl: "http://127.0.0.1:3773",
        shutdownToken: "desktop-only-token",
        terminateDelayMs: 8_000,
        forceKillDelayMs: 10_000,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(RangeError);
    expect(child.killSignals).toEqual([]);
  });

  it("exposes whether the force-kill attempt ran before timeout", async () => {
    const child = makeTestBackendShutdownProcess();
    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => makePendingRequest(),
    });

    const rejection = expect(shutdown).rejects.toBeInstanceOf(PosixBackendShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("cancels a request created during a synchronous child-exit race", async () => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest();

    const shutdown = stopPosixBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      terminateDelayMs: 6_000,
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => {
        child.exit(0);
        return pendingRequest;
      },
    });

    await expect(shutdown).resolves.toBeUndefined();
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();
    expect(child.killSignals).toEqual([]);
  });
});

describe("stopWindowsBackendAndWait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the per-launch credential but treats only child exit as graceful success", async () => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest(
      Promise.resolve({ type: "response", statusCode: 202 }),
    );
    const startRequest = vi.fn(() => pendingRequest);

    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest,
    });

    expect(startRequest).toHaveBeenCalledOnce();
    expect(startRequest).toHaveBeenCalledWith({
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
    });
    await expectPromisePending(shutdown);
    await vi.advanceTimersByTimeAsync(7_999);
    await expectPromisePending(shutdown);

    child.exit(0);

    await expect(shutdown).resolves.toEqual({ type: "exited", forced: false });
    expect(child.killSignals).toEqual([]);
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();
  });

  it("shares duplicate shutdown calls for the same process", async () => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest();
    const startRequest = vi.fn(() => pendingRequest);
    const input = {
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest,
    };

    const first = stopWindowsBackendAndWait(input);
    const duplicate = stopWindowsBackendAndWait(input);

    expect(duplicate).toBe(first);
    expect(startRequest).toHaveBeenCalledOnce();
    child.exit(0);
    await expect(first).resolves.toEqual({ type: "exited", forced: false });
    await expect(duplicate).resolves.toEqual({ type: "exited", forced: false });
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();
  });

  it("cancels a request created during a synchronous child-exit race", async () => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest();

    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => {
        child.exit(0);
        return pendingRequest;
      },
    });

    await expect(shutdown).resolves.toEqual({ type: "exited", forced: false });
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();
    expect(child.killSignals).toEqual([]);
  });

  it.each([
    ["rejected response", () => Promise.resolve({ type: "response", statusCode: 401 } as const)],
    ["connection reset or refusal", () => Promise.resolve({ type: "error" } as const)],
    ["request rejection", () => Promise.reject(new Error("transport rejected"))],
  ])("keeps the absolute fallback schedule after a %s", async (_label, makeOutcome) => {
    const child = makeTestBackendShutdownProcess();
    child.exitOnKill = true;
    const startRequest = vi.fn(() => makePendingRequest(makeOutcome()));
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest,
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(child.killSignals).toEqual([]);
    await expectPromisePending(shutdown);

    await vi.advanceTimersByTimeAsync(1);

    await expect(shutdown).resolves.toEqual({ type: "exited", forced: true });
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(startRequest).toHaveBeenCalledOnce();
  });

  it("uses the same bounded fallback when request construction fails synchronously", async () => {
    const child = makeTestBackendShutdownProcess();
    child.exitOnKill = true;
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => {
        throw new Error("missing credential or unavailable endpoint");
      },
    });

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(shutdown).resolves.toEqual({ type: "exited", forced: true });
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("cancels a hung request and releases the live child for a later retry", async () => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest();
    const forceTerminate = vi.fn((processHandle: BackendShutdownProcess) => {
      processHandle.kill("SIGTERM");
    });
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => pendingRequest,
      forceTerminate,
    });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(forceTerminate).toHaveBeenCalledOnce();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await expectPromisePending(shutdown);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(shutdown).resolves.toEqual({ type: "timed-out", forced: true });
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(forceTerminate).toHaveBeenCalledOnce();
    expect(child.killSignals).toEqual(["SIGTERM"]);

    const retryRequest = makePendingRequest();
    const startRetryRequest = vi.fn(() => retryRequest);
    const retry = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: startRetryRequest,
      forceTerminate,
    });

    expect(retry).not.toBe(shutdown);
    expect(startRetryRequest).toHaveBeenCalledOnce();
    child.exit(0);
    await expect(retry).resolves.toEqual({ type: "exited", forced: false });
    expect(retryRequest.cancel).toHaveBeenCalledOnce();
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it("does not request or force shutdown for an already-exited child", async () => {
    const child = makeTestBackendShutdownProcess();
    child.exitCode = 0;
    const startRequest = vi.fn(() => makePendingRequest());

    await expect(
      stopWindowsBackendAndWait({
        child,
        backendHttpUrl: "http://127.0.0.1:3773",
        shutdownToken: "desktop-only-token",
        forceKillDelayMs: 8_000,
        timeoutMs: 10_000,
        startRequest,
      }),
    ).resolves.toEqual({ type: "already-exited", forced: false });
    expect(startRequest).not.toHaveBeenCalled();
    expect(child.killSignals).toEqual([]);
  });

  it("lets child state at the force boundary win without a force call", async () => {
    const child = makeTestBackendShutdownProcess();
    setTimeout(() => child.exit(0), 8_000);
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => makePendingRequest(),
    });

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(shutdown).resolves.toEqual({ type: "exited", forced: false });
    expect(child.killSignals).toEqual([]);
  });

  it("accepts actual child exit at the overall deadline as exit proof", async () => {
    const child = makeTestBackendShutdownProcess();
    setTimeout(() => child.exit(0), 10_000);
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => makePendingRequest(),
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(shutdown).resolves.toEqual({ type: "exited", forced: true });
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("remains bounded if the one forceful fallback throws", async () => {
    const child = makeTestBackendShutdownProcess();
    const forceTerminate = vi.fn(() => {
      throw new Error("force failed");
    });
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 8_000,
      timeoutMs: 10_000,
      startRequest: () => makePendingRequest(),
      forceTerminate,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(shutdown).resolves.toEqual({ type: "timed-out", forced: true });
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it.each([
    ["a fractional deadline", 0.5],
    ["a one-millisecond deadline", 1],
  ])("forces synchronously before %s can settle", async (_label, timeoutMs) => {
    const child = makeTestBackendShutdownProcess();
    const pendingRequest = makePendingRequest();
    const order: string[] = [];
    const startRequest = vi.fn(() => {
      expect(child.listenerCount("exit")).toBe(1);
      order.push("request");
      return pendingRequest;
    });
    const forceTerminate = vi.fn(() => {
      order.push("force");
    });

    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 0,
      timeoutMs,
      startRequest,
      forceTerminate,
    });

    expect(order).toEqual(["request", "force"]);
    expect(startRequest).toHaveBeenCalledOnce();
    expect(forceTerminate).toHaveBeenCalledOnce();
    await expectPromisePending(shutdown);

    await vi.advanceTimersByTimeAsync(timeoutMs);

    await expect(shutdown).resolves.toEqual({ type: "timed-out", forced: true });
    expect(pendingRequest.cancel).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it.each([
    ["a positive fractional force threshold", 500.5, 0.5],
    ["the default thresholds", 10_000, 8_000],
  ])("retains the positive timer path for %s", async (_label, timeoutMs, forceKillDelayMs) => {
    const child = makeTestBackendShutdownProcess();
    const forceTerminate = vi.fn();
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs,
      timeoutMs,
      startRequest: () => makePendingRequest(),
      forceTerminate,
    });

    expect(forceTerminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(forceKillDelayMs);
    expect(forceTerminate).toHaveBeenCalledOnce();
    await expectPromisePending(shutdown);

    await vi.advanceTimersByTimeAsync(timeoutMs - forceKillDelayMs);

    await expect(shutdown).resolves.toEqual({ type: "timed-out", forced: true });
    expect(forceTerminate).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(timeoutMs + 10_000);
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it("keeps a zero-delay throwing force attempt bounded and single-shot", async () => {
    const child = makeTestBackendShutdownProcess();
    const forceTerminate = vi.fn(() => {
      throw new Error("force failed");
    });
    const shutdown = stopWindowsBackendAndWait({
      child,
      backendHttpUrl: "http://127.0.0.1:3773",
      shutdownToken: "desktop-only-token",
      forceKillDelayMs: 0,
      timeoutMs: 0.5,
      startRequest: () => makePendingRequest(),
      forceTerminate,
    });

    expect(forceTerminate).toHaveBeenCalledOnce();
    await expectPromisePending(shutdown);

    await vi.advanceTimersByTimeAsync(0.5);

    await expect(shutdown).resolves.toEqual({ type: "timed-out", forced: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it("rejects timing configurations that cannot preserve a force-before-deadline bound", () => {
    const child = makeTestBackendShutdownProcess();
    expect(() =>
      stopWindowsBackendAndWait({
        child,
        backendHttpUrl: "http://127.0.0.1:3773",
        shutdownToken: "desktop-only-token",
        forceKillDelayMs: 10_000,
        timeoutMs: 10_000,
      }),
    ).toThrow(RangeError);
  });
});

describe("requireWindowsBackendExit", () => {
  it("accepts proven exit and rejects a bounded timeout with force-attempt context", () => {
    expect(() =>
      requireWindowsBackendExit({ type: "already-exited", forced: false }),
    ).not.toThrow();
    expect(() => requireWindowsBackendExit({ type: "exited", forced: true })).not.toThrow();

    try {
      requireWindowsBackendExit({ type: "timed-out", forced: true });
      throw new Error("Expected an unproven backend exit to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsBackendShutdownTimeoutError);
      expect(error).toMatchObject({ forced: true });
    }
  });
});

describe("runAfterDesktopShutdown", () => {
  it("runs shutdown-only actions only after shutdown completes successfully", async () => {
    const afterShutdown = vi.fn();

    await expect(
      runAfterDesktopShutdown(Promise.resolve(), afterShutdown),
    ).resolves.toBeUndefined();
    expect(afterShutdown).toHaveBeenCalledOnce();

    const shutdownError = new Error("backend still running");
    const afterFailedShutdown = vi.fn();
    await expect(
      runAfterDesktopShutdown(Promise.reject(shutdownError), afterFailedShutdown),
    ).rejects.toBe(shutdownError);
    expect(afterFailedShutdown).not.toHaveBeenCalled();
  });

  it("can run quit cleanup after a failed shutdown while preserving the rejection", async () => {
    const shutdownError = new Error("backend still running");
    const afterFailedShutdown = vi.fn();

    await expect(
      runAfterDesktopShutdown(Promise.reject(shutdownError), afterFailedShutdown, {
        runAfterShutdownFailure: true,
      }),
    ).rejects.toBe(shutdownError);
    expect(afterFailedShutdown).toHaveBeenCalledOnce();
  });
});

describe("shouldDeferDesktopWindowClose", () => {
  it("keeps Windows windows alive until shutdown or updater handoff is proven", () => {
    expect(
      shouldDeferDesktopWindowClose({
        platform: "win32",
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferDesktopWindowClose({
        platform: "linux",
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferDesktopWindowClose({
        platform: "win32",
        shutdownComplete: false,
        updaterHandoffActive: true,
      }),
    ).toBe(false);
    expect(
      shouldDeferDesktopWindowClose({
        platform: "darwin",
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(false);
  });
});

async function listen(
  listener: (request: Http.IncomingMessage, response: Http.ServerResponse) => void,
): Promise<{ readonly server: Http.Server; readonly baseUrl: string }> {
  const server = Http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("startDesktopBackendShutdownRequest", () => {
  it("posts only to the loopback shutdown path with the bearer credential", async () => {
    let observedMethod = "";
    let observedUrl = "";
    let observedAuthorization = "";
    const { server, baseUrl } = await listen((request, response) => {
      observedMethod = request.method ?? "";
      observedUrl = request.url ?? "";
      observedAuthorization = request.headers.authorization ?? "";
      response.writeHead(202).end();
    });

    try {
      const pending = startDesktopBackendShutdownRequest({
        backendHttpUrl: `${baseUrl}/ignored?token=browser-token`,
        shutdownToken: "desktop-only-token",
      });

      await expect(pending.outcome).resolves.toEqual({ type: "response", statusCode: 202 });
      expect(observedMethod).toBe("POST");
      expect(observedUrl).toBe(DESKTOP_BACKEND_SHUTDOWN_PATH);
      expect(observedAuthorization).toBe("Bearer desktop-only-token");
      pending.cancel();
    } finally {
      await closeServer(server);
    }
  });

  it("reports a rejected credential response without treating it as transport success", async () => {
    const { server, baseUrl } = await listen((request, response) => {
      response
        .writeHead(request.headers.authorization === "Bearer expected-token" ? 202 : 401)
        .end();
    });

    try {
      const pending = startDesktopBackendShutdownRequest({
        backendHttpUrl: baseUrl,
        shutdownToken: "wrong-token",
      });
      await expect(pending.outcome).resolves.toEqual({ type: "response", statusCode: 401 });
      pending.cancel();
    } finally {
      await closeServer(server);
    }
  });

  it("reports connection refusal as an error outcome", async () => {
    const { server, baseUrl } = await listen((_request, response) => response.end());
    await closeServer(server);

    const pending = startDesktopBackendShutdownRequest({
      backendHttpUrl: baseUrl,
      shutdownToken: "desktop-only-token",
    });

    await expect(pending.outcome).resolves.toEqual({ type: "error" });
    pending.cancel();
  });

  it("reports a reset connection as an error outcome", async () => {
    const { server, baseUrl } = await listen((request) => {
      request.socket.destroy();
    });

    try {
      const pending = startDesktopBackendShutdownRequest({
        backendHttpUrl: baseUrl,
        shutdownToken: "desktop-only-token",
      });
      await expect(pending.outcome).resolves.toEqual({ type: "error" });
      pending.cancel();
    } finally {
      await closeServer(server);
    }
  });

  it("cancels a hung response so it cannot outlive the shutdown deadline", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const { server, baseUrl } = await listen((request) => {
      sockets.add(request.socket);
      request.socket.once("close", () => sockets.delete(request.socket));
    });
    const pending = startDesktopBackendShutdownRequest({
      backendHttpUrl: baseUrl,
      shutdownToken: "desktop-only-token",
    });

    pending.cancel();

    await expect(pending.outcome).resolves.toEqual({ type: "cancelled" });
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });

  it("rejects missing credentials and non-loopback endpoints before making a request", () => {
    expect(() =>
      startDesktopBackendShutdownRequest({
        backendHttpUrl: "http://127.0.0.1:3773",
        shutdownToken: "",
      }),
    ).toThrow("token is required");
    expect(() =>
      startDesktopBackendShutdownRequest({
        backendHttpUrl: "https://example.com",
        shutdownToken: "desktop-only-token",
      }),
    ).toThrow("HTTP loopback endpoint");
  });
});
