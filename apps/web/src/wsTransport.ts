// FILE: wsTransport.ts
// Purpose: Browser-side Effect RPC transport over the Synara WebSocket endpoint.
// Layer: Web transport
// Exports: WsTransport plus stream-selection helpers used by tests.

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_CHANNELS,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_CAPABILITIES,
  WS_METHODS,
  WsBootstrapRpcGroup,
  WsCompatibilityError,
  WsFeatureRpcGroup,
  type AutomationStreamEvent,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ProjectDevServerEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type TerminalEvent,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Schema, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { APP_VERSION } from "./branding";
import type { WsTransportState } from "./wsTransportEvents";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WsTransportRequestInterruptedError extends Data.TaggedError(
  "WsTransportRequestInterruptedError",
)<{
  readonly message: string;
  readonly code: "WS_REQUEST_TIMEOUT" | "WS_REQUEST_ABORTED";
  readonly method: string;
  readonly timeoutMs?: number;
  readonly cause?: unknown;
}> {}

export interface WsRequestOptions {
  readonly timeoutMs?: number | null;
  readonly signal?: AbortSignal;
}

interface RequestAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
}

export function makeRequestAbortScope(options?: WsRequestOptions): RequestAbortScope {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("WebSocket RPC timeoutMs must be a finite non-negative number or null.");
    }
  }
  if (timeoutMs === undefined || timeoutMs === null) {
    return {
      signal: options?.signal,
      didTimeout: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let cleanedUp = false;
  const externalSignal = options?.signal;
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeoutId = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      globalThis.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function awaitWithAbort<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const makeRpcClient = RpcClient.make(WsFeatureRpcGroup);
const makeBootstrapRpcClient = RpcClient.make(WsBootstrapRpcGroup);
const REQUEST_TIMEOUT_MS = 60_000;

function resolveRpcUrl(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  url.pathname = path;
  return url.toString();
}

function rawSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return explicitUrl;
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  return bridgeUrl && bridgeUrl.length > 0
    ? bridgeUrl
    : envUrl && envUrl.length > 0
      ? envUrl
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
}

function makeSocketUrl(explicitUrl: string | null, path: string): string {
  return resolveRpcUrl(rawSocketUrl(explicitUrl), path);
}

export function makeFeatureSocketUrl(
  explicitUrl: string | null,
  compatibility: WsBootstrapNegotiateResult,
): string {
  const url = new URL(makeSocketUrl(explicitUrl, WS_FEATURE_PATH));
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, APP_VERSION);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(compatibility.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(compatibility.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, compatibility.serverInstanceId);
  return url.toString();
}

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  // JSON keeps the wire format symmetric with any server build: a serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs web and server on independently-built copies.
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

const STREAM_ADMISSION_ERROR_CODES = new Set([
  "STREAM_DUPLICATE_SUBSCRIPTION",
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
  "THREAD_SNAPSHOT_NOT_FOUND",
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
]);
const TERMINAL_COMPATIBILITY_ERROR_CODES = new Set([
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
]);

export function isTerminalCompatibilityFailure(error: unknown): boolean {
  return (
    (Schema.is(WsCompatibilityError)(error) && error.retryable === false) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      TERMINAL_COMPATIBILITY_ERROR_CODES.has(error.code))
  );
}

export function getTerminalCompatibilityError(error: unknown): WsCompatibilityError | null {
  return Schema.is(WsCompatibilityError)(error) && error.retryable === false ? error : null;
}

export function shouldReconnectAfterStreamFailure(cause: Cause.Cause<unknown>): boolean {
  return !cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? error.code : undefined;
    return typeof code === "string" && STREAM_ADMISSION_ERROR_CODES.has(code);
  });
}

const RETRYABLE_STREAM_CAPACITY_ERROR_CODES = new Set([
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
]);
const DEFAULT_STREAM_CAPACITY_RETRY_MS = 1_000;
const MAX_STREAM_CAPACITY_RETRY_MS = 10_000;

/**
 * Capacity rejections are admission failures the server marks retryable: the
 * budget frees up as soon as another lease releases, so the stream must be
 * retried in place rather than dropped or escalated to a socket reconnect.
 */
