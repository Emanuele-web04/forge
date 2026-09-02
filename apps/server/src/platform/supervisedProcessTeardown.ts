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
import { createWindowsTeardownProcessSnapshotObserver } from "./windowsProcessSnapshot";

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;
const DEFAULT_INSPECT_INTERVAL_MS = 250;
const DEFAULT_WINDOWS_INITIAL_CAPTURE_MS = 3_000;
const FINAL_PROOF_INSPECTION_MAX_MS = 250;

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
  readonly platform: NodeJS.Platform;
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

  const platform = dependencies.platform ?? process.platform;
  const processTreeKiller = dependencies.processTreeKiller ?? defaultProcessTreeKiller;
  const windowsObserver =
    platform === "win32" &&
    dependencies.captureProcessTree === undefined &&
    dependencies.inspectProcessTree === undefined &&
    dependencies.processTreeKiller === undefined
      ? createWindowsTeardownProcessSnapshotObserver()
      : null;
  const captureTree =
    dependencies.captureProcessTree ??
    (dependencies.processTreeKiller
      ? async (rootPid: number) => processTreeKiller.capture(rootPid)
      : async (rootPid: number) =>
          captureProcessTree(rootPid, {
            platform,
            ...(windowsObserver
              ? {
                  captureWindowsChildren: () =>
                    windowsObserver.captureWithin(DEFAULT_WINDOWS_INITIAL_CAPTURE_MS),
                }
              : {}),
          }));
  const inspectTree = async (
    tree: CapturedProcessTree,
    timeoutMs: number,
  ): Promise<CapturedProcessTreeInspection> => {
    if (dependencies.inspectProcessTree) return dependencies.inspectProcessTree(tree);
    if (dependencies.processTreeKiller) {
      return (
        processTreeKiller.inspect?.(tree) ?? {
          verified: false,
          survivors: [...tree.descendants],
        }
      );
    }
    return inspectProcessTree(tree, {
      platform,
      ...(windowsObserver
        ? { captureWindowsChildren: () => windowsObserver.captureWithin(timeoutMs) }
        : {}),
    });
  };
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  let rootExited = false;
  void input.rootExited.then(
    () => {
      rootExited = true;
    },
    () => {
      // A rejected watcher is not evidence that the owned process exited.
    },
  );

  try {
    const tree = await captureTree(input.rootPid);
    const signalErrors: Error[] = [];

    const signal = (
      killSignal: TerminalKillSignal,
      includeRootTree: boolean,
      signalTree: CapturedProcessTree = tree,
      verifiedDescendants = false,
    ): void => {
      processTreeKiller.signal({
        rootPid: input.rootPid,
        signal: killSignal,
        tree: signalTree,
        verifiedDescendants,
        includeRootTree,
        onError: (error) => signalErrors.push(error),
      });
    };

    const inspectDescendants = async (
      timeoutMs: number,
    ): Promise<ReadonlyArray<CapturedProcess> | null> => {
      if (tree.captureComplete === false) return null;
      const inspection = await inspectTree(tree, timeoutMs);
      return inspection.verified ? inspection.survivors : null;
    };

    const waitForExitProof = async (timeoutMs: number) => {
      const deadline = now() + timeoutMs;
      const inspectIntervalMs = positiveDuration(
        input.inspectIntervalMs,
        DEFAULT_INSPECT_INTERVAL_MS,
      );
      let remainingDescendants: ReadonlyArray<CapturedProcess> | null =
        tree.captureComplete === false ? null : tree.descendants;
      let lastInspectedAt: number | null = null;
      do {
        await Promise.resolve();
        let remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        const sinceLastInspect = lastInspectedAt === null ? null : now() - lastInspectedAt;
        if (rootExited && (sinceLastInspect === null || sinceLastInspect >= inspectIntervalMs)) {
          lastInspectedAt = now();
          remainingDescendants = await inspectDescendants(remainingMs);
          if (remainingDescendants !== null && remainingDescendants.length === 0) {
            return { proven: true as const, remainingDescendants };
          }
        }
        remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(positiveDuration(input.pollMs, DEFAULT_POLL_MS), remainingMs));
      } while (now() <= deadline);

      if (rootExited) {
        const finalInspection = await inspectDescendants(
          Math.min(
            positiveDuration(input.inspectIntervalMs, DEFAULT_INSPECT_INTERVAL_MS),
            FINAL_PROOF_INSPECTION_MAX_MS,
          ),
        );
        if (finalInspection !== null) {
          remainingDescendants = finalInspection;
        }
        if (finalInspection !== null && finalInspection.length === 0) {
          return { proven: true as const, remainingDescendants: finalInspection };
        }
      }
      return { proven: false as const, remainingDescendants };
    };

    signal("SIGTERM", !rootExited);
    const graceful = await waitForExitProof(
      positiveDuration(input.termGraceMs, DEFAULT_TERM_GRACE_MS),
    );
    if (graceful.proven) return { escalated: false, signalErrors };

    let forceTree = tree;
    let forceDescendantsVerified = false;
    if (platform === "win32" && rootExited && tree.captureComplete !== false) {
      // When the Windows root is already gone, taskkill /T can no longer own
      // traversal. Re-snapshot through CIM immediately before escalation and
      // pass only descendants whose PID, command, and creation identity match.
      const forceInspection = await inspectTree(
        tree,
        positiveDuration(input.forceExitMs, DEFAULT_FORCE_EXIT_MS),
      );
      if (forceInspection.verified) {
        forceTree = {
          descendants: forceInspection.survivors,
          captureComplete: true,
        };
        forceDescendantsVerified = true;
      } else {
        // The root PID may already have been reused and descendant identities
        // are unknown. Do not target stale numeric PIDs; the proof step below
        // will fail closed with ProviderProcessExitUnprovenError.
        forceTree = { descendants: [], captureComplete: false };
      }
    }

    // Once the root has exited, never signal its numeric PID again: it may have
    // been reused. Force only descendants verified immediately before escalation.
    signal("SIGKILL", !rootExited, forceTree, forceDescendantsVerified);
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
