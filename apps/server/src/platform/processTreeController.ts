// FILE: processTreeController.ts
// Purpose: Captures, inspects, and signals owned process trees across platforms.
// Layer: Server platform runtime

import { spawnProcessSync } from "@synara/shared/processRuntime";
import treeKill from "tree-kill";

import { captureWindowsProcessChildrenMap } from "./windowsProcessSnapshot";

const PROCESS_TREE_SCAN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_CAPTURE_ATTEMPTS = 2;
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const PROCESS_COMMAND_SCAN_MAX_BUFFER_BYTES = 8_388_608;

export type ProcessChildrenMap = Map<number, Array<CapturedProcess>>;
export type ProcessCommandMap = Map<number, string>;

export interface CapturedProcess {
  readonly pid: number;
  readonly command: string;
  /** Windows CIM CreationDate, used to reject PID reuse during delayed escalation. */
  readonly startedAt?: string;
}

export interface CapturedProcessTree {
  readonly descendants: CapturedProcess[];
  /** False when the platform process snapshot failed and descendant absence is unproven. */
  readonly captureComplete?: boolean;
}

export interface CapturedProcessTreeInspection {
  /** False when the process table could not be read, so exit cannot be proven. */
  readonly verified: boolean;
  readonly survivors: CapturedProcess[];
}

export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeKiller {
  capture(rootPid: number): CapturedProcessTree;
  inspect?(tree: CapturedProcessTree): CapturedProcessTreeInspection;
  signal(input: {
    readonly rootPid: number;
    readonly signal: TerminalKillSignal;
    readonly tree: CapturedProcessTree;
    /**
     * True only when `tree.descendants` were identity-verified immediately
     * before this signal. This lets Windows use CIM CreationDate verification
     * without falling back to POSIX `ps` before forced descendant cleanup.
     */
    readonly verifiedDescendants?: boolean | undefined;
    readonly includeRootTree?: boolean | undefined;
    readonly onError: (
      error: Error,
      context: { readonly pid: number; readonly source: "tree-kill" | "captured" },
    ) => void;
  }): void;
}

export interface ProcessTreeKillerDependencies {
  readonly captureChildrenMap: () => ProcessChildrenMap | null;
  readonly readCurrentCommands: (pids: readonly number[]) => ProcessCommandMap | null;
  readonly signalPid: (pid: number, signal: TerminalKillSignal) => Error | null;
  readonly signalTree: (
    rootPid: number,
    signal: TerminalKillSignal,
    callback: (error?: Error | null) => void,
  ) => void;
}

export interface PlatformProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly processTreeKiller?: ProcessTreeKiller;
  readonly captureWindowsChildren?: () => Promise<ProcessChildrenMap | null>;
}

export function parseProcessChildrenMap(psOutput: string): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const command = commandParts.join(" ").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, command });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

export function parseProcessCommandMap(psOutput: string): ProcessCommandMap {
  const commandsByPid: ProcessCommandMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? "";
    if (!Number.isInteger(pid) || command.length === 0) continue;
    commandsByPid.set(pid, command);
  }
  return commandsByPid;
}

export function collectDescendantProcesses(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): CapturedProcess[] {
  const descendants: CapturedProcess[] = [];
  const stack = [...(childrenByParentPid.get(parentPid) ?? [])].reverse();
  const visited = new Set<number>([parentPid]);

  while (stack.length > 0) {
    const child = stack.pop();
    if (!child || visited.has(child.pid)) continue;
    visited.add(child.pid);
    descendants.push(child);

    const nestedChildren = childrenByParentPid.get(child.pid) ?? [];
    for (const nestedChild of [...nestedChildren].reverse()) {
      stack.push(nestedChild);
    }
  }

  return descendants;
}

