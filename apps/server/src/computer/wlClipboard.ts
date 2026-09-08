/**
 * Clipboard access through the wl-clipboard binaries.
 *
 * The clipboard reached here is seat0's, the human's, and that is deliberate.
 * A Wayland client binds its data device to one seat — seat0 for every Qt and
 * GTK toolkit build we drive — no matter which seat delivered its input, so the
 * dedicated synara-agent seat cannot hold a private working clipboard: a
 * synthesized Ctrl+C on it either fails the compositor's serial validation
 * silently or writes the human's clipboard anyway. These helpers therefore
 * address the selection directly and never synthesize copy/paste keystrokes.
 *
 * No `--seat` flag is passed, which leaves wl-clipboard on the first seat the
 * compositor advertises. That is seat0: it exists from compositor startup,
 * while the agent seat only appears once the KWin plugin creates it.
 */
import { spawn } from "node:child_process";

import { ComputerBackendError, MAX_COMPUTER_CLIPBOARD_BYTES } from "./ComputerBackend.ts";

/** Enough stderr to quote a wl-clipboard diagnostic, never enough to hold a payload. */
const MAX_CLIPBOARD_STDERR_BYTES = 8 * 1024;
/**
 * A selection is served by the application that owns it, so a wedged app can
 * hold the pipe open indefinitely. The deadline bounds what that costs a turn.
 */
const CLIPBOARD_TIMEOUT_MS = 5_000;

const WL_COPY = "wl-copy";
const WL_PASTE = "wl-paste";
const WL_CLIPBOARD_PACKAGE = "wl-clipboard";

/**
 * Generic type name: wl-paste picks any offered `text/*` representation, and
 * refuses a selection that has none. Without it wl-paste falls back to the
 * first offered type and would stream an image's raw bytes as "text".
 */
const CLIPBOARD_READ_TYPE = "text";
/**
 * Explicit on the write side because wl-copy otherwise infers the type from the
 * content, and infers zero bytes as `application/x-zerosize`, which reads back
 * as a non-text selection. wl-copy offers the same text aliases either way.
 */
const CLIPBOARD_WRITE_TYPE = "text/plain";

/** wl-clipboard is not localized, so its diagnostics are stable to match on. */
const EMPTY_CLIPBOARD_PATTERN = /nothing is copied/i;
const NON_TEXT_CLIPBOARD_PATTERN = /not available as requested type|no suitable type of content/i;

export interface ClipboardCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to stdin, never to argv, so clipboard text stays out of /proc cmdline. */
  readonly input?: string;
  /**
   * wl-copy forks a background child that keeps serving the selection and
   * inherits the parent's stderr, so waiting for the pipes to close would wait
   * for the next clipboard change. Only the parent's exit is awaited.
   */
  readonly forks?: boolean;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface ClipboardCommandResult {
  /** `exited` carries a real status; the other outcomes mean the child was killed. */
  readonly outcome: "exited" | "timed-out" | "output-limit";
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ClipboardCommandRunner = (
  spec: ClipboardCommandSpec,
) => Promise<ClipboardCommandResult>;

/** Reads the seat0 clipboard as text; an empty clipboard reads as `""`. */
export async function readWlClipboard(run: ClipboardCommandRunner): Promise<string> {
  const result = await runClipboardCommand(run, {
    command: WL_PASTE,
    args: ["--no-newline", "--type", CLIPBOARD_READ_TYPE],
    maxOutputBytes: MAX_COMPUTER_CLIPBOARD_BYTES,
  });
  if (result.outcome === "output-limit") {
    throw new ComputerBackendError(
      `The desktop clipboard holds more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes of text, which is past the limit this tool reads.`,
    );
  }
  if (result.outcome === "timed-out") {
    throw new ComputerBackendError(
      `${WL_PASTE} did not return within ${CLIPBOARD_TIMEOUT_MS}ms; the application owning the clipboard is not serving it.`,
      { retryable: true },
    );
  }
  if (result.code === 0) return result.stdout;
  // An empty clipboard is a non-zero exit rather than empty output, and is a
  // normal state the agent should read as "nothing copied", not as a failure.
  if (EMPTY_CLIPBOARD_PATTERN.test(result.stderr)) return "";
  if (NON_TEXT_CLIPBOARD_PATTERN.test(result.stderr)) {
    throw new ComputerBackendError(
      "The desktop clipboard holds non-text content, such as an image or a file, which cannot be read as text.",
    );
  }
  throw new ComputerBackendError(
    `${WL_PASTE} failed to read the desktop clipboard: ${describeFailure(result)}`,
  );
}

/** Replaces the seat0 clipboard, which discards whatever the human last copied. */
export async function writeWlClipboard(run: ClipboardCommandRunner, text: string): Promise<void> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_COMPUTER_CLIPBOARD_BYTES) {
    throw new ComputerBackendError(
      `Clipboard text is ${bytes} bytes, past the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte limit this tool writes.`,
    );
  }
  const result = await runClipboardCommand(run, {
    command: WL_COPY,
    args: ["--type", CLIPBOARD_WRITE_TYPE],
    input: text,
    forks: true,
  });
  if (result.outcome === "exited" && result.code === 0) return;
  throw new ComputerBackendError(
    `${WL_COPY} failed to write the desktop clipboard: ${describeFailure(result)}`,
    { retryable: result.outcome === "timed-out" },
  );
}