export function getStreamCapacityRetryDelayMs(cause: Cause.Cause<unknown>): number | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !RETRYABLE_STREAM_CAPACITY_ERROR_CODES.has(code)) continue;
    if ("retryable" in error && error.retryable === false) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_STREAM_CAPACITY_RETRY_MS;
  }
  return null;
}

const RETRYABLE_STREAM_DUPLICATE_ERROR_CODES = new Set([
  "STREAM_DUPLICATE_SUBSCRIPTION",
  "THREAD_STREAM_DUPLICATE_SUBSCRIPTION",
]);
const DEFAULT_STREAM_DUPLICATE_RETRY_MS = 250;
export const MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS = 5;
const THREAD_SNAPSHOT_BOOTSTRAP_ERROR_CODE = "THREAD_SNAPSHOT_NOT_FOUND";
const DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS = 100;
export const MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS = 12;

/**
 * Duplicate rejections arrive marked `retryable: false` because one socket may
 * not hold two leases for the same stream. A cancel→fast-resubscribe still
 * races the server-side lease release (the lease frees only when the server
 * stream scope closes), so a bounded in-place retry is required to let the
 * stale lease drain instead of leaving the stream permanently dead.
 */
export function getStreamDuplicateRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !RETRYABLE_STREAM_DUPLICATE_ERROR_CODES.has(code)) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_STREAM_DUPLICATE_RETRY_MS;
  }
  return null;
}

/**
 * A visible local draft subscribes before its `thread.create` projection exists
 * so it cannot miss the first provider events. The event journal and projection
 * commit independently, leaving a short window where that valid subscription
 * receives THREAD_SNAPSHOT_NOT_FOUND. Retry only that admission race in place;
 * bounded attempts still surface genuinely missing or deleted thread ids.
 */
export function getThreadSnapshotBootstrapRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (code !== THREAD_SNAPSHOT_BOOTSTRAP_ERROR_CODE) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS;
  }
  return null;
}

export type StreamAdmissionRetry =
  | { readonly kind: "capacity"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "duplicate"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "thread-bootstrap"; readonly attempt: number; readonly delayMs: number };

export function resolveStreamAdmissionRetry(
  cause: Cause.Cause<unknown>,
  capacityAttempts: number,
  duplicateAttempts: number,
  threadBootstrapAttempts = 0,
): StreamAdmissionRetry | null {
  const capacityDelayMs = getStreamCapacityRetryDelayMs(cause);
  if (capacityDelayMs !== null) {
    return {
      kind: "capacity",
      attempt: capacityAttempts + 1,
      delayMs: capacityDelayMs,
    };
  }
  const duplicateDelayMs = getStreamDuplicateRetryDelayMs(cause, duplicateAttempts);
  if (duplicateDelayMs !== null) {
    return {
      kind: "duplicate",
      attempt: duplicateAttempts + 1,
      delayMs: duplicateDelayMs,
    };
  }
  const threadBootstrapDelayMs = getThreadSnapshotBootstrapRetryDelayMs(
    cause,
    threadBootstrapAttempts,
  );
  if (threadBootstrapDelayMs === null) return null;
  return {
    kind: "thread-bootstrap",
    attempt: threadBootstrapAttempts + 1,
    delayMs: threadBootstrapDelayMs,
  };
}

export function getStreamFailureCode(cause: Cause.Cause<unknown>): string | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string") return code;
  }
  return null;
}

const THREAD_STREAM_KEY_PREFIX = "orchestration.thread:";

function threadIdFromStreamKey(key: string): string | null {
  return key.startsWith(THREAD_STREAM_KEY_PREFIX)
    ? key.slice(THREAD_STREAM_KEY_PREFIX.length)
    : null;
}

export function threadStreamInputsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([key, value]) => (right as Record<string, unknown>)[key] === value);
}

export interface WsThreadStreamFailure {
  readonly threadId: string;
  readonly code: string | null;
  readonly error: Error;
}

function omitNullUserInputAnswers(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const command = input as { type?: unknown; answers?: unknown };
  if (command.type !== "thread.user-input.respond" || !command.answers) {
    return input;
  }
  if (typeof command.answers !== "object") {
    return input;
  }
  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}

export function isServerLifecyclePushChannel(channel: string): boolean {
  return channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated;
}

