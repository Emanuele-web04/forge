// FILE: supervisedProcessTeardown.ts
// Purpose: Owns graceful, forced, and verified teardown for provider/runtime process trees.
// Layer: Server platform runtime

import { Effect } from "effect";

import {
  captureProcessTree,
  defaultProcessTreeKiller,
  inspectProcessTree,
  type CapturedProcess,
  type CapturedProcessTree,
  type CapturedProcessTreeInspection,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "./processTreeController";
import { createWindowsProcessSnapshotObserver } from "./windowsProcessSnapshot";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;
const DEFAULT_INSPECT_INTERVAL_MS = 250;

export interface SupervisedProcessTeardownInput {
  readonly rootPid: number;
  /** Must resolve only after the owned root process has emitted its terminal exit. */
  readonly rootExited: Promise<unknown>;
  readonly termGraceMs?: number;
  readonly forceExitMs?: number;
  readonly pollMs?: number;
  readonly inspectIntervalMs?: number;
}

export interface ProcessExitHandle {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
}

export interface EffectProcessExitHandle {
  readonly pid: number;
  readonly exitCode: Effect.Effect<unknown, unknown>;
}

export interface SupervisedProcessTeardownResult {
  readonly escalated: boolean;
  readonly signalErrors: ReadonlyArray<Error>;
}

export interface SupervisedProcessTeardownDependencies {
  readonly processTreeKiller: ProcessTreeKiller;
  readonly captureProcessTree: (rootPid: number) => Promise<CapturedProcessTree>;
  readonly inspectProcessTree: (
    tree: CapturedProcessTree,
  ) => Promise<CapturedProcessTreeInspection>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export class ProviderProcessExitUnprovenError extends Error {
  readonly rootPid: number;
  readonly rootExited: boolean;
  readonly remainingDescendantPids: ReadonlyArray<number> | null;
  readonly captureComplete: boolean;

  constructor(input: {
    readonly rootPid: number;
    readonly rootExited: boolean;
    readonly remainingDescendantPids: ReadonlyArray<number> | null;
    readonly captureComplete: boolean;
  }) {
    const descendantDetail =
      input.remainingDescendantPids === null
        ? "descendant state could not be verified"
        : input.remainingDescendantPids.length > 0
          ? `descendants still running: ${input.remainingDescendantPids.join(", ")}`
          : "no captured descendants remain";
    super(
      `Provider process tree ${input.rootPid} did not prove exit ` +
        `(rootExited=${String(input.rootExited)}, captureComplete=${String(input.captureComplete)}; ${descendantDetail}).`,
    );
    this.name = "ProviderProcessExitUnprovenError";
    this.rootPid = input.rootPid;
    this.rootExited = input.rootExited;
    this.remainingDescendantPids = input.remainingDescendantPids;
    this.captureComplete = input.captureComplete;
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function waitForOwnedProcessExit(process: ProcessExitHandle): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => resolve();
    process.once("exit", onExit);
    if (process.exitCode !== null || process.signalCode !== null) {
      process.removeListener("exit", onExit);
      resolve();
    }
  });
}

export async function teardownChildProcessTree(
  process: ProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Promise<SupervisedProcessTeardownResult> {
  if (process.pid === undefined) {
    throw new Error("Cannot prove process exit because the spawned process has no PID.");
  }
  return teardownProcessTree({
    rootPid: process.pid,
    rootExited: waitForOwnedProcessExit(process),
  });
}

export function teardownEffectProcessTree(
  process: EffectProcessExitHandle,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Promise<SupervisedProcessTeardownResult> {
  return teardownProcessTree({
    rootPid: Number(process.pid),
    rootExited: Effect.runPromise(Effect.exit(process.exitCode)),
  });
}

/**
 * Owns the complete process-tree stop sequence. Success means the exact root
 * emitted exit and every identity-matched descendant captured before TERM is gone.
 */
export async function teardownProviderProcessTree(
  input: SupervisedProcessTeardownInput,
  dependencies: Partial<SupervisedProcessTeardownDependencies> = {},
): Promise<SupervisedProcessTeardownResult> {
  if (!Number.isInteger(input.rootPid) || input.rootPid <= 0) {
    throw new TypeError(
      `Provider process root PID must be a positive integer, got ${input.rootPid}.`,
    );
  }

  const processTreeKiller = dependencies.processTreeKiller ?? defaultProcessTreeKiller;
  const windowsObserver =
    process.platform === "win32" &&
    dependencies.captureProcessTree === undefined &&
    dependencies.inspectProcessTree === undefined &&
    dependencies.processTreeKiller === undefined
      ? createWindowsProcessSnapshotObserver()
      : null;
  const captureTree =
    dependencies.captureProcessTree ??
    (dependencies.processTreeKiller
      ? async (rootPid: number) => processTreeKiller.capture(rootPid)
      : async (rootPid: number) =>
          captureProcessTree(rootPid, {
            ...(windowsObserver ? { captureWindowsChildren: windowsObserver.capture } : {}),
          }));
  const inspectTree =
    dependencies.inspectProcessTree ??
    (dependencies.processTreeKiller
      ? async (tree: CapturedProcessTree) =>
          processTreeKiller.inspect?.(tree) ?? {
            verified: false,
            survivors: [...tree.descendants],
          }
      : async (tree: CapturedProcessTree) =>
          inspectProcessTree(tree, {
            ...(windowsObserver ? { captureWindowsChildren: windowsObserver.capture } : {}),
          }));
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  try {
    const tree = await captureTree(input.rootPid);
    const signalErrors: Error[] = [];
    let rootExited = false;
    void input.rootExited.then(
      () => {
        rootExited = true;
      },
      () => {
        // A rejected watcher is not evidence that the owned process exited.
      },
    );

    const signal = (killSignal: TerminalKillSignal, includeRootTree: boolean): void => {
      processTreeKiller.signal({
        rootPid: input.rootPid,
        signal: killSignal,
        tree,
        includeRootTree,
        onError: (error) => signalErrors.push(error),
      });
    };

    const inspectDescendants = async (): Promise<ReadonlyArray<CapturedProcess> | null> => {
      if (tree.captureComplete === false) return null;
      const inspection = await inspectTree(tree);
      return inspection.verified ? inspection.survivors : null;
    };

    const waitForExitProof = async (timeoutMs: number) => {
      const deadline = now() + timeoutMs;
      const inspectIntervalMs = positiveDuration(
        input.inspectIntervalMs,
        DEFAULT_INSPECT_INTERVAL_MS,
      );
      let remainingDescendants: ReadonlyArray<CapturedProcess> | null = null;
      let lastInspectedAt: number | null = null;
      do {
        await Promise.resolve();
        const sinceLastInspect = lastInspectedAt === null ? null : now() - lastInspectedAt;
        if (rootExited && (sinceLastInspect === null || sinceLastInspect >= inspectIntervalMs)) {
          lastInspectedAt = now();
          remainingDescendants = await inspectDescendants();
          if (remainingDescendants !== null && remainingDescendants.length === 0) {
            return { proven: true as const, remainingDescendants };
          }
        }
        const remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(positiveDuration(input.pollMs, DEFAULT_POLL_MS), remainingMs));
      } while (now() <= deadline);
      return { proven: false as const, remainingDescendants: await inspectDescendants() };
    };

    signal("SIGTERM", true);
    const graceful = await waitForExitProof(
      positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS),
    );
    if (graceful.proven) return { escalated: false, signalErrors };

    // Once the root has exited, never signal its numeric PID again: it may have
    // been reused. Force only the captured descendants whose identities still match.
    signal("SIGKILL", !rootExited);
    const forced = await waitForExitProof(
      positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS),
    );
    if (forced.proven) return { escalated: true, signalErrors };

    throw new ProviderProcessExitUnprovenError({
      rootPid: input.rootPid,
      rootExited,
      remainingDescendantPids:
        forced.remainingDescendants?.map((descendant) => descendant.pid) ?? null,
      captureComplete: tree.captureComplete !== false,
    });
  } finally {
    windowsObserver?.dispose();
  }
}
