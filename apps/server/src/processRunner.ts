import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  signal?: AbortSignal | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return /is not recognized as an internal or external command/i.test(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function processAbortError(): Error {
  const error = new Error("Process execution was aborted.");
  error.name = "AbortError";
  return error;
}

// Windows `.cmd` shims may run under an explicit cmd.exe wrapper; taskkill keeps
// timeout/cancel paths from leaving the real command behind.
function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback to direct kill
    }
  }
  child.kill(signal);
}

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      next: `${target}${chunk.toString()}`,
      nextBytes: currentBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    next: `${target}${chunk.subarray(0, remaining).toString()}`,
    nextBytes: currentBytes + remaining,
    truncated: true,
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  if (options.signal?.aborted) {
    throw processAbortError();
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const prepared = prepareWindowsSafeProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
    });
    const child = spawn(prepared.command, prepared.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: prepared.shell,
      windowsHide: prepared.windowsHide,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleForceKill = (): void => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
    };

    const onAbort = (): void => {
      // The first terminal cause wins: a signal that arrives after the timeout fired must not
      // relabel the already-timed-out process as an explicit cancellation.
      if (settled || aborted || timedOut) return;
      aborted = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      killChild(child, "SIGTERM");
      scheduleForceKill();
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      scheduleForceKill();
    }, timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const fail = (error: Error): void => {
      killChild(child, "SIGTERM");
      finalize(() => {
        reject(error);
      });
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      if (aborted) return null;
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const text = chunkBuffer.toString();
      const byteLength = chunkBuffer.length;
      if (stream === "stdout") {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunkBuffer, maxBufferBytes);
          stdout = appended.next;
          stdoutBytes = appended.nextBytes;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          return null;
        }
        stdout += text;
        stdoutBytes += byteLength;
        if (stdoutBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stdout", maxBufferBytes);
        }
      } else {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stderr, stderrBytes, chunkBuffer, maxBufferBytes);
          stderr = appended.next;
          stderrBytes = appended.nextBytes;
          stderrTruncated = stderrTruncated || appended.truncated;
          return null;
        }
        stderr += text;
        stderrBytes += byteLength;
        if (stderrBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stderr", maxBufferBytes);
        }
      }
      return null;
    };

    const notifyOutputObserver = (
      observer: ((chunk: string) => void) | undefined,
      chunk: Buffer | string,
    ): void => {
      if (!observer) return;
      try {
        observer(chunk.toString());
      } catch {
        // Live-output observers are best effort and must never crash the child-process lifecycle.
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      notifyOutputObserver(options.onStdoutChunk, chunk);
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      notifyOutputObserver(options.onStderrChunk, chunk);
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(aborted ? processAbortError() : normalizeSpawnError(command, args, error));
      });
    });

    child.once("close", (code, signal) => {
      const result: ProcessRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };

      finalize(() => {
        if (aborted) {
          reject(processAbortError());
          return;
        }
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(normalizeExitError(command, args, result));
          return;
        }
        resolve(result);
      });
    });

    child.stdin.once("error", (error) => {
      if (aborted) return;
      fail(normalizeStdinError(command, args, error));
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (aborted) return;
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