export function shouldKeepServerLifecycleStream(activeChannels: ReadonlySet<string>): boolean {
  return (
    activeChannels.has(WS_CHANNELS.serverWelcome) ||
    activeChannels.has(WS_CHANNELS.serverMaintenanceUpdated)
  );
}

export class WsTransport {
  private readonly explicitUrl: string | null;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly stateListeners = new Set<(state: WsTransportState) => void>();
  private readonly compatibilityListeners = new Set<(issue: WsCompatibilityError | null) => void>();
  private readonly threadStreamFailureListeners = new Set<
    (failure: WsThreadStreamFailure) => void
  >();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private sessionVersion = 0;
  private state: WsTransportState = "connecting";
  private disposed = false;
  private readonly runtimeByClient = new WeakMap<
    RpcClientInstance,
    ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>
  >();
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private clientScope: Scope.Closeable;
  private clientPromise: Promise<RpcClientInstance>;
  private reconnectPromise: Promise<RpcClientInstance> | null = null;
  private reconnectFailures = 0;
  private readonly streamCleanups = new Map<string, () => void>();
  private readonly streamSettled = new Map<string, Promise<void>>();
  private readonly streamCapacityRetries = new Map<string, number>();
  private readonly streamDuplicateRetries = new Map<string, number>();
  private readonly streamThreadBootstrapRetries = new Map<string, number>();
  private readonly streamCapacityRetryTimers = new Map<string, number>();
  private readonly activeThreadStreamInputs = new Map<string, unknown>();
  private shellSubscribed = false;
  private readonly threadSubscriptions = new Map<string, unknown>();
  private compatibility: WsBootstrapNegotiateResult | null = null;
  private compatibilityIssue: WsCompatibilityError | null = null;

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    const session = this.createSession();
    this.runtime = session.runtime;
    this.clientScope = session.clientScope;
    this.clientPromise = session.clientPromise;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: WsRequestOptions,
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const requestOptions: WsRequestOptions =
      options?.timeoutMs === undefined ? { ...options, timeoutMs: REQUEST_TIMEOUT_MS } : options;
    const abortScope = makeRequestAbortScope(requestOptions);
    try {
      if (method === ORCHESTRATION_WS_METHODS.unsubscribeShell) {
        this.shellSubscribed = false;
        await awaitWithAbort(this.stopStream("orchestration.shell"), abortScope.signal);
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.threadSubscriptions.delete(threadId);
        await awaitWithAbort(
          this.stopStream(`orchestration.thread:${threadId}`),
          abortScope.signal,
        );
        return undefined as T;
      }

      const client = await awaitWithAbort(this.getClient(), abortScope.signal);

      if (method === WS_METHODS.gitRunStackedAction) {
        return (await this.runGitActionStream(client, params, abortScope.signal)) as T;
      }

      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        this.shellSubscribed = true;
        this.resetStreamCapacityRetry("orchestration.shell");
        this.startShellStream(client);
        return undefined as T;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.resetStreamCapacityRetry(`orchestration.thread:${threadId}`);
        // Preserve the stored input identity across explicit refreshes so stale
        // restart callbacks cannot supersede the newly requested stream.
        const existingInput = this.threadSubscriptions.get(threadId);
        const input = threadStreamInputsEqual(existingInput, params) ? existingInput : params;
        this.threadSubscriptions.set(threadId, input);
        await this.startThreadStream(client, threadId, input as never, true);
        return undefined as T;
      }

