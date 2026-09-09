import { describe, expect, it } from "vitest";

import type {
  CapturedProcess,
  CapturedProcessTree,
  ProcessTreeKiller,
  TerminalKillSignal,
} from "../terminal/processTreeKiller";
import {
  ProviderProcessExitUnprovenError,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown";

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("teardownProviderProcessTree", () => {
  it("does not signal a root that exited during the initial snapshot", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: true };
    const captureStarted = deferred<void>();
    const capturedTree = deferred<CapturedProcessTree>();
    const rootExit = deferred<void>();
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const clock = deterministicClock();

    const teardown = teardownProviderProcessTree(
      { rootPid: 91, rootExited: rootExit.promise, termGraceMs: 5, forceExitMs: 5, pollMs: 1 },
      {
        platform: "win32",
        captureProcessTree: async () => {
          captureStarted.resolve(undefined);
          return capturedTree.promise;
        },
        inspectProcessTree: async () => ({ verified: true, survivors: [] }),
        processTreeKiller: {
          capture: () => tree,
          signal: ({ signal, includeRootTree }) => signals.push({ signal, includeRootTree }),
        },
        ...clock,
      },
    );

    await captureStarted.promise;
    rootExit.resolve(undefined);
    await Promise.resolve();
    capturedTree.resolve(tree);

    await expect(teardown).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(signals).toEqual([{ signal: "SIGTERM", includeRootTree: false }]);
  });

  it("escalates ignored TERM and returns only after root and descendants prove exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 102, command: "provider-worker" }],
      captureComplete: true,
    };
    const runningDescendants = new Map<number, CapturedProcess>([[102, tree.descendants[0]!]]);
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({ verified: true, survivors: [...runningDescendants.values()] }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGKILL") {
          runningDescendants.clear();
          resolveRootExit?.();
        }
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 101, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: true },
      { signal: "SIGKILL", includeRootTree: true },
    ]);
  });

  it("force-kills captured descendants without re-signalling a root that exited after TERM", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 202, command: "provider-grandchild" }],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      inspect: () => ({
        verified: true,
        survivors: descendantsRunning ? tree.descendants : [],
      }),
      signal: ({ signal, includeRootTree }) => {
        signals.push({ signal, includeRootTree });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 201, rootExited, termGraceMs: 10, forceExitMs: 10, pollMs: 5 },
        {
          processTreeKiller,
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });
    expect(signals.at(-1)).toEqual({ signal: "SIGKILL", includeRootTree: false });
  });

  it("re-verifies Windows descendants before force and signals only current identities", async () => {
    const child: CapturedProcess = {
      pid: 802,
      command: "provider-child.exe",
      startedAt: "20260901100000.000000+000",
    };
    const grandchild: CapturedProcess = {
      pid: 803,
      command: "provider-grandchild.exe",
      startedAt: "20260901100001.000000+000",
    };
    const tree: CapturedProcessTree = {
      descendants: [child, grandchild],
      captureComplete: true,
    };
    let descendantsRunning = true;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    const signals: Array<{
      signal: TerminalKillSignal;
      includeRootTree: boolean | undefined;
      verifiedDescendants: boolean | undefined;
      descendants: ReadonlyArray<CapturedProcess>;
    }> = [];
    const processTreeKiller: ProcessTreeKiller = {
      capture: () => tree,
      signal: ({ signal, includeRootTree, verifiedDescendants, tree: signalTree }) => {
        signals.push({
          signal,
          includeRootTree,
          verifiedDescendants,
          descendants: [...signalTree.descendants],
        });
        if (signal === "SIGTERM") resolveRootExit?.();
        if (signal === "SIGKILL") descendantsRunning = false;
      },
    };
    const clock = deterministicClock();

    await expect(
      teardownProviderProcessTree(
        { rootPid: 801, rootExited, termGraceMs: 5, forceExitMs: 5, pollMs: 5 },
        {
          platform: "win32",
          processTreeKiller,
          captureProcessTree: async () => tree,
          inspectProcessTree: async () => ({
            verified: true,
            // The child PID was reused during the grace period; only the
            // original grandchild still matches its CIM creation identity.
            survivors: descendantsRunning ? [grandchild] : [],
          }),
          ...clock,
        },
      ),
    ).resolves.toEqual({ escalated: true, signalErrors: [] });

    expect(signals.at(-1)).toEqual({
      signal: "SIGKILL",
      includeRootTree: false,
      verifiedDescendants: true,
      descendants: [grandchild],
    });
  });

  it("does not accept root exit as descendant proof when the snapshot failed", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: false };
    const signals: Array<{ signal: TerminalKillSignal; includeRootTree: boolean | undefined }> = [];
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 401,
        rootExited: Promise.resolve(),
        termGraceMs: 10,
        forceExitMs: 10,
        pollMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: ({ signal, includeRootTree }) => signals.push({ signal, includeRootTree }),
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      rootPid: 401,
      rootExited: true,
      captureComplete: false,
      remainingDescendantPids: null,
    });
    expect(signals).toEqual([
      { signal: "SIGTERM", includeRootTree: false },
      { signal: "SIGKILL", includeRootTree: false },
    ]);
  });

  it("still fails closed on an incomplete snapshot when the root never proves exit", async () => {
    const tree: CapturedProcessTree = { descendants: [], captureComplete: false };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 501, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: [] }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({ rootPid: 501, rootExited: false, captureComplete: false });
  });

  it("fails closed when forced termination cannot prove process-tree exit", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 302, command: "stuck-provider" }],
      captureComplete: true,
    };
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      { rootPid: 301, rootExited: new Promise(() => undefined), termGraceMs: 5, forceExitMs: 5 },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => ({ verified: true, survivors: tree.descendants }),
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderProcessExitUnprovenError);
    expect(failure).toMatchObject({
      name: "ProviderProcessExitUnprovenError",
      rootPid: 301,
      rootExited: false,
      remainingDescendantPids: [302],
    });
  });

  it("does not scan descendants before the root proves exit", async () => {
    // Descendant identity cannot end the wait until the root has exited, so
    // scanning beforehand only blocks the event loop. Failure details can use
    // the already captured descendants without another process-table read.
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 602, command: "stuck-provider" }],
      captureComplete: true,
    };
    let inspectCalls = 0;
    const clock = deterministicClock();

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 601,
        rootExited: new Promise(() => undefined),
        termGraceMs: 500,
        forceExitMs: 500,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return { verified: true, survivors: tree.descendants };
          },
          signal: () => undefined,
        },
        ...clock,
      },
    ).catch((error: unknown) => error);

    expect(inspectCalls).toBe(0);
    expect(failure).toMatchObject({ remainingDescendantPids: [602] });
  });

  it("throttles descendant scans instead of running one per poll", async () => {
    const tree: CapturedProcessTree = {
      descendants: [{ pid: 702, command: "provider-worker" }],
      captureComplete: true,
    };
    let inspectCalls = 0;
    let sleepCalls = 0;
    let resolveRootExit: (() => void) | undefined;
    const rootExited = new Promise<void>((resolve) => {
      resolveRootExit = resolve;
    });
    let now = 0;

    await teardownProviderProcessTree(
      {
        rootPid: 701,
        rootExited,
        termGraceMs: 1_000,
        forceExitMs: 1_000,
        pollMs: 25,
        inspectIntervalMs: 250,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return { verified: true, survivors: tree.descendants };
          },
          signal: ({ signal }) => {
            if (signal === "SIGTERM") resolveRootExit?.();
          },
        },
        now: () => now,
        sleep: async (milliseconds: number) => {
          sleepCalls += 1;
          now += milliseconds;
        },
      },
    ).catch(() => undefined);

    // The root exits immediately, so every poll used to trigger its own `ps`.
    expect(sleepCalls).toBeGreaterThan(60);
    expect(inspectCalls).toBeLessThanOrEqual(sleepCalls / 4);
  });

  it("rechecks descendants after the final wait before reporting failure", async () => {
    const descendant = { pid: 902, command: "provider-worker" };
    const tree: CapturedProcessTree = {
      descendants: [descendant],
      captureComplete: true,
    };
    let descendantRunning = true;
    const signals: TerminalKillSignal[] = [];
    let now = 0;

    await expect(
      teardownProviderProcessTree(
        {
          rootPid: 901,
          rootExited: Promise.resolve(),
          termGraceMs: 5,
          forceExitMs: 5,
          pollMs: 5,
        },
        {
          processTreeKiller: {
            capture: () => tree,
            inspect: () => ({
              verified: true,
              survivors: descendantRunning ? [descendant] : [],
            }),
            signal: ({ signal }) => signals.push(signal),
          },
          now: () => now,
          sleep: async (milliseconds) => {
            descendantRunning = false;
            now += milliseconds;
          },
        },
      ),
    ).resolves.toEqual({ escalated: false, signalErrors: [] });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("preserves the last verified survivors when the final recheck is unverified", async () => {
    const descendant = { pid: 912, command: "provider-worker" };
    const tree: CapturedProcessTree = {
      descendants: [descendant],
      captureComplete: true,
    };
    let inspectCalls = 0;
    let now = 0;

    const failure = await teardownProviderProcessTree(
      {
        rootPid: 911,
        rootExited: Promise.resolve(),
        termGraceMs: 5,
        forceExitMs: 5,
        pollMs: 5,
      },
      {
        processTreeKiller: {
          capture: () => tree,
          inspect: () => {
            inspectCalls += 1;
            return inspectCalls % 2 === 1
              ? { verified: true, survivors: [descendant] }
              : { verified: false, survivors: [] };
          },
          signal: () => undefined,
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ remainingDescendantPids: [912] });
  });
});
