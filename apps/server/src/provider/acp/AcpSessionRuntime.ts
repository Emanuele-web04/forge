// FILE: AcpSessionRuntime.ts
// Purpose: Owns one authenticated ACP process, session setup, configuration, and event stream.
// Layer: Provider ACP runtime
// Exports: AcpSessionRuntime and its typed runtime factory contracts.

import { randomUUID } from "node:crypto";
import type * as Acp from "@agentclientprotocol/sdk";
import { parseWindowsWslUncPath, prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
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
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";

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

const ACP_AUTH_REQUIRED_CODE = -32000;

export function isAcpAuthRequiredError(error: EffectAcpErrors.AcpError): boolean {
  if (error._tag !== "AcpRequestError") {
    return false;
  }
  const message = error.errorMessage ?? "";
  // Protocol-level auth-required uses -32000 in ACP/effect-acp. Validate the
  // semantics by also requiring the message describe an auth failure, so a
  // generic -32000 server error is not misclassified as an auth challenge.
  if (error.code === ACP_AUTH_REQUIRED_CODE) {
    return /\bauth/i.test(message);
  }
  return /\bauth(entication|orization)?\b/i.test(message);
}

export function causeIndicatesAuthRequired(cause: Cause.Cause<EffectAcpErrors.AcpError>): boolean {
  const failReason = Cause.findFail(cause);
  if (failReason._tag === "Success" && isAcpAuthRequiredError(failReason.success.error)) {
    return true;
  }
  const dieReason = Cause.findDie(cause);
  if (dieReason._tag === "Success") {
    const defect = dieReason.success.defect;
    const message =
      defect instanceof Error ? defect.message : typeof defect === "string" ? defect : "";
    if (/\bauth(entication|orization)?\s+(required|failed|expired)\b/i.test(message)) {
      return true;
    }
  }
  return false;
}

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded";
  readonly payload: unknown;
}

type AcpHandler<Request, Response> = (
  request: Request,
) => Effect.Effect<Response, EffectAcpErrors.AcpError>;

type AcpHandlerRegistration<Handler> = (handler: Handler) => Effect.Effect<void>;

type ConfigOptionUpdateWaiter = {
  readonly configId: string;
  readonly value: string | boolean;
  readonly deferred: Deferred.Deferred<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
};

type AcpIncomingFrame =
  | { readonly _tag: "chunk"; readonly chunk: Uint8Array }
  | { readonly _tag: "error"; readonly error: unknown }
  | { readonly _tag: "end" };

type SessionEpoch = { generation: number; activeSessionId: Option.Option<string> };
const isActiveSessionId = (sessionId: string, epoch: SessionEpoch): boolean =>
  Option.isSome(epoch.activeSessionId) && epoch.activeSessionId.value === sessionId;