function captureProcessChildrenMapSync(): ProcessChildrenMap | null {
  try {
    const result = spawnProcessSync("ps", ["-eo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    return parseProcessChildrenMap(result.stdout);
  } catch {
    return null;
  }
}

function readCurrentCommands(pids: readonly number[]): ProcessCommandMap | null {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) return new Map();
  try {
    const result = spawnProcessSync("ps", ["-p", uniquePids.join(","), "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: PROCESS_COMMAND_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error) return null;
    if (result.status !== 0) return new Map();
    return parseProcessCommandMap(result.stdout);
  } catch {
    return null;
  }
}

function signalPid(pid: number, signal: TerminalKillSignal): Error | null {
  try {
    globalThis.process.kill(pid, signal);
    return null;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ESRCH") return null;
    return error instanceof Error ? error : new Error(String(error));
  }
}

function shouldSignalCapturedProcess(
  process: CapturedProcess,
  signal: TerminalKillSignal,
  currentCommands: ProcessCommandMap | null,
): boolean {
  if (signal !== "SIGKILL") return true;
  return currentCommands?.get(process.pid) === process.command;
}

function capturedProcessesForSignal(
  descendants: readonly CapturedProcess[],
  signal: TerminalKillSignal,
  readCommands: (pids: readonly number[]) => ProcessCommandMap | null,
  verifiedDescendants: boolean,
): CapturedProcess[] {
  if (verifiedDescendants) return [...descendants];
  const currentCommands =
    signal === "SIGKILL" ? readCommands(descendants.map((descendant) => descendant.pid)) : null;
  return descendants.filter((descendant) =>
    shouldSignalCapturedProcess(descendant, signal, currentCommands),
  );
}

export function createProcessTreeKiller(
  dependencies: Partial<ProcessTreeKillerDependencies> = {},
): ProcessTreeKiller {
  const deps: ProcessTreeKillerDependencies = {
    captureChildrenMap: captureProcessChildrenMapSync,
    readCurrentCommands,
    signalPid,
    signalTree: treeKill,
    ...dependencies,
  };

  return {
    capture: (rootPid) => {
      if (!Number.isInteger(rootPid) || rootPid <= 0) {
        return { descendants: [], captureComplete: false };
      }
      if (globalThis.process.platform === "win32") {
        // The synchronous terminal compatibility API cannot query CIM safely.
        // Windows teardown owners must use captureProcessTree below.
        return { descendants: [], captureComplete: false };
      }
      let childrenByParentPid: ProcessChildrenMap | null = null;
      for (
        let attempt = 0;
        attempt < PROCESS_TREE_CAPTURE_ATTEMPTS && !childrenByParentPid;
        attempt += 1
      ) {
        childrenByParentPid = deps.captureChildrenMap();
      }
      if (!childrenByParentPid) return { descendants: [], captureComplete: false };
      return {
        descendants: collectDescendantProcesses(rootPid, childrenByParentPid),
        captureComplete: true,
      };
    },
    inspect: (tree) => {
      if (tree.captureComplete === false) {
        return { verified: false, survivors: [...tree.descendants] };
      }
      if (tree.descendants.length === 0) {
        return { verified: true, survivors: [] };
      }
      const currentCommands = deps.readCurrentCommands(
        tree.descendants.map((descendant) => descendant.pid),
      );
      if (currentCommands === null) {
        return { verified: false, survivors: [...tree.descendants] };
      }
      return {
        verified: true,
        survivors: tree.descendants.filter(
          (descendant) => currentCommands.get(descendant.pid) === descendant.command,
        ),
      };
    },
    signal: ({
      rootPid,
      signal,
      tree,
      verifiedDescendants = false,
      includeRootTree = true,
      onError,
    }) => {
      const capturedProcesses = capturedProcessesForSignal(
        tree.descendants,
        signal,
        deps.readCurrentCommands,
        verifiedDescendants,
      );
      for (const descendant of capturedProcesses.toReversed()) {
        const error = deps.signalPid(descendant.pid, signal);
        if (error) onError(error, { pid: descendant.pid, source: "captured" });
      }
      if (includeRootTree) {
        deps.signalTree(rootPid, signal, (error) => {
          if (error) onError(error, { pid: rootPid, source: "tree-kill" });
        });
      }
    },
  };
}

function processesByPid(childrenByParentPid: ProcessChildrenMap): Map<number, CapturedProcess> {
  const result = new Map<number, CapturedProcess>();
  for (const children of childrenByParentPid.values()) {
    for (const child of children) result.set(child.pid, child);
  }
  return result;
}

function sameCapturedIdentity(expected: CapturedProcess, current: CapturedProcess): boolean {
  if (expected.command !== current.command) return false;
  if (expected.startedAt === undefined) return true;
  return current.startedAt === expected.startedAt;
}

/** Capture descendants using the native platform observer. */
export async function captureProcessTree(
  rootPid: number,
  options: PlatformProcessTreeOptions = {},
): Promise<CapturedProcessTree> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { descendants: [], captureComplete: false };
  }
  const platform = options.platform ?? process.platform;
  const killer = options.processTreeKiller ?? defaultProcessTreeKiller;
  if (platform !== "win32") return killer.capture(rootPid);

  const childrenByParentPid = await (
    options.captureWindowsChildren ?? captureWindowsProcessChildrenMap
  )();
  if (!childrenByParentPid) return { descendants: [], captureComplete: false };
  return {
    descendants: collectDescendantProcesses(rootPid, childrenByParentPid),
    captureComplete: true,
  };
}

/** Inspect the exact captured identities; snapshot failure is never interpreted as exit. */
export async function inspectProcessTree(
  tree: CapturedProcessTree,
  options: PlatformProcessTreeOptions = {},
): Promise<CapturedProcessTreeInspection> {
  if (tree.captureComplete === false) {
    return { verified: false, survivors: [...tree.descendants] };
  }
  if (tree.descendants.length === 0) return { verified: true, survivors: [] };

  const platform = options.platform ?? process.platform;
  const killer = options.processTreeKiller ?? defaultProcessTreeKiller;
  if (platform !== "win32") {
    return killer.inspect?.(tree) ?? { verified: false, survivors: [...tree.descendants] };
  }

  const childrenByParentPid = await (
    options.captureWindowsChildren ?? captureWindowsProcessChildrenMap
  )();
  if (!childrenByParentPid) {
    return { verified: false, survivors: [...tree.descendants] };
  }
  const currentByPid = processesByPid(childrenByParentPid);
  return {
    verified: true,
    survivors: tree.descendants.filter((expected) => {
      const current = currentByPid.get(expected.pid);
      return current !== undefined && sameCapturedIdentity(expected, current);
    }),
  };
}

/** Signal an owned tree through one platform boundary (taskkill /T on Windows via tree-kill). */
export function signalProcessTree(input: {
  readonly rootPid: number;
  readonly signal: TerminalKillSignal;
  readonly tree?: CapturedProcessTree;
  readonly verifiedDescendants?: boolean;
  readonly includeRootTree?: boolean;
  readonly onError?: (
    error: Error,
    context: { readonly pid: number; readonly source: "tree-kill" | "captured" },
  ) => void;
  readonly processTreeKiller?: ProcessTreeKiller;
}): void {
  (input.processTreeKiller ?? defaultProcessTreeKiller).signal({
    rootPid: input.rootPid,
    signal: input.signal,
    tree: input.tree ?? { descendants: [], captureComplete: false },
    verifiedDescendants: input.verifiedDescendants,
    includeRootTree: input.includeRootTree,
    onError: input.onError ?? (() => undefined),
  });
}

/**
 * Signal one owned child the way the host platform can honor it. POSIX callers
 * keep Node's direct, synchronous `child.kill` (a stopped git or CLI must not
 * depend on `ps`/`pgrep` being installed); Windows routes through the tree
 * boundary because a `.cmd` shim runs under cmd.exe and only `taskkill /T`
 * reaches the real command behind it.
 */
export function signalOwnedChildProcess(
  child: { readonly pid?: number | undefined; kill(signal?: NodeJS.Signals): unknown },
  signal: TerminalKillSignal,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    signalProcessTree({ rootPid: child.pid, signal });
    return;
  }
  child.kill(signal);
}

export const defaultProcessTreeKiller: ProcessTreeKiller = createProcessTreeKiller();
