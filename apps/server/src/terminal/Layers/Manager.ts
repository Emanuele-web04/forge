// FILE: Manager.ts
// Purpose: Implements server-side terminal sessions, cleanup orchestration, history persistence, and PTY output flow control.
// Layer: Terminal infrastructure
// Depends on: PTY adapters, process-tree cleanup helpers, shared terminal contracts, and server config.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import {
  consumeTerminalIdentityInput,
  terminalCliKindFromValue,
  SYNARA_TERMINAL_HOOK_OSC_PREFIX,
  SYNARA_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalActivityState,
  type TerminalAgentHookEventType,
  type TerminalCliKind,
} from "@synara/shared/terminalThreads";
import { Effect, Encoding, Layer, Schema } from "effect";

import { createLogger } from "../../logger";
import { PtyAdapter, PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import { ServerConfig } from "../../config";
import {
  ensurePrivateDirectorySync,
  PRIVATE_FILE_MODE,
  repairPrivateFile,
} from "../../privatePathPermissions";
import {
  applyManagedTerminalAgentWrapperEnv,
  prepareManagedTerminalAgentWrappers,
} from "../managedTerminalWrappers";
import {
  ShellCandidate,
  TerminalError,
  TerminalManager,
  TerminalManagerShape,
  type TerminalCloseOpenedAtOrBeforeInput,
  TerminalSessionState,
  TerminalStartInput,
} from "../Services/Manager";
import {
  capHistoryByLimits,
  DEFAULT_HISTORY_BYTE_LIMIT,
  TerminalHistoryBuffer,
  type HistoryLimits,
} from "../terminalHistory";
import { createTerminalModeReplayTracker } from "../terminalModeReplay";
import {
  defaultProcessTreeKiller,
  type ProcessTreeKiller,
  type TerminalKillSignal,
} from "../processTreeKiller";
import {
  captureProcessChildrenMap,
  defaultSubprocessChecker,
  inspectSubprocessActivity,
  type TerminalSubprocessActivity,
} from "../subprocessActivity";
import {
  createWindowsProcessSnapshotObserver,
  type ProcessChildrenSnapshotObserver,
} from "../windowsProcessSnapshot";

export type { TerminalSubprocessActivity } from "../subprocessActivity";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
/**
 * When every running terminal is idle (no live subprocess and no recent
 * input/output) the subprocess poll backs off to this multiple of the base
 * interval, cutting the per-`ps` idle drain. Any activity pulls the cadence back
 * to the base interval via {@link TerminalManagerRuntime#bumpSubprocessPolling}.
 */
const SUBPROCESS_IDLE_POLL_MULTIPLIER = 8;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
/** Flush batched PTY output at ~60 fps to reduce WebSocket message volume. */
const OUTPUT_BATCH_INTERVAL_MS = 16;
/** Flush immediately when the batched output exceeds this byte count. */
const OUTPUT_BATCH_SIZE_LIMIT = 131_072; // 128 KB
/** Pause PTY reads when the pending output buffer exceeds this size. */
const OUTPUT_BUFFER_HIGH_WATERMARK = 1_048_576; // 1 MB
/** Pause once renderer-unacked output grows past this byte count. */
const OUTPUT_ACK_HIGH_WATERMARK = 100_000;
/** Resume after parsed-output ACKs drain below this byte count. */
const OUTPUT_ACK_LOW_WATERMARK = 5_000;
/**
 * Force-resume ACK-paused reads if no ACK arrives within this window. Each ACK is
 * proof the renderer is alive and resets the countdown, so this only fires when a
 * renderer has stalled or disconnected while reads were paused.
 */
const OUTPUT_ACK_RESUME_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const PROVIDER_INPUT_ACTIVITY_GRACE_MS = 120_000;
const PROVIDER_OUTPUT_ACTIVITY_GRACE_MS = 30_000;
const SHUTDOWN_ESCALATION_SETTLE_MS = 25;
const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  // Host-terminal identity must not leak into the PTY: sessions render in the
  // app's xterm.js surface, not in whichever emulator launched this server.
  // An inherited TERM like "xterm-ghostty" (plus its TERMINFO pointers) makes
  // spawned shells use wrong/missing terminfo — "unknown terminal type"
  // errors and garbled line-editor redraw.
  "TERM",
  "TERMINFO",
  "TERMINFO_DIRS",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  // Color-control identity is also the host's, not the PTY's: a server launched
  // from a non-interactive harness shell (e.g. `codex exec` sets NO_COLOR=1)
  // would otherwise blank every ANSI color in every spawned terminal. COLORTERM
  // is stripped here and pinned below alongside TERM.
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLORFGBG",
  "COLORTERM",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
  "ITERM_PROFILE",
  "ITERM_SESSION_ID",
  "KITTY_WINDOW_ID",
  "KITTY_PID",
  "KITTY_INSTALLATION_DIR",
  "WEZTERM_EXECUTABLE",
  "WEZTERM_CONFIG_FILE",
  "WEZTERM_PANE",
  "WEZTERM_UNIX_SOCKET",
  "ALACRITTY_SOCKET",
  "ALACRITTY_WINDOW_ID",
]);

// What the app's embedded xterm.js surface actually implements; mirrors the
// `name` passed to the PTY adapters (node-pty only uses `name` when the env
// carries no TERM of its own, so we pin it explicitly).
const TERMINAL_SPAWN_TERM =
  globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color";
const MANAGED_TERMINAL_WRAPPER_DIRNAME = "_managed-bin";
const MANAGED_TERMINAL_ZSH_DIRNAME = "_managed-zsh";

const decodeTerminalOpenInput = Schema.decodeUnknownSync(TerminalOpenInput);
const decodeTerminalRestartInput = Schema.decodeUnknownSync(TerminalRestartInput);
const decodeTerminalWriteInput = Schema.decodeUnknownSync(TerminalWriteInput);
const decodeTerminalAckOutputInput = Schema.decodeUnknownSync(TerminalAckOutputInput);
const decodeTerminalResizeInput = Schema.decodeUnknownSync(TerminalResizeInput);
const decodeTerminalClearInput = Schema.decodeUnknownSync(TerminalClearInput);
const decodeTerminalCloseInput = Schema.decodeUnknownSync(TerminalCloseInput);

type TerminalSubprocessChecker = (
  terminalPid: number,
) => Promise<boolean | TerminalSubprocessActivity>;

function terminalErrorFromCause(fallbackMessage: string, cause: unknown): TerminalError {
  return new TerminalError({
    message: describeErrorMessage(cause, fallbackMessage),
    cause,
  });
}

function normalizeSubprocessActivity(
  result: boolean | TerminalSubprocessActivity,
): TerminalSubprocessActivity {
  return typeof result === "boolean"
    ? {
        cliKind: null,
        hasNonProviderSubprocess: result,
        hasProviderDescendant: false,
        hasRunningSubprocess: result,
      }
    : result;
}

function isProviderSessionBusy(session: TerminalSessionState, now: number): boolean {
  const lastInputAt = session.lastInputAt ?? 0;
  const lastOutputAt = session.lastOutputAt ?? 0;
  const latestSignalAt = Math.max(lastInputAt, lastOutputAt);
  if (latestSignalAt <= 0) {
    return false;
  }
  if (lastOutputAt >= lastInputAt) {
    return now - lastOutputAt <= PROVIDER_OUTPUT_ACTIVITY_GRACE_MS;
  }
  return now - lastInputAt <= PROVIDER_INPUT_ACTIVITY_GRACE_MS;
}

