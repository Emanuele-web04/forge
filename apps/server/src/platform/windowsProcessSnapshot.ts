// FILE: windowsProcessSnapshot.ts
// Purpose: Maintains one bounded Windows process-table observer shared by runtime owners.
// Layer: Server Windows platform runtime

import { type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveWindowsSystemRoot } from "@synara/shared/windowsProcess";

import type { ProcessChildrenMap } from "./processTreeController";

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 30_000;
const TEARDOWN_RETRY_BACKOFF_BASE_MS = 100;
const TEARDOWN_RETRY_BACKOFF_MAX_MS = 250;
const MAX_SNAPSHOT_OUTPUT_BYTES = 8 * 1024 * 1024;

const SNAPSHOT_START_MARKER = "@snapshot";
const SNAPSHOT_END_MARKER = "@end";
const SNAPSHOT_ERROR_MARKER = "@error";

// EncodedCommand leaves stdin available for the request loop. CreationDate is
// included so delayed teardown never mistakes a reused Windows PID for the
// provider child that was originally captured.
const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
while (($request = [Console]::In.ReadLine()) -ne $null) {
  try {
    [Console]::Out.WriteLine('${SNAPSHOT_START_MARKER}')
    Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
      $command = if ($_.CommandLine) { [string]$_.CommandLine } else { [string]$_.Name }
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
      [Console]::Out.WriteLine(("{0}\t{1}\t{2}\t{3}" -f $_.ProcessId, $_.ParentProcessId, ([string]$_.CreationDate), $encoded))
    }
    [Console]::Out.WriteLine('${SNAPSHOT_END_MARKER}')
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('${SNAPSHOT_ERROR_MARKER}')
    [Console]::Out.Flush()
  }
}
`.trim();

export interface ProcessChildrenSnapshotWorker {
  capture(): Promise<ProcessChildrenMap>;
  dispose(): void;
}

export interface ProcessChildrenSnapshotObserver {
  capture(): Promise<ProcessChildrenMap | null>;
  retryDelayMs(): number;
  dispose(): void;
}

export interface TeardownProcessChildrenSnapshotObserver extends ProcessChildrenSnapshotObserver {
  captureWithin(timeoutMs: number): Promise<ProcessChildrenMap | null>;
}

interface PendingSnapshot {
  childrenByParentPid: ProcessChildrenMap;
  outputBytes: number;
  sawStartMarker: boolean;
  resolve: (snapshot: ProcessChildrenMap) => void;
  reject: (error: Error) => void;
}

interface PowerShellProcessSnapshotWorkerOptions {
  spawnProcess?: () => ChildProcessWithoutNullStreams;
}

export interface WindowsProcessSnapshotObserverOptions {
  createWorker?: () => ProcessChildrenSnapshotWorker;
  now?: () => number;
  probeTimeoutMs?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
}

type WindowsTeardownProcessSnapshotObserverOptions = Omit<
  WindowsProcessSnapshotObserverOptions,
  "retryBackoffBaseMs" | "retryBackoffMaxMs"
>;

function powershellExecutablePath(): string {
  return path.win32.join(
    resolveWindowsSystemRoot(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function spawnPowerShellSnapshotProcess(): ChildProcessWithoutNullStreams {
  return spawnProcess(
    powershellExecutablePath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedPowerShellCommand(WINDOWS_PROCESS_SNAPSHOT_SCRIPT),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      platform: "win32",
    },
  );
}

function decodeSnapshotCommand(encodedCommand: string): string | null {
  if (encodedCommand.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCommand)) {
    return null;
  }
  try {
    const command = Buffer.from(encodedCommand, "base64").toString("utf8").trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

/** Parses one base64-delimited worker row without trusting command-line contents as separators. */
export function parseWindowsProcessSnapshotLine(
  line: string,
): { pid: number; ppid: number; command: string; startedAt?: string } | null {
  const fields = line.split("\t");
  if (fields.length !== 3 && fields.length !== 4) return null;
  const [pidRaw, ppidRaw] = fields;
  const startedAtRaw = fields.length === 4 ? fields[2] : undefined;
  const encodedCommand = fields.at(-1);
  if (!encodedCommand) return null;
  const pid = Number(pidRaw);
  const ppid = Number(ppidRaw);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  const command = decodeSnapshotCommand(encodedCommand);
  if (command === null) return null;
  const startedAt = startedAtRaw?.trim();
  return {
    pid,
    ppid,
    command,
    ...(startedAt ? { startedAt } : {}),
  };
}

class PowerShellProcessSnapshotWorker implements ProcessChildrenSnapshotWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutCarry = "";
  private pending: PendingSnapshot | null = null;
  private terminalError: Error | null = null;
  private disposed = false;

  constructor(options: PowerShellProcessSnapshotWorkerOptions = {}) {
    this.child = (options.spawnProcess ?? spawnPowerShellSnapshotProcess)();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.consumeStdout(chunk);
    });
    this.child.stderr.resume();
    this.child.once("error", (error) => {
      this.fail(new Error(`Windows process snapshot worker failed: ${error.message}`));
    });
    this.child.once("close", (code, signal) => {
      this.fail(
        new Error(
          `Windows process snapshot worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });
  }

  capture(): Promise<ProcessChildrenMap> {
    if (this.disposed) {
      return Promise.reject(
        this.terminalError ?? new Error("Windows process snapshot worker closed."),
      );
    }
    if (this.pending) {
      return Promise.reject(new Error("Windows process snapshot worker is already capturing."));
    }

    return new Promise<ProcessChildrenMap>((resolve, reject) => {
      this.pending = {
        childrenByParentPid: new Map(),
        outputBytes: 0,
        sawStartMarker: false,
        resolve,
        reject,
      };
      this.child.stdin.write("snapshot\n", (error) => {
        if (error) {
          this.fail(new Error(`Failed to request Windows process snapshot: ${error.message}`));
        }
      });
    });
  }

  dispose(): void {
    this.fail(new Error("Windows process snapshot worker disposed."));
  }

  private consumeStdout(chunk: string): void {
    this.stdoutCarry += chunk;
    while (true) {
      const newlineIndex = this.stdoutCarry.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.stdoutCarry.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutCarry = this.stdoutCarry.slice(newlineIndex + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    const pending = this.pending;
    if (!pending) return;

    pending.outputBytes += Buffer.byteLength(line, "utf8") + 1;
    if (pending.outputBytes > MAX_SNAPSHOT_OUTPUT_BYTES) {
      this.fail(new Error("Windows process snapshot exceeded its output limit."));
      return;
    }
    if (line === SNAPSHOT_START_MARKER) {
      pending.sawStartMarker = true;
      pending.childrenByParentPid.clear();
      return;
    }
    if (line === SNAPSHOT_ERROR_MARKER) {
      this.fail(new Error("Windows process snapshot query failed."));
      return;
    }
    if (line === SNAPSHOT_END_MARKER) {
      if (!pending.sawStartMarker) {
        this.fail(new Error("Windows process snapshot ended before it started."));
        return;
      }
      this.pending = null;
      pending.resolve(pending.childrenByParentPid);
      return;
    }
    if (!pending.sawStartMarker) return;

    const process = parseWindowsProcessSnapshotLine(line);
    if (!process) {
      this.fail(new Error("Windows process snapshot contained a malformed process row."));
      return;
    }
    const siblings = pending.childrenByParentPid.get(process.ppid) ?? [];
    siblings.push({
      pid: process.pid,
      command: process.command,
      ...(process.startedAt ? { startedAt: process.startedAt } : {}),
    });
    pending.childrenByParentPid.set(process.ppid, siblings);
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminalError = error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    this.child.stdin.destroy();
    this.child.kill();
  }
}

export function createPowerShellProcessSnapshotWorker(
  options: PowerShellProcessSnapshotWorkerOptions = {},
): ProcessChildrenSnapshotWorker {
  return new PowerShellProcessSnapshotWorker(options);
}

function retryBackoffMs(failureCount: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failureCount - 1));
}

