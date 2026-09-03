// FILE: AcpSessionRuntime.ts
// Purpose: Owns one authenticated ACP process, session setup, configuration, and event stream.
// Layer: Provider ACP runtime
// Exports: AcpSessionRuntime and its typed runtime factory contracts.

import { randomUUID } from "node:crypto";
import type * as Acp from "@agentclientprotocol/sdk";
import { resolveExecutionWorkingDirectory } from "@synara/shared/wslBridge";
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import * as AcpErrors from "./AcpErrors.ts";
import { makeAcpLoadReplayGate, type AcpLoadReplayGate } from "./AcpLoadReplayGate.ts";
import { loadAcpSdk, type AcpSdkModule } from "./AcpSdk.ts";
import { SetSessionConfigOptionResponse as SetSessionConfigOptionResponseCodec } from "./AcpExtensions.ts";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  teardownEffectProcessTree,
  teardownProviderProcessTree,
  type SupervisedProcessTeardownResult,
} from "../supervisedProcessTeardown.ts";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

const CONFIG_OPTION_UPDATE_TIMEOUT = "5 seconds";
const ACP_INCOMING_CHUNK_QUEUE_CAPACITY = 64;
const ACP_LOAD_REPLAY_QUIET_MS = 350;
const ACP_LOAD_REPLAY_HARD_TIMEOUT_MS = 30_000;
export const ACP_MAX_INCOMING_FRAME_BYTES = 8 * 1024 * 1024;

const ACP_MAX_PENDING_NOTIFICATIONS_TOTAL = 2_048;
const ACP_MAX_PENDING_NOTIFICATIONS_PER_SESSION = 512;
const ACP_MAX_PENDING_EVENTS = 2_048;

export type AcpSessionStartupStep =
  | "initialize"
  | "authenticate"
  | "session/new"
  | "session/load"
  | "session/resume"
  | "startup";

export interface AcpSessionStartupTimeouts {
  readonly initializeMs: number;
  readonly authenticateMs: number;
  readonly sessionSetupMs: number;
  /** Aggregate cap; deliberately lower than the sum of the per-step budgets. */
  readonly totalMs: number;
}

// Every startup step is bounded because an agent can block indefinitely without
// ever failing: `cursor-agent` authenticates through the macOS Keychain, whose
// `security` call legitimately takes >10s and hangs forever when a Keychain
// prompt cannot be displayed. Budgets are generous so slow-but-healthy
// handshakes still succeed; adapters override them via `startupTimeouts`.
export const DEFAULT_ACP_SESSION_STARTUP_TIMEOUTS: AcpSessionStartupTimeouts = {
  initializeMs: 20_000,
  authenticateMs: 30_000,
  sessionSetupMs: 20_000,
  totalMs: 60_000,
};

/** JSON-RPC implementation-defined server error; not produced by ACP agents. */
export const ACP_STARTUP_TIMEOUT_ERROR_CODE = -32001;

export interface AcpStartupTimeoutData {
  readonly reason: "acp-startup-timeout";
  readonly step: AcpSessionStartupStep;
  readonly timeoutMs: number;
}

export function acpStartupTimeoutError(
  step: AcpSessionStartupStep,
  timeoutMs: number,
): AcpErrors.AcpRequestError {
  const seconds = Math.round(timeoutMs / 1000);
  return new AcpErrors.AcpRequestError({
    code: ACP_STARTUP_TIMEOUT_ERROR_CODE,
    errorMessage:
      step === "startup"
        ? `ACP agent did not finish session startup within ${seconds}s.`
        : `ACP agent did not respond to ${step} within ${seconds}s.`,
    data: {
      reason: "acp-startup-timeout",
      step,
      timeoutMs,
    } satisfies AcpStartupTimeoutData,
  });
}

export function isAcpStartupTimeoutError(
  error: unknown,
): error is AcpErrors.AcpRequestError & { readonly data: AcpStartupTimeoutData } {
  return (
    Schema.is(AcpErrors.AcpRequestError)(error) &&
    error.code === ACP_STARTUP_TIMEOUT_ERROR_CODE &&
    typeof error.data === "object" &&
    error.data !== null &&
    (error.data as { reason?: unknown }).reason === "acp-startup-timeout"
  );
}

function messageLooksLikeAuthRequired(message: string): boolean {
  return /\b(?:unauthenticated|not authenticated|authentication required|authorization required|auth(?:orization|entication) (?:required|failed|expired|error)|login required|missing (?:auth(?:orization|entication)?|credentials|token|api[- ]?key)|invalid (?:credentials|token|api[- ]?key)|access denied|permission denied|token expired)\b/i.test(
    message,
  );
}

export function isAcpAuthRequiredError(error: AcpErrors.AcpError): boolean {
  if (error._tag !== "AcpRequestError") {
    return false;
  }
  const message = error.errorMessage ?? "";
  // Protocol-level auth-required uses -32000 in ACP. Require a
  // recognizable auth-failure phrase so a generic -32000 server error is not
  // misclassified as an auth challenge.
  return error.code === -32000 && messageLooksLikeAuthRequired(message);
}

export function causeIndicatesAuthRequired(cause: Cause.Cause<AcpErrors.AcpError>): boolean {
  const failReason = Cause.findFail(cause);
  return failReason._tag === "Success" && isAcpAuthRequiredError(failReason.success.error);
}

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded";
  readonly payload: unknown;
}

type AcpHandler<Request, Response> = (
  request: Request,
) => Effect.Effect<Response, AcpErrors.AcpError>;

type AcpHandlerRegistration<Handler> = (handler: Handler) => Effect.Effect<void>;

type ConfigOptionUpdateWaiter = {
  readonly configId: string;
  readonly value: string | boolean;
  readonly deferred: Deferred.Deferred<ReadonlyArray<Acp.SessionConfigOption>>;
};

type AcpIncomingFrame =
  | { readonly _tag: "chunk"; readonly chunk: Uint8Array }
  | { readonly _tag: "error"; readonly error: unknown }
  | { readonly _tag: "end" };

export function normalizeAcpIncomingJsonMessages(
  input: ReadableStream<Uint8Array>,
  normalize: (message: unknown) => unknown,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            controller.enqueue(encoder.encode("\n"));
            continue;
          }
          try {
            controller.enqueue(
              encoder.encode(`${JSON.stringify(normalize(JSON.parse(trimmed)))}\n`),
            );
          } catch {
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (!pending) return;
        const trimmed = pending.trim();
        try {
          controller.enqueue(encoder.encode(JSON.stringify(normalize(JSON.parse(trimmed)))));
        } catch {
          controller.enqueue(encoder.encode(pending));
        }
      },
    }),
  );
}

export type SessionEpoch = { generation: number; activeSessionId: Option.Option<string> };
const isActiveSessionId = (sessionId: string, epoch: SessionEpoch): boolean =>
  Option.isSome(epoch.activeSessionId) && epoch.activeSessionId.value === sessionId;

// True when the session is still the active epoch's session. Every state
// mutation path re-checks this before applying an update or offering an event,
// so a stale in-flight handler can never mutate state or enqueue events after
// the session has been replaced.
const isCurrentSessionEpoch = (
  getSessionEpoch: () => Effect.Effect<SessionEpoch>,
  sessionId: string,
  epoch: SessionEpoch,
): Effect.Effect<boolean> =>
  getSessionEpoch().pipe(
    Effect.map(
      (current) => current.generation === epoch.generation && isActiveSessionId(sessionId, current),
    ),
  );

export function makeAcpIncomingFrameGuard(
  maxFrameBytes = ACP_MAX_INCOMING_FRAME_BYTES,
): (chunk: Uint8Array) => AcpErrors.AcpTransportError | undefined {
  let pendingFrameBytes = 0;

  return (chunk) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? chunk.byteLength : newlineIndex;
      pendingFrameBytes += segmentEnd - offset;
      if (pendingFrameBytes > maxFrameBytes) {
        const cause = new Error(
          `ACP incoming frame exceeded the ${String(maxFrameBytes)}-byte limit`,
        );
        return new AcpErrors.AcpTransportError({
          detail: cause.message,
          cause,
        });
      }
      if (newlineIndex === -1) break;
      pendingFrameBytes = 0;
      offset = newlineIndex + 1;
    }
    return undefined;
  };
}

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * ACP agents launched inside WSL must receive a Linux cwd in protocol payloads,
 * even though the Windows parent identifies the same workspace by its WSL UNC path.
 */
export function resolveAcpSessionCwd(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveExecutionWorkingDirectory(cwd, platform);
}

export interface AcpFreshSessionRetryPolicy {
  readonly shouldRetry: (error: AcpErrors.AcpError) => boolean;
  readonly delayMs?: number;
}

/**
 * Retries one fresh `session/new` request when the provider reports a failure
 * that is known to occur before a session exists. Resume/load requests must not
 * use this path because repeating them can make delivery ambiguous.
 */