async function runClipboardCommand(
  run: ClipboardCommandRunner,
  spec: ClipboardCommandSpec,
): Promise<ClipboardCommandResult> {
  try {
    return await run(spec);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ComputerBackendError(
        `${spec.command} is not installed, so the desktop clipboard cannot be used. Install the ${WL_CLIPBOARD_PACKAGE} package.`,
        { cause: error },
      );
    }
    throw new ComputerBackendError(
      `Failed to run ${spec.command}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function describeFailure(result: ClipboardCommandResult): string {
  if (result.outcome === "timed-out") return `timed out after ${CLIPBOARD_TIMEOUT_MS}ms`;
  if (result.outcome === "output-limit")
    return `produced more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes`;
  const detail = result.stderr.trim().split("\n")[0];
  return detail && detail.length > 0 ? detail : `exit status ${result.code ?? "unknown"}`;
}

/**
 * Spawns one wl-clipboard process. Only spawn failures reject — an ENOENT for a
 * missing binary — so every exit status is mapped in one place above.
 *
 * `env` overrides the inherited environment: wl-clipboard talks to whichever
 * `WAYLAND_DISPLAY` it is handed.
 */
export function spawnClipboardCommand(
  spec: ClipboardCommandSpec,
  env?: NodeJS.ProcessEnv,
): Promise<ClipboardCommandResult> {
  const maxOutputBytes = spec.maxOutputBytes ?? MAX_COMPUTER_CLIPBOARD_BYTES;
  const timeoutMs = spec.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const stdout = new ChunkBuffer(maxOutputBytes);
    const stderr = new ChunkBuffer(MAX_CLIPBOARD_STDERR_BYTES);
    let outcome: ClipboardCommandResult["outcome"] = "exited";
    let settled = false;

    const timer = setTimeout(() => {
      outcome = "timed-out";
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A forking wl-copy leaves its background child holding these pipes, so
      // they are released here rather than waited on.
      child.stdout.destroy();
      child.stderr.destroy();
      // An output-limit run has no usable stdout — the buffer refuses to
      // pretend its truncated prefix is the real thing.
      const readStdout = () => {
        try {
          return stdout.text();
        } catch {
          return "";
        }
      };
      resolve({ outcome, code, stdout: readStdout(), stderr: stderr.text() });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.push(chunk)) return;
      outcome = "output-limit";
      child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("exit", (code) => {
      if (spec.forks === true || outcome !== "exited") settle(code);
    });
    child.on("close", (code) => settle(code));

    // The child may exit before it consumes the payload, which surfaces as an
    // exit status rather than as an unhandled stdin error.
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.input ?? "");
  });
}

class ChunkBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  /** `false` once the limit is passed, and the chunk is dropped. */
  push(chunk: Buffer): boolean {
    if (this.overflowed || this.bytes + chunk.byteLength > this.limit) {
      this.overflowed = true;
      return false;
    }
    this.bytes += chunk.byteLength;
    this.chunks.push(chunk);
    return true;
  }

  /**
   * Throws after an overflow rather than returning the arbitrary prefix that
   * survived: a truncated read must be recognizable as one, never mistaken for
   * the clipboard's actual contents.
   */
  text(): string {
    if (this.overflowed) {
      throw new ComputerBackendError(
        `The stream exceeded its ${this.limit} byte limit, so no usable text was captured.`,
      );
    }
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>).code
    : undefined;
}
