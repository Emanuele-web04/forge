// FILE: processTreeKiller.ts
// Purpose: Captures and terminates PTY process trees without losing reparented children.
// Layer: Terminal infrastructure utility
// Depends on: node child_process, process signals, and tree-kill.
import { spawnSync } from "node:child_process";

import treeKill from "tree-kill";

const PROCESS_TREE_SCAN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_CAPTURE_ATTEMPTS = 2;
// Full-system `ps` output scales with host process count and command-line
// length (Electron helpers alone run to kilobytes per line); an undersized cap
// makes snapshot failure routine on busy machines.
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const PROCESS_COMMAND_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const POSIX_TREE_WALK_MAX_VISITED = 256;

export type ProcessChildrenMap = Map<number, Array<CapturedProcess>>;
export type ProcessCommandMap = Map<number, string>;

export interface CapturedProcess {
  pid: number;
  command: string;
}

export interface CapturedProcessTree {
  descendants: CapturedProcess[];
  /** False when the platform process snapshot failed and descendant absence is unproven. */
  captureComplete?: boolean;
}

export interface CapturedProcessTreeInspection {
  /** False when the process table could not be read, so exit cannot be proven. */
  verified: boolean;
  survivors: CapturedProcess[];
}

export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeKiller {
  capture(rootPid: number): CapturedProcessTree;
  inspect?(tree: CapturedProcessTree): CapturedProcessTreeInspection;
  signal(input: {
    rootPid: number;
    signal: TerminalKillSignal;
    tree: CapturedProcessTree;
    includeRootTree?: boolean | undefined;
    onError: (error: Error, context: { pid: number; source: "tree-kill" | "captured" }) => void;
  }): void;
}

export interface ProcessTreeKillerDependencies {
  captureChildrenMap: () => ProcessChildrenMap | null;
  readCurrentCommands: (pids: readonly number[]) => ProcessCommandMap | null;
  signalPid: (pid: number, signal: TerminalKillSignal) => Error | null;
  signalTree: (
    rootPid: number,
    signal: TerminalKillSignal,
    callback: (error?: Error | null) => void,
  ) => void;
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

  while (stack.length > 0 && descendants.length < POSIX_TREE_WALK_MAX_VISITED) {
    const child = stack.pop();
    if (!child || visited.has(child.pid)) {
      continue;
    }
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
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,command="], {
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
    const result = spawnSync("ps", ["-p", uniquePids.join(","), "-o", "pid=,command="], {
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
    if (errno?.code === "ESRCH") {
      return null;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function shouldSignalCapturedProcess(
  process: CapturedProcess,
  signal: TerminalKillSignal,
  currentCommands: ProcessCommandMap | null,
): boolean {
  if (signal !== "SIGKILL") {
    return true;
  }
  return currentCommands?.get(process.pid) === process.command;
}

function capturedProcessesForSignal(
  descendants: readonly CapturedProcess[],
  signal: TerminalKillSignal,
  readCommands: (pids: readonly number[]) => ProcessCommandMap | null,
): CapturedProcess[] {
  const currentCommands =
    signal === "SIGKILL" ? readCommands(descendants.map((descendant) => descendant.pid)) : null;
  return descendants.filter((descendant) =>
    shouldSignalCapturedProcess(descendant, signal, currentCommands),
  );
}

// Creates an injectable killer so tests can exercise PID-reuse safeguards safely.
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
        // tree-kill delegates to taskkill /T on Windows, which owns descendant traversal.
        return { descendants: [], captureComplete: true };
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
    signal: ({ rootPid, signal, tree, includeRootTree = true, onError }) => {
      // Signal captured descendants directly as well as through tree-kill. If
      // the PTY root exits, those children may be reparented before escalation.
      const capturedProcesses = capturedProcessesForSignal(
        tree.descendants,
        signal,
        deps.readCurrentCommands,
      );
      for (const descendant of capturedProcesses.toReversed()) {
        const error = deps.signalPid(descendant.pid, signal);
        if (error) {
          onError(error, { pid: descendant.pid, source: "captured" });
        }
      }
      if (includeRootTree) {
        deps.signalTree(rootPid, signal, (err) => {
          if (err) {
            onError(err, { pid: rootPid, source: "tree-kill" });
          }
        });
      }
    },
  };
}

export const defaultProcessTreeKiller: ProcessTreeKiller = createProcessTreeKiller();