export function runAcpFreshSessionSetup<A>(
  setup: Effect.Effect<A, AcpErrors.AcpError>,
  retryPolicy: AcpFreshSessionRetryPolicy | undefined,
): Effect.Effect<A, AcpErrors.AcpError> {
  if (retryPolicy === undefined) {
    return setup;
  }
  return setup.pipe(
    Effect.catch((error) => {
      if (!retryPolicy.shouldRetry(error)) {
        return Effect.fail(error);
      }
      const delayMs = retryPolicy.delayMs ?? 0;
      return delayMs > 0 ? Effect.sleep(delayMs).pipe(Effect.andThen(setup)) : setup;
    }),
  );
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientCapabilities?: Acp.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  readonly resolveAuthMethodId?: (
    initializeResult: Acp.InitializeResponse,
  ) => Effect.Effect<string, AcpErrors.AcpError>;
  readonly validateInitializeResult?: (
    initializeResult: Acp.InitializeResponse,
  ) => Effect.Effect<void, AcpErrors.AcpError>;
  /**
   * Provider-specific metadata attached as `_meta` to session/new, session/load,
   * and session/resume requests. Grok registers client hooks through it.
   */
  readonly sessionMeta?: Record<string, unknown>;
  /**
   * Retries one fresh `session/new` when the failure matches the policy (e.g.
   * Grok's eventually-consistent session storage). Never applied to
   * resume/load, where repeating the request would make delivery ambiguous.
   */
  readonly freshSessionRetry?: AcpFreshSessionRetryPolicy;
  /**
   * Per-step startup budgets. Adapters with slow-but-healthy handshakes
   * (Keychain prompts, enterprise proxies) override individual entries; the
   * rest fall back to DEFAULT_ACP_SESSION_STARTUP_TIMEOUTS.
   */
  readonly startupTimeouts?: Partial<AcpSessionStartupTimeouts>;
  /**
   * When to send the ACP `authenticate` request during start.
   * - "always" (default): authenticate right after initialize, before session setup.
   * - "on-demand": attempt session setup without authenticate; if it fails with a
   *   verified auth-required error, resolve the advertised auth method,
   *   authenticate once, and retry the same setup operation once.
   */
  readonly authPolicy?: "always" | "on-demand";
  /**
   * Provider-specific predicate consulted during on-demand auth. After session
   * setup returns while still unauthenticated, if this returns true the session
   * is treated as an auth-required failure, discarded, authenticated once, and
   * retried. Generic ACP only retries on a verified auth-required transport or
   * request failure.
   */
  readonly authSetupHeuristic?: (
    initializeResult: Acp.InitializeResponse,
    setupResult: Acp.NewSessionResponse | Acp.LoadSessionResponse | Acp.ResumeSessionResponse,
  ) => boolean;
  /**
   * MCP servers to attach to the session. Invoked after `initialize` so the
   * builder can pick a transport based on the agent's advertised
   * `mcpCapabilities` (e.g. HTTP vs stdio for the Synara agent gateway).
   */
  readonly buildMcpServers?: (initializeResult: Acp.InitializeResponse) => Array<Acp.McpServer>;
  readonly authenticateMeta?: Record<string, unknown>;
  /** Test/provider policy overrides for session/load transcript replay suppression. */
  readonly loadReplayPolicy?: {
    readonly quietMs?: number;
    readonly hardTimeoutMs?: number;
  };
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly normalizeIncomingMessage?: (message: unknown) => unknown;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
  /** Test seam for the single shared ACP subprocess teardown owner. */
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  /**
   * Test seam signalled when setSessionEpoch has captured the pending buffer
   * but has not yet installed the new epoch (the transition window).
   */
  readonly __testTransitionReached?: Effect.Effect<void>;
  /** Test seam awaited inside the transition window before the epoch installs. */
  readonly __testTransitionPause?: Effect.Effect<void>;
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<AcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: Acp.InitializeResponse;
  readonly sessionSetupResult:
    | Acp.LoadSessionResponse
    | Acp.NewSessionResponse
    | Acp.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  /** `session/resume` does not replay transcript updates; `session/load` may. */
  readonly sessionSetupMethod: "new" | "load" | "resume";
}

export interface AcpSessionRuntimeShape {
  readonly handleRequestPermission: AcpHandlerRegistration<
    AcpHandler<Acp.RequestPermissionRequest, Acp.RequestPermissionResponse>
  >;
  readonly handleElicitation: AcpHandlerRegistration<
    AcpHandler<Acp.CreateElicitationRequest, Acp.CreateElicitationResponse>
  >;
  readonly handleReadTextFile: AcpHandlerRegistration<
    AcpHandler<Acp.ReadTextFileRequest, Acp.ReadTextFileResponse>
  >;
  readonly handleWriteTextFile: AcpHandlerRegistration<
    AcpHandler<Acp.WriteTextFileRequest, Acp.WriteTextFileResponse | void>
  >;
  readonly handleCreateTerminal: AcpHandlerRegistration<
    AcpHandler<Acp.CreateTerminalRequest, Acp.CreateTerminalResponse>
  >;
  readonly handleTerminalOutput: AcpHandlerRegistration<
    AcpHandler<Acp.TerminalOutputRequest, Acp.TerminalOutputResponse>
  >;
  readonly handleTerminalWaitForExit: AcpHandlerRegistration<
    AcpHandler<Acp.WaitForTerminalExitRequest, Acp.WaitForTerminalExitResponse>
  >;
  readonly handleTerminalKill: AcpHandlerRegistration<
    AcpHandler<Acp.KillTerminalRequest, Acp.KillTerminalResponse | void>
  >;
  readonly handleTerminalRelease: AcpHandlerRegistration<
    AcpHandler<Acp.ReleaseTerminalRequest, Acp.ReleaseTerminalResponse | void>
  >;
  readonly handleSessionUpdate: AcpHandlerRegistration<AcpHandler<Acp.SessionNotification, void>>;
  readonly handleElicitationComplete: AcpHandlerRegistration<
    AcpHandler<Acp.CompleteElicitationNotification, void>
  >;
  readonly handleExtRequest: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: AcpHandler<A, unknown>,
  ) => Effect.Effect<void>;
  readonly handleExtNotification: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: AcpHandler<A, void>,
  ) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, AcpErrors.AcpError>;
  /** Completes when the owned ACP process exits, regardless of its exit status. */
  readonly awaitExit: Effect.Effect<void>;
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  // Count of processed, in-flight, or deliverable parsed session/update
  // events. Adapters snapshot it and wait until their own processed count
  // catches up, so turn attribution stays open until every deliverable event
  // received during the turn has actually been handled — immune to stream
  // chunk buffering and in-flight handlers.
  readonly sessionUpdatesEnqueuedCount: Effect.Effect<number>;
  readonly supportsSessionFork: Effect.Effect<boolean, AcpErrors.AcpError>;
  /** Whether a persisted session id can be reopened through resume or load. */
  readonly supportsSessionRecovery: Effect.Effect<boolean, AcpErrors.AcpError>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined, AcpErrors.AcpError>;
  /** @internal Exposed for tests: the current session epoch. */
  readonly getSessionEpoch: () => Effect.Effect<SessionEpoch>;
  /** @internal Exposed for tests: total buffered pending session/update notifications. */
  readonly getPendingSessionNotificationCount: () => Effect.Effect<number>;
  readonly getConfigOptions: Effect.Effect<
    ReadonlyArray<Acp.SessionConfigOption>,
    AcpErrors.AcpError
  >;
  readonly getAvailableCommands: Effect.Effect<
    ReadonlyArray<Acp.AvailableCommand>,
    AcpErrors.AcpError
  >;
  /** Waits for session/load replay suppression to settle or reach its hard cap. */
  readonly awaitLoadReplayReady: Effect.Effect<void, AcpErrors.AcpError>;
  readonly prompt: (
    payload: Omit<Acp.PromptRequest, "sessionId">,
  ) => Effect.Effect<Acp.PromptResponse, AcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, AcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<Acp.SetSessionModeResponse, AcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<Acp.SetSessionConfigOptionResponse, AcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, AcpErrors.AcpError>;
  readonly forkSession: (
    payload: Omit<Acp.ForkSessionRequest, "sessionId">,
  ) => Effect.Effect<Acp.ForkSessionResponse, AcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, AcpErrors.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpErrors.AcpError>;
}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, AcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly completedEvent?: Extract<
    AcpParsedSessionEvent,
    { readonly _tag: "AssistantItemCompleted" }
  >;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

interface AcpOwnedChildProcess {
  readonly pid: number;
  readonly exitCode: Effect.Effect<unknown, unknown>;
}

export const awaitAcpChildExit = (child: AcpOwnedChildProcess): Effect.Effect<void> =>
  child.exitCode.pipe(Effect.exit, Effect.asVoid);

/**
 * Bridges Effect's child-process exit signal into Synara's process-tree proof. This is deliberately
 * a finalizer defect on failure: adapter scope cleanup may ignore typed failures, but it must never
 * publish a successful stop when the ACP process tree has not been proven gone.
 */