function normalizeProviderOutputSignature(visibleText: string): string {
  return visibleText
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_].*?(?:\u001b\\|\u0007|\u009c)/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-256);
}

const WINDOWS_DEFAULT_TERMINAL_SHELL = "powershell.exe";

type ShellResolutionOptions = {
  platform?: NodeJS.Platform;
  envShell?: string;
  envComSpec?: string;
};

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return WINDOWS_DEFAULT_TERMINAL_SHELL;
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform = process.platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-l", "-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  options: ShellResolutionOptions = {},
): ShellCandidate[] {
  const platform = options.platform ?? process.platform;
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(options.envComSpec ?? process.env.ComSpec ?? null, platform),
      shellCandidateFromCommand(WINDOWS_DEFAULT_TERMINAL_SHELL, platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(
      normalizeShellCommand(options.envShell ?? process.env.SHELL, platform),
      platform,
    ),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

export const __terminalManagerShellTesting = {
  resolveShellCandidates,
  windowsDefaultTerminalShell: WINDOWS_DEFAULT_TERMINAL_SHELL,
};

function isRetryableShellSpawnError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  // Persisted terminal history is replayed into a fresh xterm. Keep styling, but
  // strip cursor movement, erase, query/reply, and mode-control CSI sequences
  // that can move replayed prompt text off-screen or blank the pane.
  return finalByte !== "m";
}

function shouldStripOscSequence(content: string): boolean {
  return (
    /^(10|11|12);(?:\?|rgb:)/.test(content) || content.startsWith(SYNARA_TERMINAL_HOOK_OSC_PREFIX)
  );
}

function extractOscTitle(content: string): string | null {
  const match = content.match(/^(?:0|2);([\s\S]+)$/);
  return match?.[1]?.trim() || null;
}

function extractOscHookEvent(content: string): TerminalAgentHookEventType | null {
  if (!content.startsWith(SYNARA_TERMINAL_HOOK_OSC_PREFIX)) {
    return null;
  }
  const eventType = content.slice(SYNARA_TERMINAL_HOOK_OSC_PREFIX.length).trim();
  return eventType === "Start" || eventType === "Stop" || eventType === "PermissionRequest"
    ? eventType
    : null;
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

/**
 * Upper bound on how much is held back while waiting for a control-sequence terminator.
 *
 * String sequences (OSC/DCS/PM/APC) only end on BEL/ST, so a truncated program, a
 * crashed TUI, or `cat` on a binary can leave one open forever. Without a bound the
 * carryover buffer grows without limit, every flush rescans it from the start
 * (quadratic), and nothing ever reaches scrollback — the terminal silently freezes.
 * Real emulators abandon an over-long sequence and resume, so we do the same.
 *
 * The bound counts what `.length` counts — UTF-16 code units, not bytes — so an
 * all-ASCII payload is capped at exactly 64 KiB while a non-ASCII one can be a few
 * times that on the wire. That imprecision is deliberate: this is a runaway guard,
 * and it only has to sit far above legitimate traffic. It is generous for the same
 * reason, since inline-image protocols (sixel DCS, iTerm2 OSC 1337) do send large
 * payloads. Payloads above it are abandoned for scrollback only: live output is
 * streamed as raw PTY bytes and is never sanitized, so the visible terminal is
 * unaffected. Scrollback itself is capped at 1 MB, so a payload this large could not
 * survive there anyway.
 */
const MAX_PENDING_CONTROL_SEQUENCE_LENGTH = 65_536;

/** ESC + backslash: the 7-bit String Terminator that closes an OSC/DCS/PM/APC sequence. */
const STRING_TERMINATOR = "\u001b\\";

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): {
  visibleText: string;
  pendingControlSequence: string;
  titleSignals: string[];
  hookEvents: TerminalAgentHookEventType[];
} {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;
  const titleSignals: string[] = [];
  const hookEvents: TerminalAgentHookEventType[] = [];

  const append = (value: string) => {
    visibleText += value;
  };

  /**
   * Stop parsing at an incomplete control sequence and carry it into the next
   * chunk — unless the carryover exceeds the safety bound, in which case the
   * sequence is abandoned: the buffered bytes are emitted (terminated by ST so a
   * replayed transcript cannot wedge the client parser) and the parser resets.
   */
  const suspend = (start: number) => {
    const pending = input.slice(start);
    if (pending.length > MAX_PENDING_CONTROL_SEQUENCE_LENGTH) {
      return {
        visibleText: `${visibleText}${pending}${STRING_TERMINATOR}`,
        pendingControlSequence: "",
        titleSignals,
        hookEvents,
      };
    }
    return {
      visibleText,
      pendingControlSequence: pending,
      titleSignals,
      hookEvents,
    };
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return suspend(index);
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return suspend(index);
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return suspend(index);
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const hookEvent = extractOscHookEvent(content);
        if (hookEvent) {
          hookEvents.push(hookEvent);
        }
        if (nextCodePoint === 0x5d) {
          const titleSignal = extractOscTitle(content);
          if (titleSignal) {
            titleSignals.push(titleSignal);
          }
        }
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return suspend(index);
      }
      const sequence = input.slice(index, escapeSequenceEndIndex);
      if (sequence !== "\u001b7" && sequence !== "\u001b8") {
        append(sequence);
      }
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return suspend(index);
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return suspend(index);
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const hookEvent = extractOscHookEvent(content);
      if (hookEvent) {
        hookEvents.push(hookEvent);
      }
      if (codePoint === 0x9d) {
        const titleSignal = extractOscTitle(content);
        if (titleSignal) {
          titleSignals.push(titleSignal);
        }
      }
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "", titleSignals, hookEvents };
}