      const rpcInput =
        method === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? (params as { command: unknown }).command
          : (params ?? {});
      const normalizedRpcInput = omitNullUserInputAnswers(rpcInput);
      const call = (
        client as unknown as Record<
          string,
          (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
        >
      )[method];
      if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
      const clientRuntime = this.getClientRuntime(client);
      return (await clientRuntime.runPromise(
        call(normalizedRpcInput),
        abortScope.signal ? { signal: abortScope.signal } : undefined,
      )) as T;
    } catch (error) {
      if (abortScope.didTimeout()) {
        throw new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} timed out after ${requestOptions.timeoutMs}ms.`,
          code: "WS_REQUEST_TIMEOUT",
          method,
          ...(requestOptions.timeoutMs !== undefined && requestOptions.timeoutMs !== null
            ? { timeoutMs: requestOptions.timeoutMs }
            : {}),
          cause: error,
        });
      }
      if (requestOptions.signal?.aborted) {
        throw new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} was cancelled.`,
          code: "WS_REQUEST_ABORTED",
          method,
          cause: requestOptions.signal.reason ?? error,
        });
      }
      throw error;
    } finally {
      abortScope.cleanup();
    }
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  onStateChange(
    listener: (state: WsTransportState) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.stateListeners.add(listener);
    if (options?.replayCurrent) {
      listener(this.state);
    }

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.state;
  }

  getCompatibility(): WsBootstrapNegotiateResult | null {
    return this.compatibility;
  }

  onCompatibilityIssue(
    listener: (issue: WsCompatibilityError | null) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.compatibilityListeners.add(listener);
    if (options?.replayCurrent) listener(this.compatibilityIssue);
    return () => {
      this.compatibilityListeners.delete(listener);
    };
  }

  /** Fires when a per-thread stream dies with no retry or reconnect left. */
  onThreadStreamFailure(listener: (failure: WsThreadStreamFailure) => void): () => void {
    this.threadStreamFailureListeners.add(listener);
    return () => {
      this.threadStreamFailureListeners.delete(listener);
    };
  }

  private emitThreadStreamFailure(failure: WsThreadStreamFailure): void {
    for (const listener of this.threadStreamFailureListeners) {
      try {
        listener(failure);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.setState("disposed");
    this.resetAllStreamCapacityRetries();
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    this.activeThreadStreamInputs.clear();
    this.threadStreamFailureListeners.clear();
    // Dispose can race with initial connection or reconnect promises. Mark them
    // handled before closing the runtime so test/browser teardown stays quiet.
    void this.clientPromise.catch(() => undefined);
    void this.reconnectPromise?.catch(() => undefined);
    const runtime = this.runtime;
    const clientScope = this.clientScope;
    await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
    await runtime.dispose().catch(() => undefined);
  }

  private createSession() {
    const sessionVersion = ++this.sessionVersion;
    const runtime = ManagedRuntime.make(
      makeProtocolLayer(makeSocketUrl(this.explicitUrl, WS_BOOTSTRAP_PATH)),
    );
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = (async () => {
      let compatibility: WsBootstrapNegotiateResult;
      try {
        const bootstrapClient = await runtime.runPromise(
          Scope.provide(clientScope)(makeBootstrapRpcClient),
        );
        compatibility = await runtime.runPromise(
          bootstrapClient[WS_BOOTSTRAP_METHOD]({
            protocolEpoch: WS_PROTOCOL_EPOCH,
            minRevision: WS_PROTOCOL_MIN_REVISION,
            maxRevision: WS_PROTOCOL_MAX_REVISION,
            clientBuild: APP_VERSION,
            requiredCapabilities: [...WS_SERVER_CAPABILITIES],
          }),
        );
      } finally {
        await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
        await runtime.dispose().catch(() => undefined);
      }
      if (this.disposed || this.sessionVersion !== sessionVersion) {
        throw new Error("WebSocket session superseded during compatibility negotiation.");
      }

      const featureRuntime = ManagedRuntime.make(
        makeProtocolLayer(makeFeatureSocketUrl(this.explicitUrl, compatibility)),
      );
      const featureScope = featureRuntime.runSync(Scope.make());
      this.runtime = featureRuntime;
      this.clientScope = featureScope;
      const client = await featureRuntime.runPromise(Scope.provide(featureScope)(makeRpcClient));
      this.runtimeByClient.set(client, featureRuntime);
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        if (
          this.compatibility &&
          this.compatibility.serverInstanceId !== compatibility.serverInstanceId
        ) {
          this.latestPushByChannel.clear();
          this.sequence = 0;
        }
        this.compatibility = compatibility;
        this.setCompatibilityIssue(null);
        this.setState("open");
      }
      return client;
    })().catch((error) => {
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        this.compatibility = null;
        const compatibilityError = getTerminalCompatibilityError(error);
        if (compatibilityError) {
          this.setCompatibilityIssue(compatibilityError);
          this.setState("incompatible");
        } else {
          this.setState("closed");
        }
      }
      throw error;
    });
    return { runtime, clientScope, clientPromise };
  }

  private async getClient(): Promise<RpcClientInstance> {
    try {
      return await this.clientPromise;
    } catch (error) {
      if (this.disposed) throw new Error("Transport disposed");
      if (isTerminalCompatibilityFailure(error)) throw error;
      return this.reconnect();
    }
  }

  private getClientRuntime(
    client: RpcClientInstance,
  ): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    const runtime = this.runtimeByClient.get(client);
    if (!runtime) {
      throw new Error("Missing runtime for WebSocket RPC client");
    }
    return runtime;
  }

  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;

    const oldRuntime = this.runtime;
    const oldClientScope = this.clientScope;
    this.resetAllStreamCapacityRetries();
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    this.activeThreadStreamInputs.clear();

    this.setState("connecting");

    void oldRuntime
      .runPromise(Scope.close(oldClientScope, Exit.void))
      .catch(() => undefined)
      .finally(() => {
        void oldRuntime.dispose().catch(() => undefined);
      });

    this.reconnectPromise = this.openReconnectSession().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private setState(state: WsTransportState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break reconnect or RPC state transitions.
      }
    }
  }

  private clearStreamCapacityRetryTimer(key: string): void {
    const timeoutId = this.streamCapacityRetryTimers.get(key);
    if (timeoutId === undefined) return;
    window.clearTimeout(timeoutId);
    this.streamCapacityRetryTimers.delete(key);
  }

  private resetStreamCapacityRetry(key: string): void {
    this.clearStreamCapacityRetryTimer(key);
    this.streamCapacityRetries.delete(key);
    this.streamDuplicateRetries.delete(key);
    this.streamThreadBootstrapRetries.delete(key);
  }

  private resetAllStreamCapacityRetries(): void {
    for (const timeoutId of this.streamCapacityRetryTimers.values()) {
      window.clearTimeout(timeoutId);
    }
    this.streamCapacityRetryTimers.clear();
    this.streamCapacityRetries.clear();
    this.streamDuplicateRetries.clear();
    this.streamThreadBootstrapRetries.clear();
  }

  private setCompatibilityIssue(issue: WsCompatibilityError | null): void {
    if (this.compatibilityIssue === issue) return;
    this.compatibilityIssue = issue;
    for (const listener of this.compatibilityListeners) {
      try {
        listener(issue);
      } catch {
        // Compatibility UI listeners must not break transport teardown.
      }
    }
  }

  private async openReconnectSession(): Promise<RpcClientInstance> {
    const delayMs = Math.min(500 * 2 ** this.reconnectFailures, 5_000);
    this.reconnectFailures += 1;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.createSession();
    this.runtime = session.runtime;
    this.clientScope = session.clientScope;
    this.clientPromise = session.clientPromise;

    const client = await session.clientPromise;
    this.reconnectFailures = 0;
    for (const channel of this.listeners.keys()) {
      this.startChannelStream(channel as WsPushChannel);
    }
    if (this.shellSubscribed) {
      this.startShellStream(client);
    }
    for (const [threadId, input] of this.threadSubscriptions) {
      await this.startThreadStream(client, threadId, input);
    }
    return client;
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): void {
    void this.getClient()
      .then((client) => {
        const restartChannel = () => {
          if (this.listeners.has(channel)) {
            this.startChannelStream(channel);
          }
        };

        if (isServerLifecyclePushChannel(channel)) {
          this.startLifecycleStream(client);
        } else if (channel === WS_CHANNELS.serverConfigUpdated) {
          this.startStream(
            client,
            "server.config",
            client[WS_METHODS.subscribeServerConfig]({}),
            (event: ServerConfigStreamEvent) => {
              if (event.type === "snapshot") {
                this.emit(WS_CHANNELS.serverConfigUpdated, {
                  issues: event.config.issues,
                  providers: event.config.providers,
                });
              } else if (event.type === "configUpdated") {
                this.emit(WS_CHANNELS.serverConfigUpdated, event.payload);
              }
            },
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            client,
            "server.providers",
            client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            client,
            "server.settings",
            client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.terminalEvent) {
          this.startStream(
            client,
            "terminal.events",
            client[WS_METHODS.subscribeTerminalEvents]({}),
            (event: TerminalEvent) => this.emit(WS_CHANNELS.terminalEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.projectDevServerEvent) {
          this.startStream(
            client,
            "project.devServers",
            client[WS_METHODS.subscribeProjectDevServerEvents]({}),
            (event: ProjectDevServerEvent) => this.emit(WS_CHANNELS.projectDevServerEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.automationEvent) {
          this.startStream(
            client,
            "automation.events",
            client[WS_METHODS.subscribeAutomationEvents]({}),
            (event: AutomationStreamEvent) => this.emit(WS_CHANNELS.automationEvent, event),
            restartChannel,
          );
        } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
          this.startStream(
            client,
            "orchestration.domain",
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
            (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
            restartChannel,
          );
        }
      })
      .catch((error) => {
        if (
          !this.disposed &&
          this.listeners.has(channel) &&
          !isTerminalCompatibilityFailure(error)
        ) {
          console.warn("WebSocket RPC channel failed to start", error);
          window.setTimeout(() => this.startChannelStream(channel), 500);
        }
      });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (isServerLifecyclePushChannel(channel)) {
      if (!this.shouldKeepLifecycleStream()) this.stopStream("server.lifecycle");
    } else if (channel === WS_CHANNELS.serverConfigUpdated) this.stopStream("server.config");
    else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.terminalEvent) this.stopStream("terminal.events");
    else if (channel === WS_CHANNELS.projectDevServerEvent) this.stopStream("project.devServers");
    else if (channel === WS_CHANNELS.automationEvent) this.stopStream("automation.events");
    else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent)
      this.stopStream("orchestration.domain");
  }

  private shouldKeepLifecycleStream(): boolean {
    return shouldKeepServerLifecycleStream(new Set(this.listeners.keys()));
  }

  private startLifecycleStream(client: RpcClientInstance): void {
    const restartLifecycle = () => {
      if (!this.shouldKeepLifecycleStream()) return;
      void this.getClient()
        .then((nextClient) => this.startLifecycleStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC lifecycle stream failed to restart", error));
    };
    this.startStream(
      client,
      "server.lifecycle",
      client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
      restartLifecycle,
    );
  }

  private startShellStream(client: RpcClientInstance): void {
    const restartShell = () => {
      if (!this.shellSubscribed) return;
      void this.getClient()
        .then((nextClient) => this.startShellStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC shell stream failed to restart", error));
    };
    this.startStream(
      client,
      "orchestration.shell",
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      (event: OrchestrationShellStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event),
      restartShell,
    );
  }

  private async startThreadStream(
    client: RpcClientInstance,
    threadId: string,
    input: unknown,
    forceRestart = false,
  ): Promise<void> {
    const key = `orchestration.thread:${threadId}`;
    if (this.disposed || this.threadSubscriptions.get(threadId) !== input) {
      return;
    }
    if (
      !forceRestart &&
      this.streamCleanups.has(key) &&
      this.activeThreadStreamInputs.get(key) === input
    ) {
      return;
    }
    const sessionVersion = this.sessionVersion;
    await this.stopStream(key, { resetCapacityRetry: false });
    if (
      this.disposed ||
      this.sessionVersion !== sessionVersion ||
      this.threadSubscriptions.get(threadId) !== input
    ) {
      return;
    }
    const restartThread = () => {
      const desiredInput = this.threadSubscriptions.get(threadId);
      if (desiredInput === undefined) return;
      void this.getClient()
        .then((nextClient) => this.startThreadStream(nextClient, threadId, desiredInput))
        .catch((error) => console.warn("WebSocket RPC thread stream failed to restart", error));
    };
    this.activeThreadStreamInputs.set(key, input);
    this.startStream(
      client,
      key,
      client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
      restartThread,
    );
  }

  private startStream<T>(
    client: RpcClientInstance,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: (() => void) | undefined,
  ): void {
    if (this.streamCleanups.has(key)) return;
    this.clearStreamCapacityRetryTimer(key);
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const cancel = this.getClientRuntime(client).runCallback(
      Stream.runForEach(runnableStream, (event) =>
        Effect.sync(() => {
          if (this.streamCapacityRetries.has(key)) {
            this.streamCapacityRetries.delete(key);
          }
          if (this.streamDuplicateRetries.has(key)) {
            this.streamDuplicateRetries.delete(key);
          }
          if (this.streamThreadBootstrapRetries.has(key)) {
            this.streamThreadBootstrapRetries.delete(key);
          }
          listener(event);
        }),
      ),
      {
        onExit: (exit) => {
          if (this.streamSettled.get(key) === settled) {
            this.streamSettled.delete(key);
          }
          resolveSettled();
          const wasReplacedOrStopped = this.streamCleanups.get(key) !== cancel;
          if (!wasReplacedOrStopped) {
            this.streamCleanups.delete(key);
            this.activeThreadStreamInputs.delete(key);
          }
          if (wasReplacedOrStopped || this.disposed) {
            return;
          }
          if (restart && Exit.isFailure(exit)) {
            const admissionRetry = resolveStreamAdmissionRetry(
              exit.cause,
              this.streamCapacityRetries.get(key) ?? 0,
              this.streamDuplicateRetries.get(key) ?? 0,
              this.streamThreadBootstrapRetries.get(key) ?? 0,
            );
            if (admissionRetry !== null) {
              const retries =
                admissionRetry.kind === "capacity"
                  ? this.streamCapacityRetries
                  : admissionRetry.kind === "duplicate"
                    ? this.streamDuplicateRetries
                    : this.streamThreadBootstrapRetries;
              retries.set(key, admissionRetry.attempt);
              this.clearStreamCapacityRetryTimer(key);
              const timeoutId = window.setTimeout(
                () => {
                  if (this.streamCapacityRetryTimers.get(key) !== timeoutId) return;
                  this.streamCapacityRetryTimers.delete(key);
                  if (!this.disposed && !this.streamCleanups.has(key)) {
                    restart();
                  }
                },
                Math.min(
                  admissionRetry.delayMs * admissionRetry.attempt,
                  MAX_STREAM_CAPACITY_RETRY_MS,
                ),
              );
              this.streamCapacityRetryTimers.set(key, timeoutId);
              return;
            }
          }
          if (restart && Exit.isFailure(exit) && shouldReconnectAfterStreamFailure(exit.cause)) {
            window.setTimeout(
              () => {
                if (!this.disposed && !this.streamCleanups.has(key)) {
                  void this.reconnect()
                    .then(() => restart())
                    .catch((error) => {
                      if (!this.disposed) {
                        console.warn("WebSocket RPC stream reconnect failed", error);
                      }
                    });
                }
              },
              Cause.hasInterruptsOnly(exit.cause) ? 0 : 500,
            );
            return;
          }
          if (Exit.isFailure(exit) && !this.disposed && !Cause.hasInterruptsOnly(exit.cause)) {
            const error = causeToError(exit.cause);
            console.warn("WebSocket RPC stream failed", error);
            const threadId = threadIdFromStreamKey(key);
            if (threadId !== null && this.threadSubscriptions.has(threadId)) {
              this.emitThreadStreamFailure({
                threadId,
                code: getStreamFailureCode(exit.cause),
                error,
              });
            }
          }
        },
      },
    );
    this.streamCleanups.set(key, cancel);
    this.streamSettled.set(key, settled);
  }

  private stopStream(
    key: string,
    options?: { readonly resetCapacityRetry?: boolean },
  ): Promise<void> {
    this.clearStreamCapacityRetryTimer(key);
    if (options?.resetCapacityRetry !== false) {
      this.streamCapacityRetries.delete(key);
      this.streamDuplicateRetries.delete(key);
      this.streamThreadBootstrapRetries.delete(key);
    }
    this.activeThreadStreamInputs.delete(key);
    const cleanup = this.streamCleanups.get(key);
    const settled = this.streamSettled.get(key) ?? Promise.resolve();
    if (!cleanup) return settled;
    this.streamCleanups.delete(key);
    cleanup();
    return settled;
  }

  private async runGitActionStream(
    client: RpcClientInstance,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<GitRunStackedActionResult> {
    let result: GitRunStackedActionResult | null = null;
    await this.getClientRuntime(client).runPromise(
      Stream.runForEach(client[WS_METHODS.gitRunStackedAction](params as never), (event) =>
        Effect.sync(() => {
          this.emit(WS_CHANNELS.gitActionProgress, event as GitActionProgressEvent);
          if ((event as GitActionProgressEvent).kind === "action_finished") {
            result = (event as Extract<GitActionProgressEvent, { kind: "action_finished" }>).result;
          }
        }),
      ),
      signal ? { signal } : undefined,
    );
    if (!result) throw new Error("Git action stream completed without a final result.");
    return result;
  }
}