export const teardownAcpChildProcess = (
  child: AcpOwnedChildProcess,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
): Effect.Effect<SupervisedProcessTeardownResult> =>
  Effect.suspend(() => {
    return Effect.tryPromise({
      try: () => teardownEffectProcessTree(child, teardownProcessTree),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.orDie);
  });

function officialSdkError(acpSdk: AcpSdkModule, error: unknown): AcpErrors.AcpError {
  return error instanceof acpSdk.RequestError
    ? new AcpErrors.AcpRequestError({
        code: error.code,
        errorMessage: error.message,
        ...(error.data !== undefined ? { data: error.data } : {}),
      })
    : new AcpErrors.AcpTransportError({
        detail: error instanceof Error ? error.message : String(error),
        cause: error,
      });
}

const makeOfficialSdkClient = Effect.fnUntraced(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  runtimeScope: Scope.Scope,
  options: Pick<AcpSessionRuntimeOptions, "normalizeIncomingMessage" | "protocolLogging">,
) {
  // The ACP SDK is only needed once a provider process is actually spawned, so
  // it is imported here instead of at module scope (see AcpSdk.ts).
  const acpSdk = yield* Effect.promise(() => loadAcpSdk());
  type RequestPermissionHandler = Parameters<AcpSessionRuntimeShape["handleRequestPermission"]>[0];
  type ElicitationHandler = Parameters<AcpSessionRuntimeShape["handleElicitation"]>[0];
  type ReadTextFileHandler = Parameters<AcpSessionRuntimeShape["handleReadTextFile"]>[0];
  type WriteTextFileHandler = Parameters<AcpSessionRuntimeShape["handleWriteTextFile"]>[0];
  type CreateTerminalHandler = Parameters<AcpSessionRuntimeShape["handleCreateTerminal"]>[0];
  type TerminalOutputHandler = Parameters<AcpSessionRuntimeShape["handleTerminalOutput"]>[0];
  type TerminalWaitHandler = Parameters<AcpSessionRuntimeShape["handleTerminalWaitForExit"]>[0];
  type TerminalKillHandler = Parameters<AcpSessionRuntimeShape["handleTerminalKill"]>[0];
  type TerminalReleaseHandler = Parameters<AcpSessionRuntimeShape["handleTerminalRelease"]>[0];
  type SessionUpdateHandler = Parameters<AcpSessionRuntimeShape["handleSessionUpdate"]>[0];
  type ElicitationCompleteHandler = Parameters<
    AcpSessionRuntimeShape["handleElicitationComplete"]
  >[0];

  let requestPermission: RequestPermissionHandler | undefined;
  let elicitation: ElicitationHandler | undefined;
  let readTextFile: ReadTextFileHandler | undefined;
  let writeTextFile: WriteTextFileHandler | undefined;
  let createTerminal: CreateTerminalHandler | undefined;
  let terminalOutput: TerminalOutputHandler | undefined;
  let terminalWait: TerminalWaitHandler | undefined;
  let terminalKill: TerminalKillHandler | undefined;
  let terminalRelease: TerminalReleaseHandler | undefined;
  const sessionUpdateHandlers: SessionUpdateHandler[] = [];
  const elicitationCompleteHandlers: ElicitationCompleteHandler[] = [];
  const logProtocol = (
    direction: "incoming" | "outgoing",
    stage: "raw" | "decoded",
    payload: unknown,
  ) => {
    if (
      (direction === "incoming" && options.protocolLogging?.logIncoming !== true) ||
      (direction === "outgoing" && options.protocolLogging?.logOutgoing !== true)
    ) {
      return Effect.void;
    }
    const logger = options.protocolLogging?.logger;
    return logger?.({ direction, stage, payload }) ?? Effect.void;
  };
  let sessionUpdateTail = Promise.resolve();
  const dispatchSessionUpdate = (params: Acp.SessionNotification) => {
    const delivery = sessionUpdateTail.then(() =>
      Effect.runPromise(logProtocol("incoming", "decoded", params)).then(() =>
        Promise.all(sessionUpdateHandlers.map((handler) => runHandler(handler(params)))).then(
          () => undefined,
        ),
      ),
    );
    sessionUpdateTail = delivery.catch(() => undefined);
    return delivery;
  };
  const awaitSessionUpdateDrain = async () => {
    let observed: Promise<void>;
    do {
      observed = sessionUpdateTail;
      await observed;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } while (observed !== sessionUpdateTail);
  };

  const runHandler = <A>(effect: Effect.Effect<A, AcpErrors.AcpError>): Promise<A> =>
    Effect.runPromise(effect).catch((error) => {
      if (error instanceof AcpErrors.AcpRequestError) {
        throw new acpSdk.RequestError(error.code, error.errorMessage, error.data);
      }
      throw error;
    });
  const requireHandler = <A>(
    method: string,
    handler: ((payload: never) => Effect.Effect<A, AcpErrors.AcpError>) | undefined,
    payload: unknown,
  ) =>
    handler
      ? runHandler(handler(payload as never))
      : Promise.reject(acpSdk.RequestError.methodNotFound(method));

  const outgoing = yield* Queue.bounded<Uint8Array>(256);
  yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.forkIn(runtimeScope));
  const output = new WritableStream<Uint8Array>({
    write: (chunk) =>
      Effect.runPromise(
        logProtocol("outgoing", "raw", chunk).pipe(
          Effect.andThen(Queue.offer(outgoing, chunk)),
          Effect.asVoid,
        ),
      ),
  });
  const incoming = yield* Queue.bounded<AcpIncomingFrame>(ACP_INCOMING_CHUNK_QUEUE_CAPACITY);
  const guardIncomingFrame = makeAcpIncomingFrameGuard();
  const incomingFiber = yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        const frameError = guardIncomingFrame(chunk);
        if (frameError) return yield* frameError;
        yield* logProtocol("incoming", "raw", chunk);
        yield* Queue.offer(incoming, { _tag: "chunk", chunk });
      }),
    ),
    Effect.matchEffect({
      onFailure: (error) => Queue.offer(incoming, { _tag: "error", error }).pipe(Effect.asVoid),
      onSuccess: () => Queue.offer(incoming, { _tag: "end" }).pipe(Effect.asVoid),
    }),
    Effect.forkIn(runtimeScope),
  );
  yield* Scope.addFinalizer(runtimeScope, Queue.shutdown(incoming));
  const rawInput = new ReadableStream<Uint8Array>({
    pull(controller) {
      return Effect.runPromise(Queue.take(incoming)).then((frame) => {
        switch (frame._tag) {
          case "chunk":
            controller.enqueue(frame.chunk);
            return;
          case "error":
            controller.error(frame.error);
            return;
          case "end":
            controller.close();
        }
      });
    },
    cancel() {
      return Effect.runPromise(
        Fiber.interrupt(incomingFiber).pipe(
          Effect.andThen(Queue.shutdown(incoming)),
          Effect.asVoid,
        ),
      );
    },
  });

  const input = options.normalizeIncomingMessage
    ? normalizeAcpIncomingJsonMessages(rawInput, options.normalizeIncomingMessage)
    : rawInput;

  const clientApp = acpSdk
    .client({ name: "synara" })
    .onRequest(acpSdk.methods.client.session.requestPermission, ({ params }) =>
      requireHandler("session/request_permission", requestPermission, params),
    )
    .onRequest(acpSdk.methods.client.fs.readTextFile, ({ params }) =>
      requireHandler("fs/read_text_file", readTextFile, params),
    )
    .onRequest(acpSdk.methods.client.fs.writeTextFile, ({ params }) =>
      requireHandler("fs/write_text_file", writeTextFile, params),
    )
    .onRequest(acpSdk.methods.client.terminal.create, ({ params }) =>
      requireHandler("terminal/create", createTerminal, params),
    )
    .onRequest(acpSdk.methods.client.terminal.output, ({ params }) =>
      requireHandler("terminal/output", terminalOutput, params),
    )
    .onRequest(acpSdk.methods.client.terminal.waitForExit, ({ params }) =>
      requireHandler("terminal/wait_for_exit", terminalWait, params),
    )
    .onRequest(acpSdk.methods.client.terminal.kill, ({ params }) =>
      requireHandler("terminal/kill", terminalKill, params),
    )
    .onRequest(acpSdk.methods.client.terminal.release, ({ params }) =>
      requireHandler("terminal/release", terminalRelease, params),
    )
    .onRequest(acpSdk.methods.client.elicitation.create, async ({ params }) => {
      return requireHandler("elicitation/create", elicitation, params);
    })
    .onNotification(acpSdk.methods.client.session.update, ({ params }) =>
      dispatchSessionUpdate(params),
    )
    .onNotification(acpSdk.methods.client.elicitation.complete, ({ params }) =>
      Promise.all(elicitationCompleteHandlers.map((handler) => runHandler(handler(params)))).then(
        () => undefined,
      ),
    );
  let connection: Acp.ClientConnection | undefined;
  const getConnection = () =>
    (connection ??= clientApp.connect(acpSdk.ndJsonStream(output, input)));
  const fromPromise = <A>(
    thunk: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, AcpErrors.AcpError> =>
    Effect.tryPromise({ try: thunk, catch: (error) => officialSdkError(acpSdk, error) });
  const request = <Method extends Acp.AgentRequestMethod>(
    method: Method,
    payload: Acp.AgentRequestParamsByMethod[Method],
  ): Effect.Effect<Acp.AgentRequestResponsesByMethod[Method], AcpErrors.AcpError> =>
    logProtocol("outgoing", "decoded", { method, payload }).pipe(
      Effect.andThen(
        fromPromise((signal) =>
          getConnection().agent.request(method, payload, { cancellationSignal: signal }),
        ),
      ),
      Effect.tap((result) => logProtocol("incoming", "decoded", { method, result })),
    );
  const requestCustom = <A>(method: string, payload: unknown) =>
    logProtocol("outgoing", "decoded", { method, payload }).pipe(
      Effect.andThen(
        fromPromise((signal) =>
          getConnection().agent.request<A, unknown>(method, payload, {
            cancellationSignal: signal,
          }),
        ),
      ),
      Effect.tap((result) => logProtocol("incoming", "decoded", { method, result })),
    );
  const notifyStandard = <Method extends Acp.AgentNotificationMethod>(
    method: Method,
    payload: Acp.AgentNotificationParamsByMethod[Method],
  ) =>
    logProtocol("outgoing", "decoded", { method, payload }).pipe(
      Effect.andThen(fromPromise(() => getConnection().agent.notify(method, payload))),
    );
  const notifyCustom = (method: string, payload: unknown) =>
    logProtocol("outgoing", "decoded", { method, payload }).pipe(
      Effect.andThen(fromPromise(() => getConnection().agent.notify(method, payload))),
    );
  const register = (set: () => void) => Effect.sync(set);
  const client = {
    raw: {
      notifications: Stream.empty,
      request: requestCustom,
      notify: notifyCustom,
    },
    agent: {
      initialize: (payload: Acp.InitializeRequest) =>
        request(acpSdk.methods.agent.initialize, payload),
      authenticate: (payload: Acp.AuthenticateRequest) =>
        request(acpSdk.methods.agent.authenticate, payload),
      logout: (payload: Acp.LogoutRequest) => request(acpSdk.methods.agent.logout, payload),
      createSession: (payload: Acp.NewSessionRequest) =>
        request(acpSdk.methods.agent.session.new, payload).pipe(
          Effect.tap(() => fromPromise(awaitSessionUpdateDrain)),
        ),
      loadSession: (payload: Acp.LoadSessionRequest) =>
        request(acpSdk.methods.agent.session.load, payload).pipe(
          Effect.map((response) => response ?? {}),
          Effect.tap(() => fromPromise(awaitSessionUpdateDrain)),
        ),
      listSessions: (payload: Acp.ListSessionsRequest) =>
        request(acpSdk.methods.agent.session.list, payload),
      forkSession: (payload: Acp.ForkSessionRequest) =>
        request(acpSdk.methods.agent.session.fork, payload),
      resumeSession: (payload: Acp.ResumeSessionRequest) =>
        request(acpSdk.methods.agent.session.resume, payload).pipe(
          Effect.tap(() => fromPromise(awaitSessionUpdateDrain)),
        ),
      closeSession: (payload: Acp.CloseSessionRequest) =>
        request(acpSdk.methods.agent.session.close, payload).pipe(
          Effect.map((response) => response ?? {}),
        ),
      setSessionConfigOption: (payload: Acp.SetSessionConfigOptionRequest) =>
        request(acpSdk.methods.agent.session.setConfigOption, payload),
      prompt: (payload: Acp.PromptRequest) =>
        request(acpSdk.methods.agent.session.prompt, payload).pipe(
          Effect.tap(() => fromPromise(awaitSessionUpdateDrain)),
        ),
      cancel: (payload: Acp.CancelNotification) =>
        notifyStandard(acpSdk.methods.agent.session.cancel, payload),
    },
    handleRequestPermission: (handler: RequestPermissionHandler) =>
      register(() => void (requestPermission = handler)),
    handleElicitation: (handler: ElicitationHandler) =>
      register(() => void (elicitation = handler)),
    handleReadTextFile: (handler: ReadTextFileHandler) =>
      register(() => void (readTextFile = handler)),
    handleWriteTextFile: (handler: WriteTextFileHandler) =>
      register(() => void (writeTextFile = handler)),
    handleCreateTerminal: (handler: CreateTerminalHandler) =>
      register(() => void (createTerminal = handler)),
    handleTerminalOutput: (handler: TerminalOutputHandler) =>
      register(() => void (terminalOutput = handler)),
    handleTerminalWaitForExit: (handler: TerminalWaitHandler) =>
      register(() => void (terminalWait = handler)),
    handleTerminalKill: (handler: TerminalKillHandler) =>
      register(() => void (terminalKill = handler)),
    handleTerminalRelease: (handler: TerminalReleaseHandler) =>
      register(() => void (terminalRelease = handler)),
    handleSessionUpdate: (handler: SessionUpdateHandler) =>
      register(() => void sessionUpdateHandlers.push(handler)),
    handleElicitationComplete: (handler: ElicitationCompleteHandler) =>
      register(() => void elicitationCompleteHandlers.push(handler)),
    handleExtRequest: <A, I>(
      method: string,
      codec: Schema.Codec<A, I>,
      handler: AcpHandler<A, unknown>,
    ) =>
      register(() => {
        clientApp.onRequest(
          method,
          (payload) => Schema.decodeUnknownSync(codec)(payload),
          ({ params }) => runHandler(handler(params)),
        );
      }),
    handleExtNotification: <A, I>(
      method: string,
      codec: Schema.Codec<A, I>,
      handler: AcpHandler<A, void>,
    ) =>
      register(() => {
        clientApp.onNotification(
          method,
          (payload) => Schema.decodeUnknownSync(codec)(payload),
          ({ params }) => runHandler(handler(params)),
        );
      }),
  };
  return client;
});