export function makeAcpIncomingFrameGuard(
  maxFrameBytes = ACP_MAX_INCOMING_FRAME_BYTES,
): (chunk: Uint8Array) => EffectAcpErrors.AcpTransportError | undefined {
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
        return new EffectAcpErrors.AcpTransportError({
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
  if (platform !== "win32") {
    return cwd;
  }
  return parseWindowsWslUncPath(cwd)?.linuxPath ?? cwd;
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
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  readonly resolveAuthMethodId?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => Effect.Effect<string, EffectAcpErrors.AcpError>;
  /**
   * When to send the ACP `authenticate` request during start.
   * - "always" (default): authenticate right after initialize, before session setup.
   * - "on-demand": attempt session setup without authenticate; if it fails with a
   *   verified auth-required error, resolve the advertised auth method,
   *   authenticate once, and retry the same setup operation once.
   */
  readonly authPolicy?: "always" | "on-demand";
  /**
   * MCP servers to attach to the session. Invoked after `initialize` so the
   * builder can pick a transport based on the agent's advertised
   * `mcpCapabilities` (e.g. HTTP vs stdio for the Synara agent gateway).
   */
  readonly buildMcpServers?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly authenticateMeta?: Record<string, unknown>;
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
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  /** `session/resume` does not replay transcript updates; `session/load` may. */
  readonly sessionSetupMethod: "new" | "load" | "resume";
}

export interface AcpSessionRuntimeShape {
  readonly handleRequestPermission: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.RequestPermissionRequest, EffectAcpSchema.RequestPermissionResponse>
  >;
  readonly handleElicitation: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.ElicitationRequest, EffectAcpSchema.ElicitationResponse>
  >;
  readonly handleReadTextFile: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.ReadTextFileRequest, EffectAcpSchema.ReadTextFileResponse>
  >;
  readonly handleWriteTextFile: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.WriteTextFileRequest, EffectAcpSchema.WriteTextFileResponse | void>
  >;
  readonly handleCreateTerminal: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.CreateTerminalRequest, EffectAcpSchema.CreateTerminalResponse>
  >;
  readonly handleTerminalOutput: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.TerminalOutputRequest, EffectAcpSchema.TerminalOutputResponse>
  >;
  readonly handleTerminalWaitForExit: AcpHandlerRegistration<
    AcpHandler<
      EffectAcpSchema.WaitForTerminalExitRequest,
      EffectAcpSchema.WaitForTerminalExitResponse
    >
  >;
  readonly handleTerminalKill: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.KillTerminalRequest, EffectAcpSchema.KillTerminalResponse | void>
  >;
  readonly handleTerminalRelease: AcpHandlerRegistration<
    AcpHandler<
      EffectAcpSchema.ReleaseTerminalRequest,
      EffectAcpSchema.ReleaseTerminalResponse | void
    >
  >;
  readonly handleSessionUpdate: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.SessionNotification, void>
  >;
  readonly handleElicitationComplete: AcpHandlerRegistration<
    AcpHandler<EffectAcpSchema.ElicitationCompleteNotification, void>
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
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  /** Completes when the owned ACP process exits, regardless of its exit status. */
  readonly awaitExit: Effect.Effect<void>;
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  // Monotonic count of parsed session/update events enqueued for the
  // getEvents() consumer. Adapters snapshot it and wait until their own
  // processed count catches up, so turn attribution stays open until every
  // event received during the turn has actually been handled — immune to
  // stream chunk buffering and in-flight handlers, unlike a queue-size probe.
  readonly sessionUpdatesEnqueuedCount: Effect.Effect<number>;
  readonly supportsSessionFork: Effect.Effect<boolean, EffectAcpErrors.AcpError>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly getAvailableCommands: Effect.Effect<ReadonlyArray<EffectAcpSchema.AvailableCommand>>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly forkSession: (
    payload: Omit<EffectAcpSchema.ForkSessionRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.ForkSessionResponse, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Resolves with the child process exit code when the ACP process exits (crash or normal). */
  readonly exitCode: Effect.Effect<number | null, never, never>;
}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
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

function officialSdkError(error: unknown): EffectAcpErrors.AcpError {
  return error instanceof OfficialAcp.RequestError
    ? new EffectAcpErrors.AcpRequestError({
        code: error.code as EffectAcpSchema.ErrorCode,
        errorMessage: error.message,
        ...(error.data !== undefined ? { data: error.data } : {}),
      })
    : new EffectAcpErrors.AcpTransportError({
        detail: error instanceof Error ? error.message : String(error),
        cause: error,
      });
}

function toOfficialMcpServers(
  servers: ReadonlyArray<EffectAcpSchema.McpServer> | undefined,
): Array<OfficialAcp.McpServer> {
  return (servers ?? []).map((server) => {
    if ("type" in server) {
      return {
        ...server,
        headers: server.headers.map((header) => ({ ...header })),
      };
    }
    return {
      ...server,
      args: [...server.args],
      env: server.env.map((entry) => ({ ...entry })),
    };
  });
}

function toOfficialContentBlocks(
  blocks: ReadonlyArray<EffectAcpSchema.ContentBlock>,
): Array<OfficialAcp.ContentBlock> {
  return blocks.map((block) => {
    const { annotations: sourceAnnotations, ...content } = block;
    const annotations = sourceAnnotations
      ? (() => {
          const { audience, ...rest } = sourceAnnotations;
          return {
            ...rest,
            ...(audience === undefined
              ? {}
              : { audience: audience === null ? null : [...audience] }),
          };
        })()
      : sourceAnnotations;
    return {
      ...content,
      ...(annotations === undefined ? {} : { annotations }),
    };
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
  const dispatchSessionUpdate = (officialParams: OfficialAcp.SessionNotification) => {
    const params = Schema.decodeUnknownSync(EffectAcpSchema.SessionNotification)(officialParams);
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

  const runHandler = <A>(effect: Effect.Effect<A, EffectAcpErrors.AcpError>): Promise<A> =>
    Effect.runPromise(effect).catch((error) => {
      if (error instanceof EffectAcpErrors.AcpRequestError) {
        throw new OfficialAcp.RequestError(error.code, error.errorMessage, error.data);
      }
      throw error;
    });
  const requireHandler = <A>(
    method: string,
    handler: ((payload: never) => Effect.Effect<A, EffectAcpErrors.AcpError>) | undefined,
    payload: unknown,
  ) =>
    handler
      ? runHandler(handler(payload as never))
      : Promise.reject(OfficialAcp.RequestError.methodNotFound(method));

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

  const clientApp = OfficialAcp.client({ name: "synara" })
    .onRequest(OfficialAcp.methods.client.session.requestPermission, ({ params }) =>
      requireHandler("session/request_permission", requestPermission, params),
    )
    .onRequest(OfficialAcp.methods.client.fs.readTextFile, ({ params }) =>
      requireHandler("fs/read_text_file", readTextFile, params),
    )
    .onRequest(OfficialAcp.methods.client.fs.writeTextFile, ({ params }) =>
      requireHandler("fs/write_text_file", writeTextFile, params),
    )
    .onRequest(OfficialAcp.methods.client.terminal.create, ({ params }) =>
      requireHandler("terminal/create", createTerminal, params),
    )
    .onRequest(OfficialAcp.methods.client.terminal.output, ({ params }) =>
      requireHandler("terminal/output", terminalOutput, params),
    )
    .onRequest(OfficialAcp.methods.client.terminal.waitForExit, ({ params }) =>
      requireHandler("terminal/wait_for_exit", terminalWait, params),
    )
    .onRequest(OfficialAcp.methods.client.terminal.kill, ({ params }) =>
      requireHandler("terminal/kill", terminalKill, params),
    )
    .onRequest(OfficialAcp.methods.client.terminal.release, ({ params }) =>
      requireHandler("terminal/release", terminalRelease, params),
    )
    .onRequest(OfficialAcp.methods.client.elicitation.create, async ({ params }) => {
      const response = await requireHandler("elicitation/create", elicitation, params);
      return {
        ...response,
        ...response.action,
        action: response.action.action,
      };
    })
    .onNotification(OfficialAcp.methods.client.session.update, ({ params }) =>
      dispatchSessionUpdate(params),
    )
    .onNotification(OfficialAcp.methods.client.elicitation.complete, ({ params }) =>
      Promise.all(elicitationCompleteHandlers.map((handler) => runHandler(handler(params)))).then(
        () => undefined,
      ),
    );
  let connection: OfficialAcp.ClientConnection | undefined;
  const getConnection = () =>
    (connection ??= clientApp.connect(OfficialAcp.ndJsonStream(output, input)));
  const fromPromise = <A>(
    thunk: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
    Effect.tryPromise({ try: thunk, catch: officialSdkError });
  const request = <Method extends OfficialAcp.AgentRequestMethod>(
    method: Method,
    payload: OfficialAcp.AgentRequestParamsByMethod[Method],
  ): Effect.Effect<OfficialAcp.AgentRequestResponsesByMethod[Method], EffectAcpErrors.AcpError> =>
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
  const notifyStandard = <Method extends OfficialAcp.AgentNotificationMethod>(
    method: Method,
    payload: OfficialAcp.AgentNotificationParamsByMethod[Method],
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
      initialize: (payload: EffectAcpSchema.InitializeRequest) =>
        request(OfficialAcp.methods.agent.initialize, payload),
      authenticate: (payload: EffectAcpSchema.AuthenticateRequest) =>
        request(OfficialAcp.methods.agent.authenticate, payload),
      logout: (payload: EffectAcpSchema.LogoutRequest) =>
        request(OfficialAcp.methods.agent.logout, payload),
      createSession: (payload: EffectAcpSchema.NewSessionRequest) =>
        request(OfficialAcp.methods.agent.session.new, {
          ...payload,
          mcpServers: toOfficialMcpServers(payload.mcpServers),
        }),
      loadSession: (payload: EffectAcpSchema.LoadSessionRequest) =>
        request(OfficialAcp.methods.agent.session.load, {
          ...payload,
          mcpServers: toOfficialMcpServers(payload.mcpServers),
        }).pipe(Effect.map((response) => response ?? {})),
      listSessions: (payload: EffectAcpSchema.ListSessionsRequest) =>
        request(OfficialAcp.methods.agent.session.list, payload),
      forkSession: (payload: EffectAcpSchema.ForkSessionRequest) =>
        request(OfficialAcp.methods.agent.session.fork, {
          ...payload,
          mcpServers: toOfficialMcpServers(payload.mcpServers),
        }),
      resumeSession: (payload: EffectAcpSchema.ResumeSessionRequest) =>
        request(OfficialAcp.methods.agent.session.resume, {
          ...payload,
          mcpServers: toOfficialMcpServers(payload.mcpServers),
        }),
      closeSession: (payload: EffectAcpSchema.CloseSessionRequest) =>
        request(OfficialAcp.methods.agent.session.close, payload).pipe(
          Effect.map((response) => response ?? {}),
        ),
      setSessionModel: (payload: EffectAcpSchema.SetSessionModelRequest) =>
        requestCustom<EffectAcpSchema.SetSessionModelResponse>("session/set_model", payload),
      setSessionConfigOption: (payload: EffectAcpSchema.SetSessionConfigOptionRequest) =>
        request(OfficialAcp.methods.agent.session.setConfigOption, payload),
      prompt: (payload: EffectAcpSchema.PromptRequest) =>
        request(OfficialAcp.methods.agent.session.prompt, {
          ...payload,
          prompt: toOfficialContentBlocks(payload.prompt),
        }).pipe(Effect.tap(() => fromPromise(awaitSessionUpdateDrain))),
      cancel: (payload: EffectAcpSchema.CancelNotification) =>
        notifyStandard(OfficialAcp.methods.agent.session.cancel, payload),
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
  ): Layer.Layer<
    AcpSessionRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(AcpSessionRuntime, makeAcpSessionRuntime(options));
  }
}

const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.bounded<AcpParsedSessionEvent>(2_048);
    const sessionEpochRef = yield* Ref.make<{
      generation: number;
      activeSessionId: Option.Option<string>;
    }>({ generation: 0, activeSessionId: Option.none() });
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const availableCommandsRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>(
      [],
    );
    const pendingAvailableCommandsRef = yield* Ref.make(
      new Map<string, ReadonlyArray<EffectAcpSchema.AvailableCommand>>(),
    );
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    // Unique per runtime instance so assistant message ids never collide across
    // server restarts or session resumes (segment index resets to 0 each time).
    const runtimeInstanceId = randomUUID().slice(0, 8);
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const pendingConfigOptionsRef = yield* Ref.make(
      new Map<string, ReadonlyArray<EffectAcpSchema.SessionConfigOption>>(),
    );
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

    const getSessionEpoch = (): Effect.Effect<SessionEpoch> => Ref.get(sessionEpochRef);

    const commitPendingBoundedState = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pendingAvailableCommands = yield* Ref.getAndUpdate(
          pendingAvailableCommandsRef,
          () => new Map(),
        );
        const pendingConfigOptions = yield* Ref.getAndUpdate(
          pendingConfigOptionsRef,
          () => new Map(),
        );
        const availableCommands = pendingAvailableCommands.get(sessionId);
        if (availableCommands) {
          yield* Ref.set(availableCommandsRef, availableCommands);
        }
        const configOptions = pendingConfigOptions.get(sessionId);
        if (configOptions) {
          yield* Ref.update(configOptionsRef, (current) =>
            mergeSessionConfigOptions(current, configOptions),
          );
          yield* resolveConfigOptionUpdateWaiters(configOptions);
        }
      });

    const setSessionEpoch = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* commitPendingBoundedState(sessionId);
        yield* Ref.update(sessionEpochRef, (epoch) => ({
          generation: epoch.generation + 1,
          activeSessionId: Option.some(sessionId),
        }));
      });

    const clearSessionEpoch = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(pendingAvailableCommandsRef, new Map());
        yield* Ref.set(pendingConfigOptionsRef, new Map());
        yield* Ref.update(sessionEpochRef, (epoch) => ({
          generation: epoch.generation + 1,
          activeSessionId: Option.none(),
        }));
      });

    const offerSessionEvent =
      (sessionId: string, epoch: SessionEpoch) =>
      (event: AcpParsedSessionEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* getSessionEpoch();
          if (current.generation !== epoch.generation) return;
          if (!isActiveSessionId(sessionId, current)) return;
          sessionUpdatesEnqueued += 1;
          yield* Queue.offer(eventQueue, event);
        });

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
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
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    yield* Effect.addFinalizer(() => teardownAcpChildProcess(child, options.teardownProcessTree));

    const acp = yield* makeOfficialSdkClient(child, runtimeScope, options.protocolLogging);

    const resolveConfigOptionUpdateWaiters = (
      configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
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
        const update = notification.update;

        // While the authoritative session id is unknown (fresh session/new is
        // still pending), only bounded-state notifications are accepted, and
        // they are buffered keyed by the session id they claim. Once session/new
        // returns, only the buffer matching the response id is committed;
        // anything from a discarded probe session is discarded.
        if (Option.isNone(epoch.activeSessionId)) {
          if (update.sessionUpdate === "available_commands_update") {
            yield* Ref.update(pendingAvailableCommandsRef, (map) => {
              const next = new Map(map);
              next.set(sessionId, update.availableCommands);
              return next;
            });
          } else if (update.sessionUpdate === "config_option_update") {
            yield* Ref.update(pendingConfigOptionsRef, (map) => {
              const next = new Map(map);
              next.set(
                sessionId,
                mergeSessionConfigOptions(map.get(sessionId) ?? [], update.configOptions),
              );
              return next;
            });
          }
          return;
        }

        if (!isActiveSessionId(sessionId, epoch)) return;

        const rememberCommands = Effect.gen(function* () {
          if (update.sessionUpdate !== "available_commands_update") return;
          const current = yield* getSessionEpoch();
          if (current.generation !== epoch.generation) return;
          if (!isActiveSessionId(sessionId, current)) return;
          yield* Ref.set(availableCommandsRef, update.availableCommands);
        });
        const rememberConfigOptions = Effect.gen(function* () {
          if (update.sessionUpdate !== "config_option_update") return;
          const current = yield* getSessionEpoch();
          if (current.generation !== epoch.generation) return;
          if (!isActiveSessionId(sessionId, current)) return;
          yield* Ref.set(configOptionsRef, update.configOptions);
          yield* resolveConfigOptionUpdateWaiters(update.configOptions);
        });
        const rememberBoundedState = rememberCommands.pipe(Effect.andThen(rememberConfigOptions));

        // Command and configuration inventories are bounded state, not
        // transcript replay; retain them even while historical session
        // updates are being suppressed.
        yield* rememberBoundedState;
        if (!acceptingSessionUpdates) return;
        const current = yield* getSessionEpoch();
        if (current.generation !== epoch.generation) return;
        if (!isActiveSessionId(sessionId, current)) return;

        const offer = offerSessionEvent(sessionId, epoch);

        return yield* processSessionUpdate({
          getSessionEpoch,
          offer,
          sessionId,
          epoch,
          modeStateRef,
          toolCallsRef,
          assistantSegmentRef,
          runtimeInstanceId,
          params: notification,
        });
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
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: new Error("ACP session runtime has not been started"),
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
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
          return yield* new EffectAcpErrors.AcpRequestError({
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
        return yield* new EffectAcpErrors.AcpRequestError({
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
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const waitForConfigOptionUpdate = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<
      ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      EffectAcpErrors.AcpError
    > =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>();
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
          return yield* new EffectAcpErrors.AcpTransportError({
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
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
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

    const startOnce = Effect.gen(function* () {
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );

      // Tracks whether authenticate has already been run so the on-demand
      // path only retries session setup once.
      const authenticatedRef = yield* Ref.make(false);

      const mcpServers = options.buildMcpServers?.(initializeResult) ?? [];
      const sessionCwd = resolveAcpSessionCwd(options.cwd);

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

        const authenticatePayload = {
          methodId: authMethodId,
          ...(options.authenticateMeta ? { _meta: options.authenticateMeta } : {}),
        } satisfies EffectAcpSchema.AuthenticateRequest;

        yield* runLoggedRequest(
          "authenticate",
          authenticatePayload,
          acp.agent.authenticate(authenticatePayload),
        );

        yield* Ref.set(authenticatedRef, true);
      });

      const cleanupDiscardedAcpSession = (discardedSessionId: string) =>
        Effect.gen(function* () {
          // Stop accepting new transcript updates and bump the session generation so
          // any in-flight handlers that were admitted under the discarded epoch are
          // rejected before they can mutate state or enqueue events.
          acceptingSessionUpdates = false;
          yield* clearSessionEpoch();

          // Drain any events that were already enqueued for the discarded session.
          const queued = Queue.sizeUnsafe(eventQueue);
          for (let i = 0; i < queued; i++) {
            yield* Queue.take(eventQueue);
          }

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
          | EffectAcpSchema.LoadSessionResponse
          | EffectAcpSchema.NewSessionResponse
          | EffectAcpSchema.ResumeSessionResponse;
        let resumedExistingSession = false;
        let sessionSetupMethod: AcpSessionRuntimeStartResult["sessionSetupMethod"] = "new";

        if (options.resumeSessionId) {
          const resumePayload = {
            sessionId: options.resumeSessionId,
            cwd: options.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.ResumeSessionRequest;
          const supportsResume =
            initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
          const supportsLoad = initializeResult.agentCapabilities?.loadSession === true;
          if (!supportsResume && !supportsLoad) {
            return yield* new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage:
                "ACP agent cannot reopen the requested session because it advertises neither session/resume nor session/load.",
            });
          }
          // Resumed/replayed updates are tied to the known session id even before the
          // request returns, so bounded state stays coherent if notifications arrive early.
          yield* setSessionEpoch(options.resumeSessionId);
          const resumed = yield* supportsResume
            ? runLoggedRequest(
                "session/resume",
                resumePayload,
                acp.agent.resumeSession(resumePayload),
              )
            : (() => {
                const loadPayload = {
                  sessionId: options.resumeSessionId,
                  cwd: options.cwd,
                  mcpServers,
                } satisfies EffectAcpSchema.LoadSessionRequest;
                return runLoggedRequest(
                  "session/load",
                  loadPayload,
                  acp.agent.loadSession(loadPayload),
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
          acceptingSessionUpdates = false;
          const createPayload = {
            cwd: options.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
          sessionSetupMethod = "new";

          // On-demand authentication: if the ACP agent returned an empty model
          // list but advertised authentication methods, the session is not yet
          // usable. Close the probe session, discard its updates, then fail so
          // the caller can authenticate and retry with a single live session.
          if (options.authPolicy === "on-demand" && !(yield* Ref.get(authenticatedRef))) {
            const setupConfigOptions = sessionConfigOptionsFromSetup(sessionSetupResult);
            const modelOption = findSessionConfigOption(setupConfigOptions, "model");
            const availableModels = modelOption
              ? collectSessionConfigOptionValues(modelOption)
              : [];
            if (availableModels.length === 0 && (initializeResult.authMethods?.length ?? 0) > 0) {
              yield* cleanupDiscardedAcpSession(created.sessionId);
              return yield* new EffectAcpErrors.AcpRequestError({
                code: -32000,
                errorMessage:
                  "Authentication required: ACP agent returned an empty model list; authenticate and retry session setup.",
                data: { authMethods: initializeResult.authMethods ?? [] },
              });
            }
          }

          // The final session id is now known. Install it and start accepting
          // session updates from this generation onward.
          yield* setSessionEpoch(created.sessionId);
          acceptingSessionUpdates = true;
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
          cwd: sessionCwd,
          mcpServers,
          ...(options.sessionMeta ? { _meta: options.sessionMeta } : {}),
        } satisfies Acp.NewSessionRequest;
        const created = yield* withStartupTimeout(
          "session/new",
          startupTimeouts.sessionSetupMs,
          runAcpFreshSessionSetup(
            runLoggedRequest("session/new", createPayload, acp.agent.createSession(createPayload)),
            options.freshSessionRetry,
          ),
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

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
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
          Effect.flatMap((started) =>
            Ref.get(sessionEpochRef).pipe(
              Effect.flatMap((epoch) => {
                const offer = offerSessionEvent(started.sessionId, epoch);
                const requestPayload = {
                  sessionId: started.sessionId,
                  ...payload,
                } satisfies EffectAcpSchema.PromptRequest;
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
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
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
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
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
          Effect.flatMap((started) => {
            if (!started.modelConfigId) {
              return Ref.get(configOptionsRef).pipe(
                Effect.flatMap((configOptions) =>
                  Effect.fail(
                    new EffectAcpErrors.AcpRequestError({
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
            } satisfies EffectAcpSchema.ForkSessionRequest;
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
      exitCode: child.exitCode.pipe(
        Effect.map((code) => (code == null ? null : Number(code))),
        Effect.catchCause(() =>
          Effect.logError("Failed to read child exit code").pipe(Effect.as(null)),
        ),
      ),
    } satisfies AcpSessionRuntimeShape;
  });

export function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
  fallback: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [],
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? fallback;
}

function mergeSessionConfigOptions(
  current: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  update: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  const byId = new Map(current.map((option) => [option.id, option]));
  for (const option of update) {
    byId.set(option.id, option);
  }
  const result: EffectAcpSchema.SessionConfigOption[] = [];
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
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption>
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectGroup>,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
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
  configUpdate: Effect.Effect<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    EffectAcpErrors.AcpError
  >,
): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> {
  if (isEmptyRecord(response)) {
    return configUpdate.pipe(Effect.map((configOptions) => ({ configOptions })));
  }
  return Schema.decodeUnknownEffect(EffectAcpSchema.SetSessionConfigOptionResponse)(response).pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
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
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  runtimeInstanceId,
  params,
}: {
  readonly getSessionEpoch: () => Effect.Effect<SessionEpoch>;
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly sessionId: string;
  readonly epoch: SessionEpoch;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly runtimeInstanceId: string;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      const current = yield* getSessionEpoch();
      if (current.generation !== epoch.generation) return;
      if (!isActiveSessionId(sessionId, current)) return;
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        const current = yield* getSessionEpoch();
        if (current.generation !== epoch.generation) return;
        if (!isActiveSessionId(sessionId, current)) return;
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
          const current = yield* getSessionEpoch();
          if (current.generation !== epoch.generation) return;
          if (!isActiveSessionId(sessionId, current)) return;
          yield* offer(event);
          continue;
        }
        if (event.text.trim().length === 0) {
          const current = yield* getSessionEpoch();
          if (current.generation !== epoch.generation) return;
          if (!isActiveSessionId(sessionId, current)) return;
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
    const currentEpoch = yield* getSessionEpoch();
    if (currentEpoch.generation !== epoch.generation) {
      return requestedItemId ?? assistantItemId(sessionId, runtimeInstanceId, 0);
    }
    if (!isActiveSessionId(sessionId, currentEpoch)) {
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
    const current = yield* getSessionEpoch();
    if (current.generation !== epoch.generation) return;
    if (!isActiveSessionId(sessionId, current)) return;
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
