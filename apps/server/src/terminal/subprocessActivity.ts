// FILE: subprocessActivity.ts
// Purpose: Detects subprocess and coding-provider activity below terminal PTY processes.
// Layer: Terminal infrastructure

import path from "node:path";

import {
  deriveTerminalProcessIdentity,
  type TerminalCliKind,
} from "@synara/shared/terminalThreads";

import { runProcess } from "../processRunner";
import { parseProcessChildrenMap, type ProcessChildrenMap } from "./processTreeKiller";
import { captureWindowsProcessChildrenMap } from "./windowsProcessSnapshot";

const POSIX_SUBPROCESS_TREE_WALK_MAX_VISITED = 256;

export interface TerminalSubprocessActivity {
  cliKind: TerminalCliKind | null;
  hasRunningSubprocess: boolean;
  hasProviderDescendant: boolean;
  hasNonProviderSubprocess: boolean;
}

const SHELL_LIKE_PROCESS_NAMES = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "ksh",
  "login",
  "nu",
  "powershell",
  "pwsh",
  "screen",
  "sh",
  "tcsh",
  "tmux",
  "zellij",
  "zsh",
]);

function emptySubprocessActivity(): TerminalSubprocessActivity {
  return {
    cliKind: null,
    hasNonProviderSubprocess: false,
    hasProviderDescendant: false,
    hasRunningSubprocess: false,
  };
}

function processExecutableName(command: string): string {
  const firstToken = /^\s*"([^"]+)"/.exec(command)?.[1] ?? command.trim().split(/\s+/g)[0] ?? "";
  const normalizedPath = firstToken.replaceAll("\\", "/");
  return path
    .basename(normalizedPath)
    .replace(/\.(?:cmd|com|exe)$/i, "")
    .toLowerCase();
}

function isShellLikeProcessName(command: string): boolean {
  return SHELL_LIKE_PROCESS_NAMES.has(processExecutableName(command));
}

function deriveProcessCliKind(command: string): TerminalCliKind | null {
  return (
    deriveTerminalProcessIdentity(command)?.cliKind ??
    deriveTerminalProcessIdentity(processExecutableName(command))?.cliKind ??
    null
  );
}

function includeChildActivity(
  activity: TerminalSubprocessActivity,
  command: string,
  nestedActivity: TerminalSubprocessActivity,
): TerminalSubprocessActivity {
  const childCliKind = deriveProcessCliKind(command);
  const isShellLike = isShellLikeProcessName(command);
  return {
    cliKind: activity.cliKind ?? childCliKind ?? nestedActivity.cliKind,
    hasProviderDescendant:
      activity.hasProviderDescendant ||
      childCliKind !== null ||
      nestedActivity.hasProviderDescendant,
    hasNonProviderSubprocess:
      activity.hasNonProviderSubprocess ||
      (!childCliKind && !isShellLike) ||
      nestedActivity.hasNonProviderSubprocess,
    hasRunningSubprocess:
      activity.hasRunningSubprocess || !isShellLike || nestedActivity.hasRunningSubprocess,
  };
}

/**
 * Walk the process tree below `parentPid` using a pre-captured children map.
 * Pure and synchronous, so a single captured snapshot can be reused across many
 * polled terminals without re-scanning the system per terminal.
 */
export function inspectSubprocessActivity(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): TerminalSubprocessActivity {
  const children = childrenByParentPid.get(parentPid) ?? [];
  let activity = emptySubprocessActivity();
  for (const child of children) {
    const nestedActivity = inspectSubprocessActivity(child.pid, childrenByParentPid);
    activity = includeChildActivity(activity, child.command, nestedActivity);
  }
  return activity;
}

/**
 * Capture the whole-system process tree as a children-by-ppid map with a single
 * `ps` invocation. Returns null when `ps` is unavailable or fails. Sharing one
 * snapshot across all polled terminals turns an O(running-terminals) burst of
 * full-system scans per poll cycle into a single scan.
 */
export async function captureProcessChildrenMap(): Promise<ProcessChildrenMap | null> {
  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid=,command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) return null;
    if (psResult.stdoutTruncated) return null;

    return parseProcessChildrenMap(psResult.stdout);
  } catch {
    return null;
  }
}

async function readPosixChildPids(parentPid: number): Promise<number[]> {
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(parentPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 1) return [];
    if (pgrepResult.code !== 0) return [];
    return pgrepResult.stdout
      .split(/\s+/g)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function readPosixCommand(pid: number): Promise<string> {
  try {
    const psResult = await runProcess("ps", ["-p", String(pid), "-o", "command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    return psResult.code === 0 ? psResult.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function checkPosixSubprocessActivityByTreeWalk(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  let visited = 0;

  // Fallback for hosts where `ps -eo` was unavailable/truncated. It is slower,
  // but bounded and only used when the shared snapshot cannot be trusted.
  const inspectPid = async (parentPid: number): Promise<TerminalSubprocessActivity> => {
    if (visited >= POSIX_SUBPROCESS_TREE_WALK_MAX_VISITED) {
      return {
        cliKind: null,
        hasNonProviderSubprocess: true,
        hasProviderDescendant: false,
        hasRunningSubprocess: true,
      };
    }

    const childPids = await readPosixChildPids(parentPid);
    let activity = emptySubprocessActivity();
    for (const childPid of childPids) {
      visited += 1;
      const command = await readPosixCommand(childPid);
      if (!command) continue;
      const nestedActivity = await inspectPid(childPid);
      activity = includeChildActivity(activity, command, nestedActivity);
    }

    return activity;
  };

  return inspectPid(terminalPid);
}

async function checkPosixSubprocessActivity(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  // Cheap fast path: skip the full process scan when the shell has no children.
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(terminalPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 1) return emptySubprocessActivity();
    if (pgrepResult.code === 0 && pgrepResult.stdout.trim().length === 0) {
      return emptySubprocessActivity();
    }
  } catch {
    // Fall back to ps when pgrep is unavailable.
  }

  const childrenByParentPid = await captureProcessChildrenMap();
  if (childrenByParentPid === null) return checkPosixSubprocessActivityByTreeWalk(terminalPid);
  return inspectSubprocessActivity(terminalPid, childrenByParentPid);
}

export async function defaultSubprocessChecker(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return emptySubprocessActivity();
  }
  if (process.platform === "win32") {
    const childrenByParentPid = await captureWindowsProcessChildrenMap();
    return childrenByParentPid === null
      ? emptySubprocessActivity()
      : inspectSubprocessActivity(terminalPid, childrenByParentPid);
  }
  return checkPosixSubprocessActivity(terminalPid);
}