export class AcpSessionRuntime extends ServiceMap.Service<
  AcpSessionRuntime,
  AcpSessionRuntimeShape
>()("synara/provider/acp/AcpSessionRuntime") {
  static layer(
    options: AcpSessionRuntimeOptions,
  ): Layer.Layer<AcpSessionRuntime, AcpErrors.AcpError, ChildProcessSpawner.ChildProcessSpawner> {
    return Layer.effect(AcpSessionRuntime, makeAcpSessionRuntime(options));
  }
}

type StartupInteraction<Req, Res> = {
  readonly dispatch: (req: Req) => Effect.Effect<Res, AcpErrors.AcpError>;
  readonly register: (
    handler: (req: Req) => Effect.Effect<Res, AcpErrors.AcpError>,
  ) => Effect.Effect<void>;
  readonly begin: () => Effect.Effect<void>;
  readonly complete: () => Effect.Effect<void>;
  readonly cancel: () => Effect.Effect<void>;
};

const ACP_MAX_STARTUP_INTERACTIONS = 256;

/** @internal Exported only for unit testing the startup interaction registry. */
export function makeStartupInteractionRegistry<Req, Res>(
  defaultResponse: Res,
): Effect.Effect<StartupInteraction<Req, Res>, never, never> {
  return Effect.gen(function* () {
    type Handler = (req: Req) => Effect.Effect<Res, AcpErrors.AcpError>;
    interface PendingItem {
      readonly req: Req;
      readonly deferred: Deferred.Deferred<Res, AcpErrors.AcpError>;
      readonly generation: number;
    }
    // Single atomic state machine (mirrors the pending-session state machine used
    // by setSessionEpoch): every transition is one Ref.modify so a dispatch can
    // never observe a partially applied begin/complete/register and end up
    // stranded in the buffer or delivered twice.
    interface RegistryState {
      readonly generation: number;
      readonly started: boolean;
      readonly handler: Option.Option<Handler>;
      readonly pending: ReadonlyArray<PendingItem>;
    }
    const stateRef = yield* Ref.make<RegistryState>({
      generation: 0,
      started: false,
      handler: Option.none(),
      pending: [],
    });

    const cancelItems = (items: ReadonlyArray<PendingItem>) =>
      Effect.forEach(
        items,
        (item) => Deferred.complete(item.deferred, Effect.succeed(defaultResponse)),
        { discard: true },
      );

    // Items from a stale generation are answered with the safe default instead of
    // being replayed to the next session's handler.
    const deliverItems = (
      items: ReadonlyArray<PendingItem>,
      handler: Handler,
      generation: number,
    ) =>
      Effect.forEach(
        items,
        (item) =>
          Deferred.complete(
            item.deferred,
            item.generation === generation ? handler(item.req) : Effect.succeed(defaultResponse),
          ),
        { discard: true },
      );

    type DispatchDecision =
      | { readonly _tag: "deliver"; readonly handler: Handler }
      | { readonly _tag: "overflow" }
      | { readonly _tag: "buffered" };

    const dispatch = (req: Req) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Res, AcpErrors.AcpError>();
        const decision = yield* Ref.modify(stateRef, (state): [DispatchDecision, RegistryState] => {
          if (state.started && Option.isSome(state.handler)) {
            return [{ _tag: "deliver", handler: state.handler.value }, state];
          }
          if (state.pending.length >= ACP_MAX_STARTUP_INTERACTIONS) {
            return [{ _tag: "overflow" }, state];
          }
          return [
            { _tag: "buffered" },
            {
              ...state,
              pending: state.pending.concat({ req, deferred, generation: state.generation }),
            },
          ];
        });
        switch (decision._tag) {
          case "deliver":
            return yield* decision.handler(req);
          case "overflow":
            return yield* new AcpErrors.AcpRequestError({
              code: -32000,
              errorMessage: "Startup interaction buffer overflow",
            });
          case "buffered":
            return yield* Deferred.await(deferred);
        }
      });

    const register = (handler: Handler) =>
      Ref.modify(
        stateRef,
        (
          state,
        ): [
          { readonly items: ReadonlyArray<PendingItem>; readonly generation: number },
          RegistryState,
        ] => {
          if (!state.started) {
            return [
              { items: [], generation: state.generation },
              { ...state, handler: Option.some(handler) },
            ];
          }
          return [
            { items: state.pending, generation: state.generation },
            { ...state, handler: Option.some(handler), pending: [] },
          ];
        },
      ).pipe(Effect.flatMap(({ items, generation }) => deliverItems(items, handler, generation)));

    const begin = Ref.modify(stateRef, (state): [ReadonlyArray<PendingItem>, RegistryState] => [
      state.pending,
      {
        generation: state.generation + 1,
        started: false,
        handler: state.handler,
        pending: [],
      },
    ]).pipe(Effect.flatMap(cancelItems));

    type CompleteDecision =
      | {
          readonly _tag: "flush";
          readonly handler: Handler;
          readonly items: ReadonlyArray<PendingItem>;
          readonly generation: number;
        }
      | { readonly _tag: "hold" };

    const complete = Ref.modify(stateRef, (state): [CompleteDecision, RegistryState] => {
      if (Option.isNone(state.handler)) {
        // No handler yet: keep buffering; register will flush once it arrives.
        return [{ _tag: "hold" }, { ...state, started: true }];
      }
      return [
        {
          _tag: "flush",
          handler: state.handler.value,
          items: state.pending,
          generation: state.generation,
        },
        { ...state, started: true, pending: [] },
      ];
    }).pipe(
      Effect.flatMap((decision) =>
        decision._tag === "flush"
          ? deliverItems(decision.items, decision.handler, decision.generation)
          : Effect.void,
      ),
    );

    const cancel = Ref.modify(stateRef, (state): [ReadonlyArray<PendingItem>, RegistryState] => [
      state.pending,
      { ...state, pending: [] },
    ]).pipe(Effect.flatMap(cancelItems));

    return {
      dispatch,
      register,
      begin: () => begin,
      complete: () => complete,
      cancel: () => cancel,
    };
  });
}