export const __terminalHistorySanitizeTesting = {
  sanitizeTerminalHistoryChunk,
  maxPendingControlSequenceLength: MAX_PENDING_CONTROL_SEQUENCE_LENGTH,
};

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("SYNARA_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
  managedWrapperOptions?: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  // Pin TERM/COLORTERM to the embedded renderer's capabilities (xterm.js
  // renders truecolor SGR); a caller-provided runtimeEnv may still override
  // them deliberately below.
  spawnEnv.TERM = TERMINAL_SPAWN_TERM;
  spawnEnv.COLORTERM = "truecolor";
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return managedWrapperOptions
    ? applyManagedTerminalAgentWrapperEnv(spawnEnv, managedWrapperOptions)
    : spawnEnv;
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

function cliKindFromRuntimeEnv(
  runtimeEnv: Record<string, string> | null | undefined,
): TerminalCliKind | null {
  return terminalCliKindFromValue(runtimeEnv?.[SYNARA_TERMINAL_CLI_KIND_ENV_KEY]);
}

function resetSessionHistory(session: TerminalSessionState): void {
  session.history.reset();
  session.pendingHistoryControlSequence = "";
  session.pendingInputBuffer = "";
  session.managedAgentRunning = false;
  session.managedAgentState = null;
  session.managedAgentObserved = false;
  session.providerDescendantObserved = false;
}

function deriveActivityAgentState(session: TerminalSessionState): TerminalActivityState | null {
  if (session.managedAgentState !== null) {
    return session.managedAgentState;
  }
  if (session.hasRunningSubprocess && session.detectedCliKind !== null) {
    return "running";
  }
  return null;
}

function agentStateFromHookEvent(eventType: TerminalAgentHookEventType): TerminalActivityState {
  switch (eventType) {
    case "PermissionRequest":
      return "attention";
    case "Stop":
      return "review";
    case "Start":
      return "running";
  }
}

function sanitizePersistedTerminalHistory(history: string): string {
  if (history.length === 0) return history;
  return sanitizeTerminalHistoryChunk("", history).visibleText;
}

interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  processSnapshotObserver?: ProcessChildrenSnapshotObserver;
  processTreeKiller?: ProcessTreeKiller;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

interface KillEscalationHandle {
  timer: ReturnType<typeof setTimeout>;
  unsubscribeExit: (() => void) | null;
  retainAfterRootExit: boolean;
  rootExited: boolean;
}

export class TerminalManagerRuntime extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly logsDir: string;
  private managedWrapperBinDir: string | null;
  private managedWrapperZshDir: string | null;
  private readonly historyLineLimit: number;
  private readonly historyByteLimit: number;
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Pending persist work keyed by session. Stores a materializer thunk rather
   * than a string so the O(maxBytes) history cap only runs when the debounced
   * write actually fires (≈4/s) — never on the per-flush hot path.
   */
  private readonly pendingPersistHistory = new Map<string, () => string>();
  private readonly persistedHistoryByKey = new Map<string, string>();
  private persistTempCounter = 0;
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly subprocessChecker: TerminalSubprocessChecker;
  private readonly processTreeKiller: ProcessTreeKiller;
  private readonly useDefaultSubprocessChecker: boolean;
  private readonly processSnapshotObserver: ProcessChildrenSnapshotObserver | null;
  private readonly subprocessPollIntervalMs: number;
  private readonly processKillGraceMs: number;
  private readonly maxRetainedInactiveSessions: number;
  private subprocessPollTimer: ReturnType<typeof setTimeout> | null = null;
  private subprocessPollInFlight = false;
  /** Delay of the currently scheduled poll, so activity can pull it forward. */
  private currentSubprocessPollDelayMs = 0;
  private readonly killEscalationTimers = new Map<PtyProcess, KillEscalationHandle>();
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.managedWrapperBinDir =
      process.platform === "win32"
        ? null
        : path.join(this.logsDir, MANAGED_TERMINAL_WRAPPER_DIRNAME);
    this.managedWrapperZshDir =
      process.platform === "win32" ? null : path.join(this.logsDir, MANAGED_TERMINAL_ZSH_DIRNAME);
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
    this.ptyAdapter = options.ptyAdapter;
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    this.subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    this.processTreeKiller = options.processTreeKiller ?? defaultProcessTreeKiller;
    // Only the built-in checker can share a single process snapshot across the
    // poll cycle; injected checkers (tests) keep the per-pid path.
    this.useDefaultSubprocessChecker = options.subprocessChecker === undefined;
    this.processSnapshotObserver =
      options.processSnapshotObserver ??
      (this.useDefaultSubprocessChecker && process.platform === "win32"
        ? createWindowsProcessSnapshotObserver()
        : null);
    this.subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
    ensurePrivateDirectorySync(this.logsDir);
    if (this.managedWrapperBinDir) {
      try {
        const preparedWrappers = prepareManagedTerminalAgentWrappers({
          baseEnv: process.env,
          targetDir: this.managedWrapperBinDir,
          zshDir:
            this.managedWrapperZshDir ?? path.join(this.logsDir, MANAGED_TERMINAL_ZSH_DIRNAME),
        });
        this.managedWrapperBinDir = preparedWrappers.binDir;
        this.managedWrapperZshDir = preparedWrappers.zshDir;
      } catch (error) {
        this.logger.warn("failed to prepare managed terminal wrappers", {
          binDir: this.managedWrapperBinDir,
          zshDir: this.managedWrapperZshDir,
          error: error instanceof Error ? error.message : String(error),
        });
        this.managedWrapperBinDir = null;
        this.managedWrapperZshDir = null;
      }
    }
  }

  private historyLimits(): HistoryLimits {
    return { maxLines: this.historyLineLimit, maxBytes: this.historyByteLimit };
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalOpenInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(input.threadId, input.terminalId);
        const history = await this.readHistory(input.threadId, input.terminalId);
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const openedAt = new Date().toISOString();
        const session: TerminalSessionState = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: TerminalHistoryBuffer.fromString(history, this.historyLimits()),
          pendingHistoryControlSequence: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: openedAt,
          lastOpenedAt: openedAt,
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          detectedCliKind: cliKindFromRuntimeEnv(normalizedRuntimeEnv(input.env)),
          providerDescendantObserved: false,
          managedAgentRunning: false,
          managedAgentState: null,
          managedAgentObserved: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          pendingInputBuffer: "",
          modeReplayTracker: null,
          pendingOutputChunks: [],
          pendingOutputLength: 0,
          outputFlushTimer: null,
          streamOutput: input.streamOutput ?? true,
          outputPaused: false,
          outputBufferPauseRequested: false,
          outputAckPauseRequested: false,
          outputAckObserved: false,
          outputUnackedBytes: 0,
          outputAckResumeTimer: null,
          lastInputAt: null,
          lastOutputAt: null,
          lastOutputSignature: null,
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
        await this.startSession(session, { ...input, cols, rows }, "started");
        return this.snapshot(session);
      }

      existing.lastOpenedAt = new Date().toISOString();
      // A re-open may flip headless mode (e.g. a viewer attaching later); honor it
      // when explicitly provided, otherwise keep the session's current mode.
      if (input.streamOutput !== undefined) {
        existing.streamOutput = input.streamOutput;
      }
      const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
      const currentRuntimeEnv = existing.runtimeEnv;
      const targetCols = input.cols ?? existing.cols;
      const targetRows = input.rows ?? existing.rows;
      const runtimeEnvChanged =
        JSON.stringify(currentRuntimeEnv) !== JSON.stringify(nextRuntimeEnv);

      if (existing.process) {
        // A renderer reattach/reconcile is not an explicit restart; keep the live
        // PTY's original cwd/env so UI drift cannot SIGTERM a running agent.
        if (existing.cwd !== input.cwd || runtimeEnvChanged) {
          this.logger.warn("ignoring terminal open cwd/env change for running session", {
            threadId: existing.threadId,
            terminalId: existing.terminalId,
            currentCwd: existing.cwd,
            requestedCwd: input.cwd,
            runtimeEnvChanged,
          });
        }
      } else if (existing.cwd !== input.cwd || runtimeEnvChanged) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.runtimeEnv = nextRuntimeEnv;
        resetSessionHistory(existing);
        await this.persistHistory(
          existing.threadId,
          existing.terminalId,
          existing.history.toString(),
        );
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.runtimeEnv = nextRuntimeEnv;
        resetSessionHistory(existing);
        await this.persistHistory(
          existing.threadId,
          existing.terminalId,
          existing.history.toString(),
        );
      } else if (runtimeEnvChanged) {
        existing.runtimeEnv = nextRuntimeEnv;
      }

      if (!existing.process) {
        await this.startSession(
          existing,
          { ...input, cols: targetCols, rows: targetRows },
          "started",
        );
        return this.snapshot(existing);
      }

      // Reattaching a renderer to a still-running session: discard the previous
      // client's ACK accounting and resume reads so a reconnect-while-paused can
      // never leave this terminal frozen.
      this.resetOutputAckTracking(existing);

      if (existing.cols !== targetCols || existing.rows !== targetRows) {
        existing.cols = targetCols;
        existing.rows = targetRows;
        existing.process.resize(targetCols, targetRows);
        existing.modeReplayTracker?.resize(targetCols, targetRows);
        existing.updatedAt = new Date().toISOString();
      }

      // Drain any batched-but-unparsed output so the reconnect snapshot carries
      // the latest history and an up-to-date mode-replay preamble.
      this.flushOutputBuffer(existing);
      return this.snapshot(existing);
    });
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = decodeTerminalWriteInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      if (session.status === "exited") {
        return;
      }
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    const nextIdentityState = consumeTerminalIdentityInput(session.pendingInputBuffer, input.data);
    session.pendingInputBuffer = nextIdentityState.buffer;
    if (
      nextIdentityState.identity &&
      nextIdentityState.identity.cliKind !== session.detectedCliKind
    ) {
      session.detectedCliKind = nextIdentityState.identity.cliKind;
      session.providerDescendantObserved = false;
      this.emitActivityEvent(session);
    }
    const submittedPrompt = input.data.includes("\r") || input.data.includes("\n");
    if (submittedPrompt && session.detectedCliKind !== null && !session.hasRunningSubprocess) {
      session.hasRunningSubprocess = true;
      this.emitActivityEvent(session);
    }
    session.lastInputAt = Date.now();
    // Typing may spawn a subprocess; restore fast subprocess polling promptly.
    this.bumpSubprocessPolling();
    session.process.write(input.data);
  }

  async ackOutput(raw: TerminalAckOutputInput): Promise<void> {
    const input = decodeTerminalAckOutputInput(raw);
    const session = this.sessions.get(toSessionKey(input.threadId, input.terminalId));
    if (!session) return;

    session.outputAckObserved = true;
    session.outputUnackedBytes = Math.max(0, session.outputUnackedBytes - input.bytes);
    if (session.outputUnackedBytes <= OUTPUT_ACK_LOW_WATERMARK) {
      session.outputAckPauseRequested = false;
    }
    // An ACK proves the renderer is alive: reset the resume watchdog window and
    // re-sync pause state (which re-arms the watchdog if reads stay paused).
    this.clearOutputAckResumeTimer(session);
    this.syncOutputReadPause(session);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = decodeTerminalResizeInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
    session.modeReplayTracker?.resize(input.cols, input.rows);
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = decodeTerminalClearInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId, input.terminalId);
      resetSessionHistory(session);
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, input.terminalId, session.history.toString());
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalRestartInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const openedAt = new Date().toISOString();
        session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: new TerminalHistoryBuffer(this.historyLimits()),
          pendingHistoryControlSequence: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: openedAt,
          lastOpenedAt: openedAt,
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          detectedCliKind: cliKindFromRuntimeEnv(normalizedRuntimeEnv(input.env)),
          providerDescendantObserved: false,
          managedAgentRunning: false,
          managedAgentState: null,
          managedAgentObserved: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          pendingInputBuffer: "",
          modeReplayTracker: null,
          pendingOutputChunks: [],
          pendingOutputLength: 0,
          outputFlushTimer: null,
          // Restart has no headless mode of its own; fresh sessions stream normally
          // and existing sessions (below) keep whatever mode they were opened with.
          streamOutput: true,
          outputPaused: false,
          outputBufferPauseRequested: false,
          outputAckPauseRequested: false,
          outputAckObserved: false,
          outputUnackedBytes: 0,
          outputAckResumeTimer: null,
          lastOutputSignature: null,
          lastInputAt: null,
          lastOutputAt: null,
        } satisfies TerminalSessionState;
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
      }

      if (!session) {
        throw new Error(
          `Terminal session was not initialized for thread: ${input.threadId}, terminal: ${input.terminalId}`,
        );
      }

      session.lastOpenedAt = new Date().toISOString();
      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      resetSessionHistory(session);
      await this.persistHistory(input.threadId, input.terminalId, session.history.toString());
      await this.startSession(session, { ...input, cols, rows }, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = decodeTerminalCloseInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        await this.closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
        return;
      }

      await this.closeThreadSessions(input.threadId, input.deleteHistory === true);
    });
  }

  async closeSessionsOpenedAtOrBefore(input: TerminalCloseOpenedAtOrBeforeInput): Promise<void> {
    const cutoff = Date.parse(input.openedAtOrBefore);
    if (!Number.isFinite(cutoff)) {
      throw new Error(`Invalid terminal archive fence timestamp: ${input.openedAtOrBefore}`);
    }
    await this.runWithThreadLock(input.threadId, () =>
      this.closeThreadSessions(
        input.threadId,
        false,
        (session) => Date.parse(session.lastOpenedAt) <= cutoff,
      ),
    );
  }

  private async closeThreadSessions(
    threadId: string,
    deleteHistory: boolean,
    shouldClose: (session: TerminalSessionState) => boolean = () => true,
  ): Promise<void> {
    const threadSessions = this.sessionsForThread(threadId).filter(shouldClose);
    for (const session of threadSessions) {
      this.stopProcess(session);
      this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
    }
    await Promise.all(
      threadSessions.map((session) => this.flushPersistQueue(session.threadId, session.terminalId)),
    );
    for (const session of threadSessions) {
      this.releasePersistedHistoryCache(session.threadId, session.terminalId);
    }

    if (deleteHistory) {
      await this.deleteAllHistoryForThread(threadId);
    }
    if (threadSessions.length > 0) {
      this.updateSubprocessPollingState();
    }
  }

  dispose(): void {
    this.disposeInternal({ keepEscalationTimers: false });
  }

  async disposeForShutdown(): Promise<void> {
    const pendingEscalations = this.disposeInternal({ keepEscalationTimers: true });
    if (pendingEscalations > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.processKillGraceMs + SHUTDOWN_ESCALATION_SETTLE_MS),
      );
    }
    this.clearAllKillEscalationTimers();
  }

  private disposeInternal(options: { keepEscalationTimers: boolean }): number {
    this.stopSubprocessPolling();
    this.processSnapshotObserver?.dispose();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      // Flush any remaining batched output before tearing down.
      this.flushOutputBuffer(session);
      this.stopProcess(session);
    }
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    if (!options.keepEscalationTimers) {
      this.clearAllKillEscalationTimers();
    }
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
    return this.killEscalationTimers.size;
  }

  private clearAllKillEscalationTimers(): void {
    for (const handle of this.killEscalationTimers.values()) {
      clearTimeout(handle.timer);
      handle.unsubscribeExit?.();
    }
    this.killEscalationTimers.clear();
  }

  private async startSession(
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ): Promise<void> {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.hasRunningSubprocess = false;
    session.detectedCliKind = cliKindFromRuntimeEnv(session.runtimeEnv);
    session.providerDescendantObserved = false;
    session.managedAgentRunning = false;
    session.managedAgentState = null;
    session.managedAgentObserved = false;
    session.pendingInputBuffer = "";
    this.resetOutputBackpressure(session);
    this.resetModeReplayTracker(session);
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    session.updatedAt = new Date().toISOString();

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const shellCandidates = resolveShellCandidates(this.shellResolver);
      const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv, {
        binDir: this.managedWrapperBinDir,
        zshDir: this.managedWrapperZshDir,
      });
      let lastSpawnError: unknown = null;

      const spawnWithCandidate = (candidate: ShellCandidate) =>
        Effect.runPromise(
          this.ptyAdapter.spawn({
            shell: candidate.shell,
            ...(candidate.args ? { args: candidate.args } : {}),
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            env: terminalEnv,
          }),
        );

      const trySpawn = async (
        candidates: ShellCandidate[],
        index = 0,
      ): Promise<{ process: PtyProcess; shellLabel: string } | null> => {
        if (index >= candidates.length) {
          return null;
        }
        const candidate = candidates[index];
        if (!candidate) {
          return null;
        }

        try {
          const process = await spawnWithCandidate(candidate);
          return { process, shellLabel: formatShellCandidate(candidate) };
        } catch (error) {
          lastSpawnError = error;
          if (!isRetryableShellSpawnError(error)) {
            throw error;
          }
          return trySpawn(candidates, index + 1);
        }
      };

      const spawnResult = await trySpawn(shellCandidates);
      if (spawnResult) {
        ptyProcess = spawnResult.process;
        startedShell = spawnResult.shellLabel;
      }

      if (!ptyProcess) {
        const detail = describeErrorMessage(lastSpawnError, "Terminal start failed");
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        throw new Error(`${detail}.${tried}`.trim());
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      this.ensureModeReplayTracker(session);
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.updateSubprocessPollingState();
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
      if (session.detectedCliKind) {
        this.emitActivityEvent(session);
      }
    } catch (error) {
      if (ptyProcess) {
        this.killProcessWithEscalation(ptyProcess, session.threadId, session.terminalId);
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.hasRunningSubprocess = false;
      session.detectedCliKind = null;
      session.providerDescendantObserved = false;
      session.managedAgentRunning = false;
      session.managedAgentState = null;
      session.managedAgentObserved = false;
      session.updatedAt = new Date().toISOString();
      this.evictInactiveSessionsIfNeeded();
      this.updateSubprocessPollingState();
      const message = describeErrorMessage(error, "Terminal start failed");
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    // Hot path: only buffer raw output here. All parsing (mode-replay feed,
    // history sanitize, CLI/hook detection, persistence) happens once per
    // coalesced batch in flushOutputBuffer, so its cost scales with batches
    // (~60/s) rather than with the number of raw PTY chunks.
    session.pendingOutputChunks.push(data);
    session.pendingOutputLength += Buffer.byteLength(data, "utf8");

    // Backpressure: pause PTY when the local server buffer grows too large.
    if (
      !session.outputBufferPauseRequested &&
      session.pendingOutputLength >= OUTPUT_BUFFER_HIGH_WATERMARK
    ) {
      session.outputBufferPauseRequested = true;
      this.syncOutputReadPause(session);
    }

    if (session.pendingOutputLength >= OUTPUT_BATCH_SIZE_LIMIT) {
      // Large burst — flush immediately to avoid excessive latency.
      this.flushOutputBuffer(session);
    } else if (session.outputFlushTimer === null) {
      session.outputFlushTimer = setTimeout(() => {
        this.flushOutputBuffer(session);
      }, OUTPUT_BATCH_INTERVAL_MS);
    }
  }

  /**
   * Parse a coalesced output batch: feed the mode-replay mirror, sanitize into
   * scrollback, detect CLI/hook activity, and schedule persistence. Operating on
   * the joined batch is equivalent to processing each raw chunk in order:
   * sanitize/replay thread their state across the pending-control carryover, and
   * history capping only ever trims from the front, so per-chunk and per-batch
   * processing yield identical observable state.
   */
  private processOutputBatch(session: TerminalSessionState, data: string): void {
    this.feedModeReplayTracker(session, data);
    const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
    session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
    const latestHookEvent = sanitized.hookEvents.at(-1) ?? null;
    if (latestHookEvent) {
      session.managedAgentObserved = true;
      const nextManagedAgentRunning = latestHookEvent !== "Stop";
      const nextManagedAgentState = agentStateFromHookEvent(latestHookEvent);
      const nextDetectedCliKind = latestHookEvent === "Stop" ? null : session.detectedCliKind;
      const nextProviderDescendantObserved =
        latestHookEvent === "Stop" ? false : session.providerDescendantObserved;
      if (
        session.managedAgentRunning !== nextManagedAgentRunning ||
        session.managedAgentState !== nextManagedAgentState ||
        session.detectedCliKind !== nextDetectedCliKind ||
        session.providerDescendantObserved !== nextProviderDescendantObserved
      ) {
        session.managedAgentRunning = nextManagedAgentRunning;
        session.managedAgentState = nextManagedAgentState;
        session.detectedCliKind = nextDetectedCliKind;
        session.providerDescendantObserved = nextProviderDescendantObserved;
        session.hasRunningSubprocess = nextManagedAgentRunning;
        this.emitActivityEvent(session);
      }
    }
    if (sanitized.visibleText.length > 0) {
      session.history.append(sanitized.visibleText);
      this.queuePersist(session);
      const normalizedSignature = normalizeProviderOutputSignature(sanitized.visibleText);
      if (normalizedSignature.length > 0 && normalizedSignature !== session.lastOutputSignature) {
        // Only refresh on genuinely new output. Repeated identical redraws (idle prompt
        // repaints) are ignored so they do not pin the provider in a "busy" state forever.
        // When hooks are active (managedAgentObserved), hooks are the source of truth anyway;
        // this heuristic only matters for unmanaged terminals.
        session.lastOutputAt = Date.now();
        session.lastOutputSignature = normalizedSignature;
        // Fresh output can mean a subprocess started; recover fast polling.
        this.bumpSubprocessPolling();
      }
    }
    session.updatedAt = new Date().toISOString();
  }

  private flushOutputBuffer(session: TerminalSessionState): void {
    if (session.outputFlushTimer !== null) {
      clearTimeout(session.outputFlushTimer);
      session.outputFlushTimer = null;
    }
    if (session.pendingOutputChunks.length === 0) return;

    const data = session.pendingOutputChunks.join("");
    const byteLength = session.pendingOutputLength;
    session.pendingOutputChunks = [];
    session.pendingOutputLength = 0;

    session.outputBufferPauseRequested = false;

    // Parse the batch (history/replay/detection) before emitting so a snapshot
    // taken right after a flush reflects this output.
    this.processOutputBatch(session, data);

    // Headless sessions (e.g. dev servers) still drain the PTY and maintain
    // history above, but skip the live broadcast so unviewed background output
    // never reaches the WebSocket fanout.
    if (session.streamOutput) {
      this.emitEvent({
        type: "output",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        data,
        byteLength,
      });
    }
    if (session.outputAckObserved) {
      session.outputUnackedBytes += byteLength;
      if (session.outputUnackedBytes >= OUTPUT_ACK_HIGH_WATERMARK) {
        session.outputAckPauseRequested = true;
      }
    }
    this.syncOutputReadPause(session);
  }

  private syncOutputReadPause(session: TerminalSessionState): void {
    const shouldPause = session.outputBufferPauseRequested || session.outputAckPauseRequested;
    if (shouldPause !== session.outputPaused) {
      if (shouldPause) {
        session.process?.pause();
        session.outputPaused = true;
      } else {
        session.process?.resume();
        session.outputPaused = false;
      }
    }
    this.syncOutputAckResumeWatchdog(session);
  }

  /**
   * ACK-backpressure can only be drained by renderer ACKs. If a renderer stalls or
   * disconnects while reads are paused, those ACKs never arrive and the PTY would
   * stay paused forever. Arm a watchdog whenever ACK-pause holds reads down so the
   * session always recovers; any ACK or state change resets it.
   */
  private syncOutputAckResumeWatchdog(session: TerminalSessionState): void {
    if (session.outputPaused && session.outputAckPauseRequested) {
      if (session.outputAckResumeTimer !== null) return;
      const timer = setTimeout(() => {
        session.outputAckResumeTimer = null;
        if (!session.outputAckPauseRequested) return;
        session.outputAckPauseRequested = false;
        session.outputUnackedBytes = 0;
        this.logger.warn("terminal output force-resumed by ack watchdog", {
          threadId: session.threadId,
          terminalId: session.terminalId,
        });
        this.syncOutputReadPause(session);
      }, OUTPUT_ACK_RESUME_TIMEOUT_MS);
      timer.unref?.();
      session.outputAckResumeTimer = timer;
    } else {
      this.clearOutputAckResumeTimer(session);
    }
  }

  private clearOutputAckResumeTimer(session: TerminalSessionState): void {
    if (session.outputAckResumeTimer !== null) {
      clearTimeout(session.outputAckResumeTimer);
      session.outputAckResumeTimer = null;
    }
  }

  /**
   * Drop the previous renderer's ACK accounting when a new renderer reattaches to a
   * still-running session. Without this, a reconnect that happened while reads were
   * ack-paused would strand outputUnackedBytes high and the PTY paused forever
   * (the fresh renderer never ACKs output it never received).
   */
  private resetOutputAckTracking(session: TerminalSessionState): void {
    session.outputAckObserved = false;
    session.outputUnackedBytes = 0;
    session.outputAckPauseRequested = false;
    this.clearOutputAckResumeTimer(session);
    this.syncOutputReadPause(session);
  }

  private resetOutputBackpressure(session: TerminalSessionState): void {
    session.pendingOutputChunks = [];
    session.pendingOutputLength = 0;
    session.outputBufferPauseRequested = false;
    session.outputAckPauseRequested = false;
    session.outputAckObserved = false;
    session.outputUnackedBytes = 0;
    this.clearOutputAckResumeTimer(session);
    if (session.outputPaused) {
      session.process?.resume();
    }
    session.outputPaused = false;
  }

  private ensureModeReplayTracker(session: TerminalSessionState): void {
    try {
      session.modeReplayTracker = createTerminalModeReplayTracker(session.cols, session.rows);
    } catch (error) {
      session.modeReplayTracker = null;
      this.logger.warn("terminal mode replay tracker unavailable", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resetModeReplayTracker(session: TerminalSessionState): void {
    session.modeReplayTracker?.dispose();
    session.modeReplayTracker = null;
  }

  private feedModeReplayTracker(session: TerminalSessionState, data: string): void {
    const tracker = session.modeReplayTracker;
    if (!tracker) return;
    try {
      tracker.feed(data);
    } catch (error) {
      this.logger.warn("terminal mode replay tracker feed failed", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.resetModeReplayTracker(session);
    }
  }

  private buildModeReplayPreamble(session: TerminalSessionState): string {
    if (session.status !== "running") return "";
    const tracker = session.modeReplayTracker;
    if (!tracker) return "";
    try {
      return tracker.buildPreamble();
    } catch (error) {
      this.logger.warn("terminal mode replay preamble failed", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.resetModeReplayTracker(session);
      return "";
    }
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    // Drain any remaining batched output before emitting the exit event.
    this.flushOutputBuffer(session);
    this.clearKillEscalationTimer(session.process, { force: false });
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.detectedCliKind = null;
    session.providerDescendantObserved = false;
    session.managedAgentRunning = false;
    session.managedAgentState = null;
    session.managedAgentObserved = false;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    this.resetOutputBackpressure(session);
    this.resetModeReplayTracker(session);
    session.status = "exited";
    session.pendingHistoryControlSequence = "";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private stopProcess(session: TerminalSessionState): void {
    // Drain any remaining batched output before killing.
    this.flushOutputBuffer(session);
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.detectedCliKind = null;
    session.providerDescendantObserved = false;
    session.managedAgentRunning = false;
    session.managedAgentState = null;
    session.managedAgentObserved = false;
    session.lastInputAt = null;
    session.lastOutputAt = null;
    session.lastOutputSignature = null;
    this.resetOutputBackpressure(session);
    this.resetModeReplayTracker(session);
    session.status = "exited";
    session.pendingHistoryControlSequence = "";
    session.updatedAt = new Date().toISOString();
    this.killProcessWithEscalation(process, session.threadId, session.terminalId);
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private clearKillEscalationTimer(
    process: PtyProcess | null,
    options: { force: boolean } = { force: true },
  ): void {
    if (!process) return;
    const handle = this.killEscalationTimers.get(process);
    if (!handle) return;
    if (!options.force && handle.retainAfterRootExit) return;
    clearTimeout(handle.timer);
    handle.unsubscribeExit?.();
    this.killEscalationTimers.delete(process);
  }

  private killProcessWithEscalation(
    ptyProcess: PtyProcess,
    threadId: string,
    terminalId: string,
  ): void {
    this.clearKillEscalationTimer(ptyProcess);
    const pid = ptyProcess.pid;
    const tree = this.processTreeKiller.capture(pid);
    const retainAfterRootExit = tree.descendants.length > 0;
    const signalProcess = (signal: TerminalKillSignal) => {
      try {
        ptyProcess.kill(signal);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno?.code === "ESRCH") {
          return;
        }
        this.logger.warn("process signal failed", {
          threadId,
          terminalId,
          pid,
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const signalTree = (
      signal: TerminalKillSignal,
      options: { includeRootTree?: boolean } = {},
    ) => {
      this.processTreeKiller.signal({
        rootPid: pid,
        signal,
        tree,
        includeRootTree: options.includeRootTree,
        onError: (error, context) => {
          this.logger.warn(
            context.source === "tree-kill"
              ? `tree-kill ${signal} failed`
              : `captured process ${signal} failed`,
            {
              threadId,
              terminalId,
              pid: context.pid,
              rootPid: pid,
              error: error.message,
            },
          );
        },
      });
    };

    signalTree("SIGTERM");
    // Also signal the PTY handle directly for adapter compatibility and test doubles.
    signalProcess("SIGTERM");

    const unsubscribeExit = ptyProcess.onExit(() => {
      const handle = this.killEscalationTimers.get(ptyProcess);
      if (handle?.retainAfterRootExit) {
        handle.rootExited = true;
      }
      this.clearKillEscalationTimer(ptyProcess, { force: false });
    });

    const timer = setTimeout(() => {
      const handle = this.killEscalationTimers.get(ptyProcess);
      if (handle) {
        handle.unsubscribeExit?.();
      }
      this.killEscalationTimers.delete(ptyProcess);
      const rootExited = handle?.rootExited === true;
      signalTree("SIGKILL", { includeRootTree: !rootExited });
      // Once the root exit is observed, only the captured descendants are safe to signal.
      if (!rootExited) {
        signalProcess("SIGKILL");
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(ptyProcess, {
      timer,
      unsubscribeExit,
      retainAfterRootExit,
      rootExited: false,
    });
  }

  private evictInactiveSessionsIfNeeded(): void {
    const inactiveSessions = [...this.sessions.values()].filter(
      (session) => session.status !== "running",
    );
    if (inactiveSessions.length <= this.maxRetainedInactiveSessions) {
      return;
    }

    inactiveSessions.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.threadId.localeCompare(right.threadId) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    const toEvict = inactiveSessions.length - this.maxRetainedInactiveSessions;
    for (const session of inactiveSessions.slice(0, toEvict)) {
      const key = toSessionKey(session.threadId, session.terminalId);
      this.flushOutputBuffer(session);
      this.sessions.delete(key);
      this.clearPersistTimer(session.threadId, session.terminalId);
      this.pendingPersistHistory.delete(key);
      // Release the cached history reference once the final write lands (the write
      // re-populates it on completion). The session is gone, so retaining it would
      // leak up to historyByteLimit per evicted key for the server's lifetime.
      void this.enqueuePersistWrite(
        session.threadId,
        session.terminalId,
        session.history.toString(),
      ).finally(() => {
        this.releasePersistedHistoryCache(session.threadId, session.terminalId);
      });
      this.clearKillEscalationTimer(session.process);
    }
  }

  /**
   * Mark a session's history dirty for a debounced persist. The history string is
   * materialized lazily (in the debounce timer / flush), so the hot output path
   * never pays the cap cost. The thunk reads `session.history` at write time so it
   * always persists the latest content, even after the session is removed.
   */
  private queuePersist(session: TerminalSessionState): void {
    const persistenceKey = toSessionKey(session.threadId, session.terminalId);
    this.pendingPersistHistory.set(persistenceKey, () => session.history.toString());
    this.schedulePersist(session.threadId, session.terminalId);
  }

  private async persistHistory(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      if (this.persistedHistoryByKey.get(persistenceKey) === history) {
        return;
      }
      // Atomic replace: write a temp file then rename, so a crash mid-write can
      // never leave a torn history file. History is byte-capped, so this writes
      // at most ~historyByteLimit bytes regardless of total output volume.
      const finalPath = this.historyPath(threadId, terminalId);
      const tempPath = `${finalPath}.tmp-${process.pid}-${(this.persistTempCounter += 1)}`;
      try {
        await fs.promises.writeFile(tempPath, history, {
          encoding: "utf8",
          mode: PRIVATE_FILE_MODE,
        });
        await fs.promises.rename(tempPath, finalPath);
        await repairPrivateFile(finalPath);
        this.persistedHistoryByKey.set(persistenceKey, history);
      } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const materialize = this.pendingPersistHistory.get(persistenceKey);
      if (materialize === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, materialize());
    }, this.persistDebounceMs);
    timer.unref?.();
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private async readHistory(threadId: string, terminalId: string): Promise<string> {
    const nextPath = this.historyPath(threadId, terminalId);
    const persistenceKey = toSessionKey(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      await repairPrivateFile(nextPath);
      const capped = capHistoryByLimits(sanitizePersistedTerminalHistory(raw), {
        maxLines: this.historyLineLimit,
        maxBytes: this.historyByteLimit,
      });
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, {
          encoding: "utf8",
          mode: PRIVATE_FILE_MODE,
        });
      }
      this.persistedHistoryByKey.set(persistenceKey, capped);
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistoryByLimits(sanitizePersistedTerminalHistory(raw), {
        maxLines: this.historyLineLimit,
        maxBytes: this.historyByteLimit,
      });

      // Migrate legacy transcript filename to the terminal-scoped path.
      await fs.promises.writeFile(nextPath, capped, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
      await repairPrivateFile(nextPath);
      this.persistedHistoryByKey.set(persistenceKey, capped);
      try {
        await fs.promises.rm(legacyPath, { force: true });
      } catch (cleanupError) {
        this.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.persistedHistoryByKey.set(persistenceKey, "");
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    this.persistedHistoryByKey.delete(toSessionKey(threadId, terminalId));
    const deletions = [fs.promises.rm(this.historyPath(threadId, terminalId), { force: true })];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const materialize = this.pendingPersistHistory.get(persistenceKey);
      if (materialize !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, materialize());
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private updateSubprocessPollingState(): void {
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) => session.status === "running" && session.pid !== null,
    );
    if (hasRunningSessions) {
      this.ensureSubprocessPolling();
      return;
    }
    this.stopSubprocessPolling();
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer || this.subprocessPollInFlight) return;
    // Kick an immediate poll, then self-schedule the next one adaptively.
    void this.runSubprocessPollCycle();
  }

  /**
   * Poll fast while any terminal is working (a live subprocess, or recent
   * input/output) and back off when all running sessions are idle. Hook-managed
   * and quiet shells then cost one `ps` sweep every few seconds instead of every
   * second.
   */
  private desiredSubprocessPollIntervalMs(now: number): number {
    const base = this.subprocessPollIntervalMs;
    for (const session of this.sessions.values()) {
      if (session.status !== "running" || session.pid === null) continue;
      if (session.hasRunningSubprocess || isProviderSessionBusy(session, now)) {
        return Math.max(base, this.processSnapshotObserver?.retryDelayMs() ?? 0);
      }
    }
    return Math.max(
      base * SUBPROCESS_IDLE_POLL_MULTIPLIER,
      this.processSnapshotObserver?.retryDelayMs() ?? 0,
    );
  }

  private async runSubprocessPollCycle(): Promise<void> {
    if (this.subprocessPollTimer) {
      clearTimeout(this.subprocessPollTimer);
      this.subprocessPollTimer = null;
    }
    await this.pollSubprocessActivity();
    this.scheduleNextSubprocessPoll();
  }

  private scheduleNextSubprocessPoll(): void {
    if (this.subprocessPollTimer) {
      clearTimeout(this.subprocessPollTimer);
      this.subprocessPollTimer = null;
    }
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) => session.status === "running" && session.pid !== null,
    );
    if (!hasRunningSessions) {
      this.currentSubprocessPollDelayMs = 0;
      return;
    }
    const delayMs = this.desiredSubprocessPollIntervalMs(Date.now());
    this.currentSubprocessPollDelayMs = delayMs;
    const timer = setTimeout(() => {
      void this.runSubprocessPollCycle();
    }, delayMs);
    timer.unref?.();
    this.subprocessPollTimer = timer;
  }

  /**
   * Pull the next subprocess poll forward to the base cadence when a backed-off
   * session sees fresh input/output, so activity detection stays responsive
   * after an idle period. No-op while already polling fast.
   */
  private bumpSubprocessPolling(): void {
    if (this.subprocessPollInFlight) return;
    if (!this.subprocessPollTimer) return;
    if (this.currentSubprocessPollDelayMs <= this.subprocessPollIntervalMs) return;
    this.scheduleNextSubprocessPoll();
  }

  private stopSubprocessPolling(): void {
    this.currentSubprocessPollDelayMs = 0;
    if (!this.subprocessPollTimer) return;
    clearTimeout(this.subprocessPollTimer);
    this.subprocessPollTimer = null;
  }

  private async pollSubprocessActivity(): Promise<void> {
    if (this.subprocessPollInFlight) return;

    const runningSessions = [...this.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );
    if (runningSessions.length === 0) {
      this.stopSubprocessPolling();
      return;
    }

    this.subprocessPollInFlight = true;
    // Capture the whole process tree once per cycle. POSIX uses one `ps`; Windows
    // uses one persistent observer process. Every running terminal is then
    // inspected synchronously against the same immutable snapshot.
    const sharedChildrenMap = this.processSnapshotObserver
      ? await this.processSnapshotObserver.capture()
      : this.useDefaultSubprocessChecker && process.platform !== "win32"
        ? await captureProcessChildrenMap()
        : null;
    const sharedSnapshotUnavailable =
      this.processSnapshotObserver !== null && sharedChildrenMap === null;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          // A failed Windows snapshot proves nothing. Preserve the last known
          // activity state while the observer backs off instead of reporting a
          // false idle transition or falling back to per-terminal processes.
          if (sharedSnapshotUnavailable) return;
          const terminalPid = session.pid;
          let hasRunningSubprocess = false;
          let shouldClearDetectedCliKind = false;
          try {
            const subprocessActivity =
              sharedChildrenMap !== null
                ? inspectSubprocessActivity(terminalPid, sharedChildrenMap)
                : normalizeSubprocessActivity(await this.subprocessChecker(terminalPid));
            const providerDescendantObserved =
              session.providerDescendantObserved ||
              (session.detectedCliKind !== null && subprocessActivity.hasProviderDescendant);
            // Process-tree provider matches affect busy-state only. Branding follows explicit
            // env/input/hook signals so dev servers that spawn agents stay generic.
            shouldClearDetectedCliKind =
              session.detectedCliKind !== null &&
              !subprocessActivity.hasProviderDescendant &&
              (providerDescendantObserved || !isProviderSessionBusy(session, Date.now()));
            session.providerDescendantObserved = providerDescendantObserved;
            if (session.managedAgentObserved) {
              // Hooks have fired — trust them as the sole source of truth (superset model).
              // Only override with non-provider subprocesses (e.g. user spawned a build).
              hasRunningSubprocess =
                session.managedAgentRunning || subprocessActivity.hasNonProviderSubprocess;
            } else {
              // No hooks observed — fall back to process-tree + output heuristic.
              hasRunningSubprocess = subprocessActivity.hasProviderDescendant
                ? subprocessActivity.hasNonProviderSubprocess ||
                  isProviderSessionBusy(session, Date.now())
                : subprocessActivity.hasRunningSubprocess;
            }
          } catch (error) {
            this.logger.warn("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const liveSession = this.sessions.get(toSessionKey(session.threadId, session.terminalId));
          if (!liveSession || liveSession.status !== "running" || liveSession.pid !== terminalPid) {
            return;
          }
          const nextDetectedCliKind =
            shouldClearDetectedCliKind && liveSession.detectedCliKind === session.detectedCliKind
              ? null
              : liveSession.detectedCliKind;
          const nextProviderDescendantObserved =
            nextDetectedCliKind === null ? false : session.providerDescendantObserved;
          if (
            liveSession.hasRunningSubprocess === hasRunningSubprocess &&
            liveSession.detectedCliKind === nextDetectedCliKind &&
            liveSession.providerDescendantObserved === nextProviderDescendantObserved
          ) {
            return;
          }

          liveSession.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.detectedCliKind = nextDetectedCliKind;
          liveSession.providerDescendantObserved = nextProviderDescendantObserved;
          liveSession.updatedAt = new Date().toISOString();
          this.emitActivityEvent(liveSession);
        }),
      );
    } finally {
      this.subprocessPollInFlight = false;
    }
  }

  private async assertValidCwd(cwd: string): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private async closeSession(
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const key = toSessionKey(threadId, terminalId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopProcess(session);
      this.sessions.delete(key);
    }
    this.updateSubprocessPollingState();
    await this.flushPersistQueue(threadId, terminalId);
    this.releasePersistedHistoryCache(threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(threadId, terminalId);
    }
  }

  /**
   * Drop the write-dedup entry for a session that is no longer resident.
   *
   * `persistedHistoryByKey` only exists to skip a redundant rewrite of identical
   * history, and the final persist re-populates it *after* the session was removed.
   * Without this release every closed-but-not-deleted session (archiving keeps its
   * history on disk) would pin up to `historyByteLimit` of scrollback in memory for
   * the lifetime of the process. Dropping the entry costs at most one redundant file
   * write later; `readHistory` re-populates it when the terminal is reopened.
   */
  private releasePersistedHistoryCache(threadId: string, terminalId: string): void {
    this.persistedHistoryByKey.delete(toSessionKey(threadId, terminalId));
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    for (const key of [...this.persistedHistoryByKey.keys()]) {
      if (key.startsWith(`${threadId}\u0000`)) {
        this.persistedHistoryByKey.delete(key);
      }
    }
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(threadId: string, terminalId: string): TerminalSessionState {
    const session = this.sessions.get(toSessionKey(threadId, terminalId));
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
    }
    return session;
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    const replayPreamble = this.buildModeReplayPreamble(session);
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history.toString(),
      ...(replayPreamble.length > 0 ? { replayPreamble } : {}),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitActivityEvent(session: TerminalSessionState): void {
    this.emitEvent({
      type: "activity",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      hasRunningSubprocess: session.hasRunningSubprocess,
      cliKind: session.detectedCliKind,
      agentState: deriveActivityAgentState(session),
    });
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}

export const TerminalManagerLive = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const { terminalLogsDir } = yield* ServerConfig;

    const ptyAdapter = yield* PtyAdapter;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new TerminalManagerRuntime({ logsDir: terminalLogsDir, ptyAdapter })),
      (r) => Effect.promise(() => r.disposeForShutdown()),
    );

    return {
      open: (input) =>
        Effect.tryPromise({
          try: () => runtime.open(input),
          catch: (cause) => terminalErrorFromCause("Failed to open terminal", cause),
        }),
      write: (input) =>
        Effect.tryPromise({
          try: () => runtime.write(input),
          catch: (cause) => terminalErrorFromCause("Failed to write to terminal", cause),
        }),
      ackOutput: (input) =>
        Effect.tryPromise({
          try: () => runtime.ackOutput(input),
          catch: (cause) => terminalErrorFromCause("Failed to acknowledge terminal output", cause),
        }),
      resize: (input) =>
        Effect.tryPromise({
          try: () => runtime.resize(input),
          catch: (cause) => terminalErrorFromCause("Failed to resize terminal", cause),
        }),
      clear: (input) =>
        Effect.tryPromise({
          try: () => runtime.clear(input),
          catch: (cause) => terminalErrorFromCause("Failed to clear terminal", cause),
        }),
      restart: (input) =>
        Effect.tryPromise({
          try: () => runtime.restart(input),
          catch: (cause) => terminalErrorFromCause("Failed to restart terminal", cause),
        }),
      close: (input) =>
        Effect.tryPromise({
          try: () => runtime.close(input),
          catch: (cause) => terminalErrorFromCause("Failed to close terminal", cause),
        }),
      closeSessionsOpenedAtOrBefore: (input) =>
        Effect.tryPromise({
          try: () => runtime.closeSessionsOpenedAtOrBefore(input),
          catch: (cause) =>
            terminalErrorFromCause("Failed to close archived thread terminals", cause),
        }),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      dispose: Effect.promise(() => runtime.disposeForShutdown()),
    } satisfies TerminalManagerShape;
  }),
);