export function createWindowsProcessSnapshotObserver(
  options: WindowsProcessSnapshotObserverOptions = {},
): ProcessChildrenSnapshotObserver {
  const createWorker = options.createWorker ?? createPowerShellProcessSnapshotWorker;
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const retryBackoffBaseMs = options.retryBackoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS;
  const retryBackoffMaxMs = options.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;

  let worker: ProcessChildrenSnapshotWorker | null = null;
  let inFlight: Promise<ProcessChildrenMap | null> | null = null;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  let disposed = false;

  const captureWithTimeout = (
    activeWorker: ProcessChildrenSnapshotWorker,
  ): Promise<ProcessChildrenMap> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Windows process snapshot timed out after ${probeTimeoutMs}ms.`));
      }, probeTimeoutMs);
      timeout.unref?.();
      activeWorker.capture().then(
        (snapshot) => {
          clearTimeout(timeout);
          resolve(snapshot);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });

  return {
    capture: () => {
      if (disposed || now() < nextAttemptAt) return Promise.resolve(null);
      if (inFlight) return inFlight;

      const attempt = Promise.resolve()
        .then(() => {
          worker ??= createWorker();
          return captureWithTimeout(worker);
        })
        .then(
          (snapshot) => {
            consecutiveFailures = 0;
            nextAttemptAt = 0;
            return snapshot;
          },
          () => {
            worker?.dispose();
            worker = null;
            consecutiveFailures += 1;
            nextAttemptAt =
              now() + retryBackoffMs(consecutiveFailures, retryBackoffBaseMs, retryBackoffMaxMs);
            return null;
          },
        )
        .finally(() => {
          if (inFlight === attempt) inFlight = null;
        });
      inFlight = attempt;
      return attempt;
    },
    retryDelayMs: () => Math.max(0, nextAttemptAt - now()),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      worker?.dispose();
      worker = null;
    },
  };
}

/** Keeps teardown recovery inside its short proof windows without spawning fallback probes. */
export function createWindowsTeardownProcessSnapshotObserver(
  options: WindowsTeardownProcessSnapshotObserverOptions = {},
): TeardownProcessChildrenSnapshotObserver {
  const now = options.now ?? Date.now;
  const observer = createWindowsProcessSnapshotObserver({
    ...options,
    retryBackoffBaseMs: TEARDOWN_RETRY_BACKOFF_BASE_MS,
    retryBackoffMaxMs: TEARDOWN_RETRY_BACKOFF_MAX_MS,
  });

  const captureUntil = (deadline: number): Promise<ProcessChildrenMap | null> => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        resolve(null);
      }, remainingMs);
      observer.capture().then(
        (snapshot) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(snapshot);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(null);
        },
      );
    });
  };

  return {
    ...observer,
    captureWithin: async (timeoutMs) => {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
      const deadline = now() + timeoutMs;
      const firstSnapshot = await captureUntil(deadline);
      if (firstSnapshot !== null) return firstSnapshot;

      const retryDelayMs = observer.retryDelayMs();
      const remainingMs = deadline - now();
      if (retryDelayMs <= 0 || retryDelayMs >= remainingMs) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      return captureUntil(deadline);
    },
  };
}

/** One-shot fallback for callers that do not own a shared observer. */
export async function captureWindowsProcessChildrenMap(): Promise<ProcessChildrenMap | null> {
  const observer = createWindowsProcessSnapshotObserver();
  try {
    return await observer.capture();
  } finally {
    observer.dispose();
  }
}