const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  AcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const testTransitionReached = options.__testTransitionReached;
    const testTransitionPause = options.__testTransitionPause;
    const eventQueue = yield* Queue.bounded<AcpParsedSessionEvent>(2_048);
    const sessionEpochRef = yield* Ref.make<{
      generation: number;
      activeSessionId: Option.Option<string>;
    }>({ generation: 0, activeSessionId: Option.none() });
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const availableCommandsRef = yield* Ref.make<ReadonlyArray<Acp.AvailableCommand>>([]);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    // Unique per runtime instance so assistant message ids never collide across
    // server restarts or session resumes (segment index resets to 0 each time).
    const runtimeInstanceId = randomUUID().slice(0, 8);
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const configOptionUpdateWaitersRef = yield* Ref.make<ReadonlyArray<ConfigOptionUpdateWaiter>>(
      [],
    );
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });

    // Single bounded pending-session state machine keyed by (provisional) session
    // id. All session/update notifications that arrive before the final epoch is
    // installed are held here, bounded by total count and per-session count.
    interface PendingSessionState {
      readonly notifications: ReadonlyArray<Acp.SessionNotification>;
    }
    const pendingSessionStateRef = yield* Ref.make<Map<string, PendingSessionState>>(new Map());
    const pendingEventsRef = yield* Ref.make<ReadonlyArray<AcpParsedSessionEvent>>([]);
    const acceptingSessionUpdatesRef = yield* Ref.make(false);
    const consumerAttachedRef = yield* Ref.make(false);

    // Provisional startup registry for approval/elicitation interactions. They are
    // buffered until the runtime reports startup complete, then promoted to the
    // registered handlers. On startup failure, session replacement, or stale generation
    // they are cancelled with safe defaults.
    const requestPermissionStartup = yield* makeStartupInteractionRegistry<
      Acp.RequestPermissionRequest,
      Acp.RequestPermissionResponse
    >({ outcome: { outcome: "cancelled" } });
    const elicitationStartup = yield* makeStartupInteractionRegistry<
      Acp.CreateElicitationRequest,
      Acp.CreateElicitationResponse
    >({ action: "decline" });

    let loadReplayGate: AcpLoadReplayGate | undefined;
    const awaitLoadReplayReady = Effect.suspend(() => {
      const gate = loadReplayGate;
      if (gate === undefined) {
        return Effect.void;
      }
      return gate.attachConsumer.pipe(
        Effect.andThen(gate.awaitReady),
        Effect.flatMap((outcome) =>
          outcome === "ready"
            ? Effect.void
            : Effect.fail(
                new AcpErrors.AcpRequestError({
                  code: -32603,
                  errorMessage: "ACP runtime closed while waiting for session/load replay.",
                }),
              ),
        ),
      );
    });
    const getModeState = awaitLoadReplayReady.pipe(Effect.andThen(Ref.get(modeStateRef)));
    const getConfigOptions = awaitLoadReplayReady.pipe(Effect.andThen(Ref.get(configOptionsRef)));
    const getAvailableCommands = awaitLoadReplayReady.pipe(
      Effect.andThen(Ref.get(availableCommandsRef)),
    );
    // Counts processed, in-flight, or deliverable events after cleanup drops.
    // Plain mutable adjustments are fenced while session event offers are in
    // flight; see sessionUpdatesEnqueuedCount on the shape.
    let sessionUpdatesEnqueued = 0;
    let sessionEventOffersInFlight = 0;

    const appendPendingNotification = (
      map: Map<string, PendingSessionState>,
      sessionId: string,
      notification: Acp.SessionNotification,
    ): Map<string, PendingSessionState> => {
      const state = map.get(sessionId) ?? { notifications: [] };
      let notifications = state.notifications.concat(notification);
      if (notifications.length > ACP_MAX_PENDING_NOTIFICATIONS_PER_SESSION) {
        notifications = notifications.slice(
          notifications.length - ACP_MAX_PENDING_NOTIFICATIONS_PER_SESSION,
        );
      }
      const next = new Map(map);
      next.set(sessionId, { notifications });
      let total = 0;
      for (const s of next.values()) {
        total += s.notifications.length;
      }
      while (total > ACP_MAX_PENDING_NOTIFICATIONS_TOTAL) {
        let removed = false;
        for (const [key, s] of next) {
          if (s.notifications.length > 0) {
            const trimmed = s.notifications.slice(1);
            if (trimmed.length === 0) {
              next.delete(key);
            } else {
              next.set(key, { notifications: trimmed });
            }
            total -= 1;
            removed = true;
            break;
          }
        }
        if (!removed) break;
      }
      return next;
    };

    const getSessionEpoch = (): Effect.Effect<SessionEpoch> => Ref.get(sessionEpochRef);

    const clearSessionEpoch = (): Effect.Effect<number> =>
      Effect.gen(function* () {
        yield* Ref.update(sessionEpochRef, (epoch) => ({
          generation: epoch.generation + 1,
          activeSessionId: Option.none(),
        }));
        yield* Ref.set(pendingSessionStateRef, new Map());
        const pendingEvents = yield* Ref.getAndSet(pendingEventsRef, []);
        yield* Ref.set(acceptingSessionUpdatesRef, false);
        return pendingEvents.length;
      });

    const setSessionEpoch = (
      sessionId: string,
      sessionSetupResult:
        | Acp.LoadSessionResponse
        | Acp.NewSessionResponse
        | Acp.ResumeSessionResponse,
      options: {
        readonly replay?: "all" | "bounded-only";
        readonly resetState?: boolean;
      } = {},
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const replay = options.replay ?? "all";
        const resetState = options.resetState ?? false;

        // Atomically capture and clear pending state for the new session. Notifications
        // belonging to other (e.g. discarded probe) sessions are discarded.
        const pending = yield* Ref.getAndSet(pendingSessionStateRef, new Map());
        const sessionPending = pending.get(sessionId) ?? { notifications: [] };

        if (testTransitionReached) {
          yield* testTransitionReached;
        }
        if (testTransitionPause) {
          yield* testTransitionPause;
        }

        // Install the setup baseline first so early mode/config updates are replayed
        // on top of the authoritative response, not overwritten by it.
        yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
        const currentConfigOptions = yield* Ref.get(configOptionsRef);
        yield* Ref.set(
          configOptionsRef,
          sessionConfigOptionsFromSetup(sessionSetupResult, currentConfigOptions),
        );
        yield* Ref.set(availableCommandsRef, []);

        if (resetState) {
          yield* Ref.set(toolCallsRef, new Map());
          yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });
        }

        yield* Ref.update(sessionEpochRef, (epoch) => ({
          generation: epoch.generation + 1,
          activeSessionId: Option.some(sessionId),
        }));
        yield* Ref.set(acceptingSessionUpdatesRef, true);

        const epoch = yield* getSessionEpoch();
        const offer = offerSessionEvent(sessionId, epoch);
        const apply = (notification: Acp.SessionNotification) =>
          processSessionUpdate({
            getSessionEpoch,
            offer,
            sessionId,
            epoch,
            availableCommandsRef,
            configOptionsRef,
            modeStateRef,
            toolCallsRef,
            assistantSegmentRef,
            runtimeInstanceId,
            resolveConfigOptionUpdateWaiters,
            skipTranscriptEvents: replay === "bounded-only",
            params: notification,
          });
        for (const notification of sessionPending.notifications) {
          yield* apply(notification);
        }

        // Notifications can race into the pending buffer between the capture
        // above and the epoch install. Drain the buffer until it is empty so
        // every update that arrived during the transition window is applied
        // exactly once and no pending state is left behind.
        while (true) {
          const raced = yield* Ref.getAndSet(pendingSessionStateRef, new Map());
          const racedPending = raced.get(sessionId);
          if (!racedPending || racedPending.notifications.length === 0) break;
          for (const notification of racedPending.notifications) {
            yield* apply(notification);
          }
        }
      });

    const offerSessionEvent =
      (sessionId: string, epoch: SessionEpoch) =>
      (event: AcpParsedSessionEvent): Effect.Effect<void> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            sessionEventOffersInFlight += 1;
            if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
            const consumerAttached = yield* Ref.get(consumerAttachedRef);
            if (consumerAttached) {
              const offered = yield* restore(Queue.offer(eventQueue, event));
              if (offered) {
                sessionUpdatesEnqueued += 1;
              }
            } else {
              const retainedCountIncreased = yield* Ref.modify(pendingEventsRef, (events) => {
                const next = events.concat(event);
                return [
                  events.length < ACP_MAX_PENDING_EVENTS,
                  next.length > ACP_MAX_PENDING_EVENTS
                    ? next.slice(next.length - ACP_MAX_PENDING_EVENTS)
                    : next,
                ] as const;
              });
              if (retainedCountIncreased) {
                sessionUpdatesEnqueued += 1;
              }
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sessionEventOffersInFlight -= 1;
              }),
            ),
          ),
        );

    // Closes the buffering-path TOCTOU: a session/update handler may read a
    // pre-transition epoch and buffer its notification after setSessionEpoch
    // has already drained the pending buffer. Rechecking here guarantees the
    // notification is applied exactly once by whichever side wins the
    // atomic getAndSet, leaving no pending state behind.
    const drainPendingForActiveSession = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const epoch = yield* getSessionEpoch();
          if (Option.isNone(epoch.activeSessionId)) return;
          if (!(yield* Ref.get(acceptingSessionUpdatesRef))) return;
          const sessionId = epoch.activeSessionId.value;
          const raced = yield* Ref.getAndSet(pendingSessionStateRef, new Map());
          const racedPending = raced.get(sessionId);
          if (!racedPending || racedPending.notifications.length === 0) return;
          const offer = offerSessionEvent(sessionId, epoch);
          for (const notification of racedPending.notifications) {
            yield* processSessionUpdate({
              getSessionEpoch,
              offer,
              sessionId,
              epoch,
              availableCommandsRef,
              configOptionsRef,
              modeStateRef,
              toolCallsRef,
              assistantSegmentRef,
              runtimeInstanceId,
              resolveConfigOptionUpdateWaiters,
              skipTranscriptEvents: false,
              params: notification,
            });
          }
        }
      });

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, AcpErrors.AcpError>,
    ): Effect.Effect<A, AcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    // A supplied environment is an exact capability set prepared by the
    // provider boundary. Merging process.env here would silently restore
    // stripped control-plane credentials and launcher capabilities.
    const env = buildProviderChildEnvironment({
      provider: "acp",
      baseEnv: options.spawn.env ? { ...options.spawn.env } : process.env,
    });
    const child = yield* spawner
      .spawn(
        makeEffectProcessCommand(options.spawn.command, options.spawn.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          env,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new AcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    yield* Effect.addFinalizer(() => teardownAcpChildProcess(child, options.teardownProcessTree));
    // Registered after child teardown so LIFO scope closure releases any first
    // prompt/fork waiter before waiting for the child process to exit.
    yield* Effect.addFinalizer(() => loadReplayGate?.release ?? Effect.void);

    const acp = yield* makeOfficialSdkClient(child, runtimeScope, options);

    const resolveConfigOptionUpdateWaiters = (
      configOptions: ReadonlyArray<Acp.SessionConfigOption>,
    ): Effect.Effect<void> =>
      Ref.modify(configOptionUpdateWaitersRef, (waiters) => {
        const resolved: ConfigOptionUpdateWaiter[] = [];
        const pending: ConfigOptionUpdateWaiter[] = [];
        for (const waiter of waiters) {
          const configOption = findSessionConfigOption(configOptions, waiter.configId);
          if (configOption && configOptionCurrentValueMatches(configOption, waiter.value)) {
            resolved.push(waiter);
          } else {
            pending.push(waiter);
          }
        }
        return [resolved, pending] as const;
      }).pipe(
        Effect.flatMap((waiters) =>
          Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.deferred, configOptions), {
            discard: true,
          }),
        ),
      );

    yield* acp.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const epoch = yield* getSessionEpoch();
        const sessionId = notification.sessionId;

        // No authoritative session id yet: buffer everything in one bounded state
        // machine keyed by the provisional session id. setSessionEpoch will
        // atomically install the setup baseline and replay only the matching session.
        if (Option.isNone(epoch.activeSessionId)) {
          yield* Ref.update(pendingSessionStateRef, (map) =>
            appendPendingNotification(map, sessionId, notification),
          );
          return yield* drainPendingForActiveSession();
        }

        if (!isActiveSessionId(sessionId, epoch)) {
          return;
        }

        const accepting = yield* Ref.get(acceptingSessionUpdatesRef);
        if (!accepting) {
          // The gate is closed; hold the update until the consumer attaches.
          yield* Ref.update(pendingSessionStateRef, (map) =>
            appendPendingNotification(map, sessionId, notification),
          );
          return;
        }

        if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;

        const offer = offerSessionEvent(sessionId, epoch);
        const apply = (suppress: boolean) =>
          processSessionUpdate({
            getSessionEpoch,
            offer,
            sessionId,
            epoch,
            availableCommandsRef,
            configOptionsRef,
            modeStateRef,
            toolCallsRef,
            assistantSegmentRef,
            runtimeInstanceId,
            resolveConfigOptionUpdateWaiters,
            skipTranscriptEvents: suppress,
            params: notification,
          });
        return yield* loadReplayGate === undefined
          ? apply(false)
          : loadReplayGate.suppressUpdate.pipe(Effect.flatMap(apply));
      }),
    );

    // Register the startup dispatchers before any start() so ACP requests that
    // arrive during session setup are held in the provisional registry.
    yield* acp.handleRequestPermission(requestPermissionStartup.dispatch);
    yield* acp.handleElicitation(elicitationStartup.dispatch);

    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<Acp.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new AcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: new Error("ACP session runtime has not been started"),
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, AcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new AcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new AcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new AcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | Acp.SetSessionConfigOptionResponse
        | Acp.LoadSessionResponse
        | Acp.NewSessionResponse
        | Acp.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const waitForConfigOptionUpdate = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<ReadonlyArray<Acp.SessionConfigOption>, AcpErrors.AcpError> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<ReadonlyArray<Acp.SessionConfigOption>>();
        const waiter: ConfigOptionUpdateWaiter = { configId, value, deferred };
        yield* Ref.update(configOptionUpdateWaitersRef, (waiters) => [...waiters, waiter]);

        // The notification may have arrived before the empty response was
        // observed and this waiter was registered. Recheck the retained state
        // after registration so both event orderings are race-safe.
        const current = yield* Ref.get(configOptionsRef);
        const currentOption = findSessionConfigOption(current, configId);
        if (currentOption && configOptionCurrentValueMatches(currentOption, value)) {
          yield* Deferred.succeed(deferred, current);
        }

        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(CONFIG_OPTION_UPDATE_TIMEOUT),
          Effect.ensuring(
            Ref.update(configOptionUpdateWaitersRef, (waiters) =>
              waiters.filter((candidate) => candidate !== waiter),
            ),
          ),
        );
        if (Option.isNone(result)) {
          return yield* new AcpErrors.AcpTransportError({
            detail:
              "ACP agent returned an empty session/set_config_option response without a matching config_option_update notification",
            cause: new Error(
              `Timed out waiting for config option ${JSON.stringify(configId)} to become ${JSON.stringify(value)}`,
            ),
          });
        }
        return result.value;
      });

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<Acp.SetSessionConfigOptionResponse, AcpErrors.AcpError> =>
      awaitLoadReplayReady.pipe(
        Effect.andThen(validateConfigOptionValue(configId, value)),
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions: [...configOptions],
                } satisfies Acp.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies Acp.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies Acp.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.raw
                  .request("session/set_config_option", requestPayload)
                  .pipe(
                    Effect.flatMap((response) =>
                      decodeSetSessionConfigOptionResponse(
                        response,
                        waitForConfigOptionUpdate(configId, value),
                      ),
                    ),
                  ),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    const startupTimeouts: AcpSessionStartupTimeouts = {
      ...DEFAULT_ACP_SESSION_STARTUP_TIMEOUTS,
      ...options.startupTimeouts,
    };

    const withStartupTimeout = <A>(
      step: AcpSessionStartupStep,
      timeoutMs: number,
      effect: Effect.Effect<A, AcpErrors.AcpError>,
    ): Effect.Effect<A, AcpErrors.AcpError> =>
      effect.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(acpStartupTimeoutError(step, timeoutMs)),
            onSome: Effect.succeed,
          }),
        ),
      );

    const startOnce = Effect.gen(function* () {
      yield* requestPermissionStartup.begin();
      yield* elicitationStartup.begin();

      const startupResult = yield* Effect.gen(function* () {
        const initializePayload = {
          protocolVersion: 1,
          clientCapabilities: initializeClientCapabilities,
          clientInfo: options.clientInfo,
        } satisfies Acp.InitializeRequest;

        const initializeResult = yield* withStartupTimeout(
          "initialize",
          startupTimeouts.initializeMs,
          runLoggedRequest(
            "initialize",
            initializePayload,
            acp.agent.initialize(initializePayload),
          ),
        );

        if (options.validateInitializeResult !== undefined) {
          yield* options.validateInitializeResult(initializeResult);
        }

        // Tracks whether authenticate has already been run so the on-demand
        // path only retries session setup once.
        const authenticatedRef = yield* Ref.make(false);

        const mcpServers = options.buildMcpServers?.(initializeResult) ?? [];
        const sessionCwd = resolveAcpSessionCwd(options.cwd);

        const runAuthenticate = Effect.gen(function* () {
          const authMethodId =
            options.resolveAuthMethodId !== undefined
              ? yield* options.resolveAuthMethodId(initializeResult)
              : options.authMethodId;

          if (!authMethodId) {
            return yield* new AcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: "ACP agent did not provide an authentication method.",
              data: { authMethods: initializeResult.authMethods ?? [] },
            });
          }

          const authenticatePayload = {
            methodId: authMethodId,
            ...(options.authenticateMeta ? { _meta: options.authenticateMeta } : {}),
          } satisfies Acp.AuthenticateRequest;

          yield* withStartupTimeout(
            "authenticate",
            startupTimeouts.authenticateMs,
            runLoggedRequest(
              "authenticate",
              authenticatePayload,
              acp.agent.authenticate(authenticatePayload),
            ),
          );

          yield* Ref.set(authenticatedRef, true);
        });

        const cleanupDiscardedAcpSession = (discardedSessionId: string) =>
          Effect.gen(function* () {
            // Stop accepting new transcript updates and bump the session generation so
            // any in-flight handlers that were admitted under the discarded epoch are
            // rejected before they can mutate state or enqueue events.
            yield* Ref.set(acceptingSessionUpdatesRef, false);
            const pending = yield* clearSessionEpoch();

            // Drain any events that were already enqueued for the discarded session.
            let queued = 0;
            while (true) {
              const event = yield* Queue.poll(eventQueue);
              if (Option.isSome(event)) {
                queued += 1;
                continue;
              }
              if (sessionEventOffersInFlight === 0) break;
              yield* Effect.yieldNow;
            }
            sessionUpdatesEnqueued -= pending + queued;

            // Reset bounded state derived from the discarded session so it cannot leak
            // into the final authenticated session.
            yield* Ref.set(availableCommandsRef, []);
            yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(undefined));
            yield* Ref.set(modeStateRef, undefined);
            yield* Ref.set(toolCallsRef, new Map());
            yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });

            // Best-effort close so the agent does not keep the probe session alive.
            const supportsClose =
              initializeResult.agentCapabilities?.sessionCapabilities?.close != null;
            if (supportsClose) {
              yield* acp.agent.closeSession({ sessionId: discardedSessionId }).pipe(Effect.ignore);
            }
          });

        const runSessionSetup = Effect.gen(function* () {
          let sessionId: string;
          let sessionSetupResult:
            | Acp.LoadSessionResponse
            | Acp.NewSessionResponse
            | Acp.ResumeSessionResponse;
          let resumedExistingSession = false;
          let sessionSetupMethod: AcpSessionRuntimeStartResult["sessionSetupMethod"] = "new";

          if (options.resumeSessionId) {
            const resumePayload = {
              sessionId: options.resumeSessionId,
              cwd: sessionCwd,
              mcpServers,
              ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
            } satisfies Acp.ResumeSessionRequest;
            const supportsResume =
              initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
            const supportsLoad = initializeResult.agentCapabilities?.loadSession === true;
            if (!supportsResume && !supportsLoad) {
              return yield* new AcpErrors.AcpRequestError({
                code: -32601,
                errorMessage:
                  "ACP agent cannot reopen the requested session because it advertises neither session/resume nor session/load.",
              });
            }
            const resumed = yield* supportsResume
              ? withStartupTimeout(
                  "session/resume",
                  startupTimeouts.sessionSetupMs,
                  runLoggedRequest(
                    "session/resume",
                    resumePayload,
                    acp.agent.resumeSession(resumePayload),
                  ),
                )
              : (() => {
                  const loadPayload = {
                    sessionId: options.resumeSessionId,
                    cwd: sessionCwd,
                    mcpServers,
                    ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
                  } satisfies Acp.LoadSessionRequest;
                  return withStartupTimeout(
                    "session/load",
                    startupTimeouts.sessionSetupMs,
                    runLoggedRequest(
                      "session/load",
                      loadPayload,
                      acp.agent.loadSession(loadPayload),
                    ),
                  );
                })();
            // Resume/load failure is terminal. Retrying as session/new would create a second
            // conversation and make delivery outcome ambiguous.
            sessionId = options.resumeSessionId;
            sessionSetupResult = resumed;
            resumedExistingSession = true;
            sessionSetupMethod = supportsResume ? "resume" : "load";
          } else {
            // Fresh session: do not accept notifications until session/new has
            // returned a concrete session id. This prevents notifications from a
            // discarded probe session (e.g. on-demand auth) from being mistaken
            // for the final authenticated session while the request is pending.
            yield* Ref.set(acceptingSessionUpdatesRef, false);
            const createPayload = {
              cwd: sessionCwd,
              mcpServers,
              ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
            } satisfies Acp.NewSessionRequest;
            const created = yield* withStartupTimeout(
              "session/new",
              startupTimeouts.sessionSetupMs,
              runAcpFreshSessionSetup(
                runLoggedRequest(
                  "session/new",
                  createPayload,
                  acp.agent.createSession(createPayload),
                ),
                options.freshSessionRetry,
              ),
            );
            sessionId = created.sessionId;
            sessionSetupResult = created;
            sessionSetupMethod = "new";
          }

          // On-demand authentication: consult the provider-specific heuristic to
          // decide whether an unauthenticated setup result is an auth-required
          // signal. The generic ACP path only retries on a verified auth-required
          // transport/request failure.
          if (options.authPolicy === "on-demand" && !(yield* Ref.get(authenticatedRef))) {
            const authRequired =
              options.authSetupHeuristic?.(initializeResult, sessionSetupResult) ?? false;
            if (authRequired) {
              yield* cleanupDiscardedAcpSession(sessionId);
              return yield* new AcpErrors.AcpRequestError({
                code: -32000,
                errorMessage:
                  "Authentication required: ACP session setup returned an unusable result; authenticate and retry.",
                data: { authMethods: initializeResult.authMethods ?? [] },
              });
            }
          }

          // session/load may replay a large transcript before the consumer attaches;
          // gate prompt/fork/config access and per-update suppression until the
          // replay settles or reaches its hard cap.
          if (sessionSetupMethod === "load") {
            const quietMs = options.loadReplayPolicy?.quietMs ?? ACP_LOAD_REPLAY_QUIET_MS;
            const hardTimeoutMs =
              options.loadReplayPolicy?.hardTimeoutMs ?? ACP_LOAD_REPLAY_HARD_TIMEOUT_MS;
            loadReplayGate = yield* makeAcpLoadReplayGate({
              quietMs,
              hardTimeoutMs,
              onHardTimeout: ({ elapsedMs }) =>
                Effect.logWarning("acp.session_load_replay_quiet_wait_timeout", {
                  sessionId,
                  command: options.spawn.command,
                  elapsedMs,
                  quietMs,
                  hardTimeoutMs,
                }),
            });
          }

          // Install the final session id, baseline, and replay policy. Fresh sessions
          // replay all buffered updates; resumed sessions only apply bounded-state
          // updates (commands/config/mode) because transcript replay before attachment
          // is treated as historical context, not live output.
          yield* setSessionEpoch(sessionId, sessionSetupResult, {
            replay: resumedExistingSession ? "bounded-only" : "all",
            resetState: resumedExistingSession,
          });
          if (loadReplayGate !== undefined) {
            yield* loadReplayGate.settle.pipe(Effect.forkIn(runtimeScope));
          }

          return {
            sessionId,
            sessionSetupResult,
            resumedExistingSession,
            sessionSetupMethod,
          };
        });

        const setup =
          options.authPolicy === "on-demand"
            ? runSessionSetup.pipe(
                Effect.catchCause((cause) =>
                  causeIndicatesAuthRequired(cause)
                    ? runAuthenticate.pipe(Effect.andThen(runSessionSetup))
                    : Effect.failCause(cause),
                ),
              )
            : runAuthenticate.pipe(Effect.andThen(runSessionSetup));

        const { sessionId, sessionSetupResult, sessionSetupMethod } = yield* setup;

        // setSessionEpoch already installed the setup baseline and replayed pending
        // updates through the same reducer, so no separate post-setup mutation is
        // needed here.
        const nextState = {
          sessionId,
          initializeResult,
          sessionSetupResult,
          modelConfigId: extractModelConfigId(sessionSetupResult),
          sessionSetupMethod,
        } satisfies AcpStartedState;
        return nextState;
      }).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            yield* requestPermissionStartup.complete();
            yield* elicitationStartup.complete();
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* requestPermissionStartup.cancel();
            yield* elicitationStartup.cancel();
          }),
        ),
      );

      return startupResult;
    });

    // Backstop for a step that stays under its own budget while the handshake as
    // a whole never settles (e.g. an agent that keeps answering slowly).
    const boundedStartOnce = withStartupTimeout("startup", startupTimeouts.totalMs, startOnce);

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<AcpSessionRuntimeStartResult, AcpErrors.AcpError>();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              boundedStartOnce.pipe(
                Effect.tap((result) =>
                  Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, result)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    return {
      handleRequestPermission: requestPermissionStartup.register,
      handleElicitation: elicitationStartup.register,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      start: () => start,
      awaitExit: awaitAcpChildExit(child),
      getEvents: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Attaching a consumer opens the gate and drains any events that were
            // buffered while no consumer was attached. The stream begins with the
            // drained events and then pulls from the live queue.
            const gate = loadReplayGate;
            if (gate !== undefined) {
              yield* gate.attachConsumer;
            }
            yield* Ref.set(acceptingSessionUpdatesRef, true);
            yield* Ref.set(consumerAttachedRef, true);
            const pending = yield* Ref.getAndSet(pendingEventsRef, []);
            for (const event of pending) {
              yield* Queue.offer(eventQueue, event);
            }
            return Stream.fromQueue(eventQueue);
          }),
        ),
      sessionUpdatesEnqueuedCount: Effect.sync(() => sessionUpdatesEnqueued),
      getModeState,
      getSessionEpoch,
      getPendingSessionNotificationCount: () =>
        Ref.get(pendingSessionStateRef).pipe(
          Effect.map((map) => {
            let total = 0;
            for (const state of map.values()) {
              total += state.notifications.length;
            }
            return total;
          }),
        ),
      getConfigOptions,
      getAvailableCommands,
      awaitLoadReplayReady,
      prompt: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) =>
            awaitLoadReplayReady.pipe(
              Effect.andThen(Ref.get(sessionEpochRef)),
              Effect.flatMap((epoch) => {
                const offer = offerSessionEvent(started.sessionId, epoch);
                const requestPayload = {
                  sessionId: started.sessionId,
                  ...payload,
                } satisfies Acp.PromptRequest;
                return closeActiveAssistantSegment({
                  getSessionEpoch,
                  offer,
                  sessionId: started.sessionId,
                  epoch,
                  assistantSegmentRef,
                }).pipe(
                  Effect.andThen(
                    runLoggedRequest(
                      "session/prompt",
                      requestPayload,
                      acp.agent.prompt(requestPayload),
                    ),
                  ),
                  Effect.tap(() =>
                    closeActiveAssistantSegment({
                      getSessionEpoch,
                      offer,
                      sessionId: started.sessionId,
                      epoch,
                      assistantSegmentRef,
                    }),
                  ),
                );
              }),
            ),
          ),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) => acp.agent.cancel({ sessionId: started.sessionId })),
      ),
      setMode: (modeId) =>
        getModeState.pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies Acp.SetSessionModeResponse);
            }
            return getConfigOptions.pipe(
              Effect.map((options) =>
                options.find(
                  (option) =>
                    option.type === "select" &&
                    (option.category === "mode" || option.id === "mode") &&
                    flattenSessionConfigSelectOptions(option.options).some(
                      (entry) => entry.value === modeId,
                    ),
                ),
              ),
              Effect.flatMap((modeOption) => setConfigOption(modeOption?.id ?? "mode", modeId)),
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies Acp.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      supportsSessionFork: getStartedState.pipe(
        Effect.map(
          (started) =>
            started.initializeResult.agentCapabilities?.sessionCapabilities?.fork != null,
        ),
      ),
      supportsSessionRecovery: getStartedState.pipe(
        Effect.map((started) => {
          const capabilities = started.initializeResult.agentCapabilities;
          return (
            capabilities?.sessionCapabilities?.resume != null || capabilities?.loadSession === true
          );
        }),
      ),
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            if (!started.modelConfigId) {
              return Ref.get(configOptionsRef).pipe(
                Effect.flatMap((configOptions) =>
                  Effect.fail(
                    new AcpErrors.AcpRequestError({
                      code: -32602,
                      errorMessage: "ACP session did not advertise a model config option.",
                      data: {
                        requestedModel: model,
                        configOptionIds: configOptions.map((option) => option.id),
                      },
                    }),
                  ),
                ),
              );
            }
            return setConfigOption(started.modelConfigId, model);
          }),
          Effect.asVoid,
        ),
      forkSession: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              ...payload,
              sessionId: started.sessionId,
            } satisfies Acp.ForkSessionRequest;
            return awaitLoadReplayReady.pipe(
              Effect.andThen(
                runLoggedRequest(
                  "session/fork",
                  requestPayload,
                  acp.agent.forkSession(requestPayload),
                ),
              ),
            );
          }),
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntimeShape;
  });

