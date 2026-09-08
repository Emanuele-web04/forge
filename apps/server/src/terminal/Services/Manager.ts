/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@synara/contracts";
import type { TerminalActivityState, TerminalCliKind } from "@synara/shared/terminalThreads";
import { PtyProcess } from "./PTY";
import { Effect, Schema, ServiceMap } from "effect";
import type { TerminalModeReplayTracker } from "../terminalModeReplay";
import type { TerminalHistoryBuffer } from "../terminalHistory";

export class TerminalError extends Schema.TaggedErrorClass<TerminalError>()("TerminalError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  /** Append-optimized scrollback buffer (sanitized visible text, capped on read). */
  history: TerminalHistoryBuffer;
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  /** Last open/reattach time; used as an archive-cleanup generation fence. */
  lastOpenedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  detectedCliKind: TerminalCliKind | null;
  /** True once this branded session has actually shown a provider child process. */
  providerDescendantObserved: boolean;
  managedAgentRunning: boolean;
  managedAgentState: TerminalActivityState | null;
  /** True once at least one hook event (Start/Stop/PermissionRequest) has been observed. */
  managedAgentObserved: boolean;
  runtimeEnv: Record<string, string> | null;
  /** Buffered shell input used to detect canonical CLI commands at submit time. */
  pendingInputBuffer: string;
  /** Live terminal-mode mirror used to replay input modes after renderer reattach. */
  modeReplayTracker: TerminalModeReplayTracker | null;
  /** Buffered output chunks awaiting flush (output batching). */
  pendingOutputChunks: string[];
  /** Total UTF-8 byte length of buffered output chunks. */
  pendingOutputLength: number;
  /** Timer handle for the next scheduled output flush. */
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * When false, output is still drained and parsed into history but no live
   * `output` events are emitted. Set for headless sessions (e.g. dev servers)
   * whose output no renderer consumes, so their PTY traffic never reaches the
   * WebSocket fanout. Defaults to true for interactive terminals.
   */
  streamOutput: boolean;
  /** Whether PTY reading has been paused due to backpressure. */
  outputPaused: boolean;
  /** Local batching requested a PTY pause until the server flushes output. */
  outputBufferPauseRequested: boolean;
  /** Renderer parsing is behind; keep reads paused until parsed-output ACKs catch up. */
  outputAckPauseRequested: boolean;
  /** True once a renderer proves it supports parsed-output ACKs for this session. */
  outputAckObserved: boolean;
  /** Bytes emitted to ACK-capable renderers that xterm has not reported as parsed yet. */
  outputUnackedBytes: number;
  /**
   * Watchdog timer that force-resumes ACK-paused reads when a renderer stops
   * sending ACKs (crash/disconnect), so the terminal can never freeze permanently.
   */
  outputAckResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Latest wall-clock timestamp when the user wrote to this PTY. */
  lastInputAt: number | null;
  /** Latest wall-clock timestamp when the PTY emitted output. */
  lastOutputAt: number | null;
  /** Normalized visible output used to ignore redraw-only PTY noise. */
  lastOutputSignature: string | null;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalCloseOpenedAtOrBeforeInput {
  readonly threadId: string;
  readonly openedAtOrBefore: string;
}

/**
 * Lightweight read-only descriptor for a resident terminal session.
 * Powers the resource manager without exposing scrollback or PTY handles.
 */
export interface TerminalActiveSessionDescriptor {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly status: TerminalSessionStatus;
  readonly pid: number | null;
  readonly updatedAt: string;
}

/**
 * TerminalManagerShape - Service API for terminal session lifecycle operations.
 */
export interface TerminalManagerShape {
  /**
   * Open or attach to a terminal session.
   *
   * Reuses an existing session for the same thread/terminal id and restores
   * persisted history on first open.
   */
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

  /**
   * Acknowledge terminal output after the renderer's xterm parser consumes it.
   */
  readonly ackOutput: (input: TerminalAckOutputInput) => Effect.Effect<void, TerminalError>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /**
   * Close only sessions whose latest open/reattach predates an archive event.
   * The comparison and close run under the same per-thread terminal lock.
   */
  readonly closeSessionsOpenedAtOrBefore: (
    input: TerminalCloseOpenedAtOrBeforeInput,
  ) => Effect.Effect<void, TerminalError>;

  /**
   * List resident terminal sessions as lightweight descriptors.
   *
   * Read-only: snapshots pid/cwd/thread ownership for the resource manager.
   */
  readonly listActiveSessions: () => Effect.Effect<
    ReadonlyArray<TerminalActiveSessionDescriptor>,
    TerminalError
  >;

  /**
   * Subscribe to terminal runtime events.
   */
  readonly subscribe: (listener: (event: TerminalEvent) => void) => Effect.Effect<() => void>;

  /**
   * Dispose all managed terminal resources.
   */
  readonly dispose: Effect.Effect<void>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "synara/terminal/Services/Manager/TerminalManager",
) {}
