// FILE: AcpSessionRuntime.ts
// Purpose: Owns one authenticated ACP process, session setup, configuration, and event stream.
// Layer: Provider ACP runtime
// Exports: AcpSessionRuntime and its typed runtime factory contracts.

import { randomUUID } from "node:crypto";
import type * as Acp from "@agentclientprotocol/sdk";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "./AcpErrors.ts";
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
export const ACP_MAX_INCOMING_FRAME_BYTES = 8 * 1024 * 1024;

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

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientCapabilities?: Acp.InitializeRequest["clientCapabilities"];
  /** Provider-specific metadata sent on session/new, session/load, and session/resume. */
  readonly sessionMeta?: Record<string, unknown>;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  readonly resolveAuthMethodId?: (
    initializeResult: Acp.InitializeResponse,
  ) => Effect.Effect<string, AcpErrors.AcpError>;
  /**
   * MCP servers to attach to the session. Invoked after `initialize` so the
   * builder can pick a transport based on the agent's advertised
   * `mcpCapabilities` (e.g. HTTP vs stdio for the Synara agent gateway).
   */
  readonly buildMcpServers?: (initializeResult: Acp.InitializeResponse) => Array<Acp.McpServer>;
  readonly authenticateMeta?: Record<string, unknown>;
  /** Overrides for {@link DEFAULT_ACP_SESSION_STARTUP_TIMEOUTS}. */
  readonly startupTimeouts?: Partial<AcpSessionStartupTimeouts>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
  /** Test seam for the single shared ACP subprocess teardown owner. */
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
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
  // Monotonic count of parsed session/update events enqueued for the
  // getEvents() consumer. Adapters snapshot it and wait until their own
  // processed count catches up, so turn attribution stays open until every
  // event received during the turn has actually been handled — immune to
  // stream chunk buffering and in-flight handlers, unlike a queue-size probe.
  readonly sessionUpdatesEnqueuedCount: Effect.Effect<number>;
  readonly supportsSessionFork: Effect.Effect<boolean, AcpErrors.AcpError>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<Acp.SessionConfigOption>>;
  readonly getAvailableCommands: Effect.Effect<ReadonlyArray<Acp.AvailableCommand>>;
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
  protocolLogging?: AcpSessionRuntimeOptions["protocolLogging"],
) {
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
  // The ACP SDK is only needed once a provider process is actually spawned, so
  // it is imported here instead of at module scope (see AcpSdk.ts).
  const acpSdk = yield* Effect.promise(() => loadAcpSdk());
  const logProtocol = (
    direction: "incoming" | "outgoing",
    stage: "raw" | "decoded",
    payload: unknown,
  ) => {
    if (
      (direction === "incoming" && protocolLogging?.logIncoming !== true) ||
      (direction === "outgoing" && protocolLogging?.logOutgoing !== true)
    ) {
      return Effect.void;
    }
    const logger = protocolLogging?.logger;
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
  const input = new ReadableStream<Uint8Array>({
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
        request(acpSdk.methods.agent.session.new, payload),
      loadSession: (payload: Acp.LoadSessionRequest) =>
        request(acpSdk.methods.agent.session.load, payload).pipe(
          Effect.map((response) => response ?? {}),
        ),
      listSessions: (payload: Acp.ListSessionsRequest) =>
        request(acpSdk.methods.agent.session.list, payload),
      forkSession: (payload: Acp.ForkSessionRequest) =>
        request(acpSdk.methods.agent.session.fork, payload),
      resumeSession: (payload: Acp.ResumeSessionRequest) =>
        request(acpSdk.methods.agent.session.resume, payload),
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
    const eventQueue = yield* Queue.bounded<AcpParsedSessionEvent>(2_048);
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
    // session/load can replay a large history before the consumer attaches; drop
    // those notifications so they never accumulate in the unbounded queue. For
    // resumed sessions the gate stays closed past start() and only opens once the
    // adapter attaches a consumer via getEvents(), because the agent may keep
    // replaying after replying to session/load. Plain mutable state (not a Ref)
    // so getEvents() can open the gate synchronously at attach time.
    let acceptingSessionUpdates = false;
    // Counts every parsed event offered into eventQueue (see
    // sessionUpdatesEnqueuedCount on the shape). Plain mutable state: single
    // writer per offer, and readers only need a monotonic snapshot.
    let sessionUpdatesEnqueued = 0;
    const offerSessionEvent = (event: AcpParsedSessionEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        sessionUpdatesEnqueued += 1;
        return Effect.asVoid(Queue.offer(eventQueue, event));
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
    const prepared = prepareWindowsSafeProcess(options.spawn.command, options.spawn.args, {
      cwd: options.spawn.cwd,
      env,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(prepared.command, prepared.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          env,
          shell: prepared.shell,
          ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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

    const acp = yield* makeOfficialSdkClient(child, runtimeScope, options.protocolLogging);

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
      Effect.suspend(() => {
        const update = notification.update;
        const rememberCommands =
          update.sessionUpdate === "available_commands_update"
            ? Ref.set(availableCommandsRef, update.availableCommands)
            : Effect.void;
        const rememberConfigOptions =
          update.sessionUpdate === "config_option_update"
            ? Ref.set(configOptionsRef, update.configOptions).pipe(
                Effect.andThen(resolveConfigOptionUpdateWaiters(update.configOptions)),
              )
            : Effect.void;
        const rememberBoundedState = rememberCommands.pipe(Effect.andThen(rememberConfigOptions));
        if (!acceptingSessionUpdates) {
          // Command and configuration inventories are bounded state, not
          // transcript replay; retain them even while historical session
          // updates are being suppressed.
          return rememberBoundedState;
        }
        return rememberBoundedState.pipe(
          Effect.andThen(
            handleSessionUpdate({
              offer: offerSessionEvent,
              modeStateRef,
              toolCallsRef,
              assistantSegmentRef,
              runtimeInstanceId,
              params: notification,
            }),
          ),
        );
      }),
    );

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
      validateConfigOptionValue(configId, value).pipe(
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
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies Acp.InitializeRequest;

      const initializeResult = yield* withStartupTimeout(
        "initialize",
        startupTimeouts.initializeMs,
        runLoggedRequest("initialize", initializePayload, acp.agent.initialize(initializePayload)),
      );
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

      const mcpServers = options.buildMcpServers?.(initializeResult) ?? [];

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
          cwd: options.cwd,
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
                cwd: options.cwd,
                mcpServers,
                ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
              } satisfies Acp.LoadSessionRequest;
              return withStartupTimeout(
                "session/load",
                startupTimeouts.sessionSetupMs,
                runLoggedRequest("session/load", loadPayload, acp.agent.loadSession(loadPayload)),
              );
            })();
        // Resume/load failure is terminal. Retrying as session/new would create a second
        // conversation and make delivery outcome ambiguous.
        sessionId = options.resumeSessionId;
        sessionSetupResult = resumed;
        resumedExistingSession = true;
        sessionSetupMethod = supportsResume ? "resume" : "load";
      } else {
        // Fresh session: accept updates from before session/new so any early
        // agent output emitted while the request is in flight is buffered.
        acceptingSessionUpdates = true;
        const createPayload = {
          cwd: options.cwd,
          mcpServers,
          ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
        } satisfies Acp.NewSessionRequest;
        const created = yield* withStartupTimeout(
          "session/new",
          startupTimeouts.sessionSetupMs,
          runLoggedRequest("session/new", createPayload, acp.agent.createSession(createPayload)),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
        sessionSetupMethod = "new";
      }

      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      yield* Ref.update(configOptionsRef, (current) =>
        sessionConfigOptionsFromSetup(sessionSetupResult, current),
      );
      // Fresh sessions accept session/update while session/new is in flight, and
      // those events are already in the queue; resetting the merge/segment state
      // they created would orphan their continuations (new segment ids, unmerged
      // tool updates). Only the resumed replay-dropping path starts clean.
      if (resumedExistingSession) {
        yield* Ref.set(toolCallsRef, new Map());
        yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });
      }

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
        sessionSetupMethod,
      } satisfies AcpStartedState;
      return nextState;
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
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
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
      getEvents: () => {
        // Attaching a consumer opens the session/update gate: from here on the
        // queue is drained, so accepting notifications can no longer grow it
        // without bound (see acceptingSessionUpdates above).
        acceptingSessionUpdates = true;
        return Stream.fromQueue(eventQueue);
      },
      sessionUpdatesEnqueuedCount: Effect.sync(() => sessionUpdatesEnqueued),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      getAvailableCommands: Ref.get(availableCommandsRef),
      prompt: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies Acp.PromptRequest;
            return closeActiveAssistantSegment({
              offer: offerSessionEvent,
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
                  offer: offerSessionEvent,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) => acp.agent.cancel({ sessionId: started.sessionId })),
      ),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies Acp.SetSessionModeResponse);
            }
            return Ref.get(configOptionsRef).pipe(
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
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
          Effect.asVoid,
        ),
      forkSession: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              ...payload,
              sessionId: started.sessionId,
            } satisfies Acp.ForkSessionRequest;
            return runLoggedRequest(
              "session/fork",
              requestPayload,
              acp.agent.forkSession(requestPayload),
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

// Flattens grouped ACP select options so semantic configuration lookup stays provider-agnostic.
function flattenSessionConfigSelectOptions(
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

const handleSessionUpdate = ({
  offer,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  runtimeInstanceId,
  params,
}: {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly runtimeInstanceId: string;
  readonly params: Acp.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          offer,
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
          yield* offer(event);
          continue;
        }
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          offer,
          assistantSegmentRef,
          sessionId: params.sessionId,
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
  offer,
  assistantSegmentRef,
  sessionId,
  runtimeInstanceId,
  requestedItemId,
}: {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly requestedItemId?: string | undefined;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
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
        requestedItemId ?? assistantItemId(sessionId, runtimeInstanceId, current.nextSegmentIndex);
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
            requestedItemId === undefined ? current.nextSegmentIndex + 1 : current.nextSegmentIndex,
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

const closeActiveAssistantSegment = ({
  offer,
  assistantSegmentRef,
}: {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
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
  }).pipe(Effect.flatMap((event) => (event ? offer(event) : Effect.void)));