export function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<Acp.SessionConfigOption> | null;
      }
    | undefined,
  fallback: ReadonlyArray<Acp.SessionConfigOption> = [],
): ReadonlyArray<Acp.SessionConfigOption> {
  return response?.configOptions ?? fallback;
}

function mergeSessionConfigOptions(
  current: ReadonlyArray<Acp.SessionConfigOption>,
  update: ReadonlyArray<Acp.SessionConfigOption>,
): ReadonlyArray<Acp.SessionConfigOption> {
  const byId = new Map(current.map((option) => [option.id, option]));
  for (const option of update) {
    byId.set(option.id, option);
  }
  const result: Acp.SessionConfigOption[] = [];
  const seen = new Set<string>();
  for (const option of current) {
    result.push(byId.get(option.id) ?? option);
    seen.add(option.id);
  }
  for (const option of update) {
    if (!seen.has(option.id)) {
      result.push(option);
      seen.add(option.id);
    }
  }
  return result;
}

// Flattens grouped ACP select options so semantic configuration lookup stays provider-agnostic.
export function flattenSessionConfigSelectOptions(
  options:
    | ReadonlyArray<Acp.SessionConfigSelectOption>
    | ReadonlyArray<Acp.SessionConfigSelectGroup>,
): ReadonlyArray<Acp.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function configOptionCurrentValueMatches(
  configOption: Acp.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

export function decodeSetSessionConfigOptionResponse(
  response: unknown,
  configUpdate: Effect.Effect<ReadonlyArray<Acp.SessionConfigOption>, AcpErrors.AcpError>,
): Effect.Effect<Acp.SetSessionConfigOptionResponse, AcpErrors.AcpError> {
  if (isEmptyRecord(response)) {
    return configUpdate.pipe(
      Effect.map((configOptions) => ({ configOptions: [...configOptions] })),
    );
  }
  return Schema.decodeUnknownEffect(SetSessionConfigOptionResponseCodec)(response).pipe(
    Effect.mapError(
      (cause) =>
        new AcpErrors.AcpTransportError({
          detail: "ACP agent returned an invalid session/set_config_option response",
          cause,
        }),
    ),
  );
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

const processSessionUpdate = ({
  getSessionEpoch,
  offer,
  sessionId,
  epoch,
  availableCommandsRef,
  configOptionsRef,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  runtimeInstanceId,
  skipTranscriptEvents,
  resolveConfigOptionUpdateWaiters,
  params,
}: {
  readonly getSessionEpoch: () => Effect.Effect<SessionEpoch>;
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly sessionId: string;
  readonly epoch: SessionEpoch;
  readonly availableCommandsRef: Ref.Ref<ReadonlyArray<Acp.AvailableCommand>>;
  readonly configOptionsRef: Ref.Ref<ReadonlyArray<Acp.SessionConfigOption>>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly runtimeInstanceId: string;
  readonly skipTranscriptEvents: boolean;
  readonly resolveConfigOptionUpdateWaiters: (
    configOptions: ReadonlyArray<Acp.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly params: Acp.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const update = params.update;

    // Bounded state is always applied because it is not part of the transcript.
    if (update.sessionUpdate === "available_commands_update") {
      if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
      yield* Ref.set(availableCommandsRef, update.availableCommands);
      return;
    }

    if (update.sessionUpdate === "config_option_update") {
      if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
      yield* Ref.update(configOptionsRef, (currentOptions) =>
        mergeSessionConfigOptions(currentOptions, update.configOptions),
      );
      yield* resolveConfigOptionUpdateWaiters(update.configOptions);
      return;
    }

    const parsed = parseSessionUpdateEvent(params);
    const modeId = parsed.modeId;
    if (modeId) {
      if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, modeId),
      );
    }

    if (skipTranscriptEvents) {
      return;
    }

    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
        yield* closeActiveAssistantSegment({
          getSessionEpoch,
          offer,
          sessionId,
          epoch,
          assistantSegmentRef,
        });
        const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
          continue;
        }
        yield* offer({
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.streamKind === "reasoning_text") {
          if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
          yield* offer(event);
          continue;
        }
        if (event.text.trim().length === 0) {
          if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          getSessionEpoch,
          offer,
          assistantSegmentRef,
          sessionId,
          epoch,
          runtimeInstanceId,
          requestedItemId: event.itemId,
        });
        yield* offer({
          ...event,
          itemId,
        });
        continue;
      }
      yield* offer(event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (previous === undefined) {
    return true;
  }
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (previous.status !== next.status || previous.title !== next.title) {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous.detail !== next.detail;
}

export const assistantItemId = (
  sessionId: string,
  runtimeInstanceId: string,
  segmentIndex: number,
) => `assistant:${sessionId}:${runtimeInstanceId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  getSessionEpoch,
  offer,
  assistantSegmentRef,
  sessionId,
  epoch,
  runtimeInstanceId,
  requestedItemId,
}: {
  readonly getSessionEpoch: () => Effect.Effect<SessionEpoch>;
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly epoch: SessionEpoch;
  readonly runtimeInstanceId: string;
  readonly requestedItemId?: string | undefined;
}) =>
  Effect.gen(function* () {
    if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) {
      return requestedItemId ?? assistantItemId(sessionId, runtimeInstanceId, 0);
    }
    return yield* Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
      assistantSegmentRef,
      (current) => {
        if (current.activeItemId && current.activeItemId === requestedItemId) {
          return [{ itemId: current.activeItemId }, current] as const;
        }
        if (current.activeItemId && requestedItemId === undefined) {
          return [{ itemId: current.activeItemId }, current] as const;
        }
        // Cursor can provide stable message ids for chunks that resume after tool calls.
        // Keep those ids so projection appends the pieces instead of displaying broken segments.
        const itemId =
          requestedItemId ??
          assistantItemId(sessionId, runtimeInstanceId, current.nextSegmentIndex);
        const completedEvent = current.activeItemId
          ? ({
              _tag: "AssistantItemCompleted",
              itemId: current.activeItemId,
            } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemCompleted" }>)
          : undefined;
        return [
          {
            itemId,
            ...(completedEvent ? { completedEvent } : {}),
            startedEvent: {
              _tag: "AssistantItemStarted",
              itemId,
            } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
          },
          {
            nextSegmentIndex:
              requestedItemId === undefined
                ? current.nextSegmentIndex + 1
                : current.nextSegmentIndex,
            activeItemId: itemId,
          } satisfies AcpAssistantSegmentState,
        ] as const;
      },
    ).pipe(
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          if (result.completedEvent) {
            yield* offer(result.completedEvent);
          }
          if (result.startedEvent) {
            yield* offer(result.startedEvent);
          }
          return result.itemId;
        }),
      ),
    );
  });

const closeActiveAssistantSegment = ({
  getSessionEpoch,
  offer,
  sessionId,
  epoch,
  assistantSegmentRef,
}: {
  readonly getSessionEpoch: () => Effect.Effect<SessionEpoch>;
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly sessionId: string;
  readonly epoch: SessionEpoch;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Effect.gen(function* () {
    if (!(yield* isCurrentSessionEpoch(getSessionEpoch, sessionId, epoch))) return;
    const event = yield* Ref.modify(assistantSegmentRef, (current) => {
      if (!current.activeItemId) {
        return [undefined, current] as const;
      }
      return [
        {
          _tag: "AssistantItemCompleted",
          itemId: current.activeItemId,
        } satisfies AcpParsedSessionEvent,
        {
          nextSegmentIndex: current.nextSegmentIndex,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    });
    if (event) {
      yield* offer(event);
    }
  });
