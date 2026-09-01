import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessChildrenMap } from "./processTreeKiller";
import {
  createWindowsProcessSnapshotObserver,
  createWindowsTeardownProcessSnapshotObserver,
  parseWindowsProcessSnapshotLine,
  type ProcessChildrenSnapshotWorker,
} from "./windowsProcessSnapshot";

function snapshot(
  entries: Array<{ ppid: number; pid: number; command: string }>,
): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const entry of entries) {
    const siblings = childrenByParentPid.get(entry.ppid) ?? [];
    siblings.push({ pid: entry.pid, command: entry.command });
    childrenByParentPid.set(entry.ppid, siblings);
  }
  return childrenByParentPid;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Windows process snapshots", () => {
  it("parses base64-delimited rows without corrupting Windows command lines", () => {
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo';
    const encoded = Buffer.from(command, "utf8").toString("base64");

    expect(parseWindowsProcessSnapshotLine(`42\t7\t${encoded}`)).toEqual({
      pid: 42,
      ppid: 7,
      command,
    });
    expect(parseWindowsProcessSnapshotLine(`bad\t7\t${encoded}`)).toBeNull();
    expect(parseWindowsProcessSnapshotLine("42\t7\tnot-base64")).toBeNull();
  });

  it("coalesces concurrent terminal requests and reuses one worker across snapshots", async () => {
    const firstCapture = deferred<ProcessChildrenMap>();
    const firstSnapshot = snapshot([
      { ppid: 100, pid: 101, command: "codex.exe" },
      { ppid: 200, pid: 201, command: "node.exe build.js" },
    ]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn<() => Promise<ProcessChildrenMap>>()
        .mockImplementationOnce(() => firstCapture.promise)
        .mockResolvedValue(firstSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsProcessSnapshotObserver({ createWorker });

    const terminalOne = observer.capture();
    const terminalTwo = observer.capture();
    const terminalThree = observer.capture();
    await Promise.resolve();

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(1);

    firstCapture.resolve(firstSnapshot);
    await expect(Promise.all([terminalOne, terminalTwo, terminalThree])).resolves.toEqual([
      firstSnapshot,
      firstSnapshot,
      firstSnapshot,
    ]);

    await expect(observer.capture()).resolves.toBe(firstSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("times out a stalled worker and does not create another process during backoff", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const stalledCapture = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => stalledCapture.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker,
      now: () => now,
      probeTimeoutMs: 50,
      retryBackoffBaseMs: 200,
      retryBackoffMaxMs: 800,
    });

    const capture = observer.capture();
    await vi.advanceTimersByTimeAsync(50);

    await expect(capture).resolves.toBeNull();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(observer.retryDelayMs()).toBe(200);

    await expect(observer.capture()).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);

    now += 199;
    await expect(observer.capture()).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("backs off repeated failures and resets after a successful recovery", async () => {
    let now = 5_000;
    const recoveredSnapshot = snapshot([{ ppid: 300, pid: 301, command: "claude.exe" }]);
    const failedWorker = (): ProcessChildrenSnapshotWorker => ({
      capture: vi.fn().mockRejectedValue(new Error("WMI unavailable")),
      dispose: vi.fn(),
    });
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(recoveredSnapshot),
      dispose: vi.fn(),
    };
    const workers = [failedWorker(), failedWorker(), recoveredWorker];
    const createWorker = vi.fn(() => workers.shift() ?? recoveredWorker);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker,
      now: () => now,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 400,
    });

    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.retryDelayMs()).toBe(100);

    now += 100;
    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.retryDelayMs()).toBe(200);

    now += 200;
    await expect(observer.capture()).resolves.toBe(recoveredSnapshot);
    expect(observer.retryDelayMs()).toBe(0);

    await expect(observer.capture()).resolves.toBe(recoveredSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(3);
    expect(recoveredWorker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("retries teardown snapshots within the process-exit proof window", async () => {
    vi.useFakeTimers();
    const recoveredSnapshot = snapshot([{ ppid: 400, pid: 401, command: "provider.exe" }]);
    const failedWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("CIM unavailable")),
      dispose: vi.fn(),
    };
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(recoveredSnapshot),
      dispose: vi.fn(),
    };
    const workers = [failedWorker, recoveredWorker];
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker: () => workers.shift() ?? recoveredWorker,
    });

    const capture = observer.captureWithin(1_500);
    await vi.advanceTimersByTimeAsync(100);

    await expect(capture).resolves.toBe(recoveredSnapshot);
    expect(failedWorker.capture).toHaveBeenCalledTimes(1);
    expect(recoveredWorker.capture).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("does not start a fallback probe after the teardown snapshot budget expires", async () => {
    vi.useFakeTimers();
    const stalledCapture = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => stalledCapture.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsTeardownProcessSnapshotObserver({ createWorker });

    const capture = observer.captureWithin(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(capture).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });
});
