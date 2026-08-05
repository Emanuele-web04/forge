// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { Cause, Effect, Exit, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsCompatibilityError,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";

import {
  shouldKeepServerLifecycleStream,
  getUnexpectedStreamCompletionRetryDelayMs,
  getStreamCapacityRetryDelayMs,
  getStreamDuplicateRetryDelayMs,
  getStreamFailureCode,
  getThreadSnapshotBootstrapRetryDelayMs,
  getTerminalCompatibilityError,
  isTerminalCompatibilityFailure,
  makeFeatureSocketUrl,
  makeNegotiateHttpUrl,
  makeRequestAbortScope,
  negotiateOverHttp,
  serverIdentityChanged,
  MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS,
  MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
  resolveStreamAdmissionRetry,
  shouldReconnectAfterStreamFailure,
  threadStreamInputsEqual,
  WsTransport,
  type WsThreadStreamFailure,
} from "./wsTransport";
import {
  addWsCompatibilityIssueListener,
  emitWsCompatibilityIssue,
  readLatestWsCompatibilityIssue,
} from "./wsTransportEvents";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  onSend: ((data: string) => void) | null = null;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
    this.onSend?.(String(data));
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" } as never);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  receive(data: string) {
    this.emit("message", { data });
  }

  // Answers Effect RPC frames so unit tests can complete a feature-socket
  // session: Ping gets a Pong and every request gets a successful void Exit.
  serveVoidRpc() {
    this.onSend = (data) => {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame._tag === "Ping") {
        this.receive(JSON.stringify({ _tag: "Pong" }));
      } else if (frame._tag === "Request" && typeof frame.id === "string") {
        this.receive(
          JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: { _tag: "Success", value: null },
          }),
        );
      }
    };
    this.open();
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

interface WsTransportInternals {
  readonly streamCleanups: Map<string, () => void>;
  readonly streamSettled: Map<string, Promise<void>>;
  readonly streamCapacityRetries: Map<string, number>;
  readonly streamDuplicateRetries: Map<string, number>;
  readonly streamThreadBootstrapRetries: Map<string, number>;
  readonly streamCapacityRetryTimers: Map<string, number>;
  readonly streamCompletionRetries: Map<string, number>;
  readonly streamCompletionRetryTimers: Map<string, number>;
  readonly activeThreadStreamInputs: Map<string, unknown>;
  readonly threadSubscriptions: Map<string, unknown>;
  readonly threadStreamFailureListeners: Set<(failure: WsThreadStreamFailure) => void>;
  disposed: boolean;
  sessionVersion: number;
  reconnect(): Promise<unknown>;
  startStream<T>(
    client: unknown,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: () => void,
  ): void;
  startThreadStream(
    client: unknown,
    threadId: string,
    input: unknown,
    forceRestart?: boolean,
  ): Promise<void>;
  stopStream(key: string, options?: { readonly resetCapacityRetry?: boolean }): Promise<void>;
  emitThreadStreamFailure(failure: WsThreadStreamFailure): void;
}

function makeBareTransport(): {
  readonly transport: WsTransport;
  readonly internals: WsTransportInternals;
} {
  const transport = Object.create(WsTransport.prototype) as WsTransport;
  const internals = transport as unknown as WsTransportInternals;
  Object.assign(internals, {
    streamCleanups: new Map(),
    streamSettled: new Map(),
    streamCapacityRetries: new Map(),
    streamDuplicateRetries: new Map(),
    streamThreadBootstrapRetries: new Map(),
    streamCapacityRetryTimers: new Map(),
    streamCompletionRetries: new Map(),
    streamCompletionRetryTimers: new Map(),
    activeThreadStreamInputs: new Map(),
    threadSubscriptions: new Map(),
    threadStreamFailureListeners: new Set(),
    disposed: false,
    sessionVersion: 1,
    getClientRuntime: () => ({
      runCallback: (
        effect: Effect.Effect<unknown, Error>,
        options: { readonly onExit: (exit: Exit.Exit<unknown, Error>) => void },
      ) =>
        Effect.runCallback(effect, {
          onExit: (exit) => {
            void Promise.resolve().then(() => options.onExit(exit));
          },
        }),
    }),
    reconnect: vi.fn(async () => ({})),
  });
  return { transport, internals };
}

function bindWindowTimersToCurrentGlobals(): void {
  Object.assign(window, {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
}

const NEGOTIATION_RESULT: WsBootstrapNegotiateResult = {
  protocolEpoch: WS_PROTOCOL_EPOCH,
  negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
  serverBuild: "test-server",
  serverInstanceId: "server-instance-1",
  capabilities: ["transport.http-negotiate"],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function waitForSockets(count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && sockets.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(sockets.length).toBeGreaterThanOrEqual(count);
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");
  // Default to an older server without the HTTP negotiate endpoint so
  // connection tests exercise the legacy bootstrap fallback unless they
  // install their own fetch stub.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("http negotiate unavailable"))),
  );

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("returns the completed GitHub provisioning result and emits each progress event", async () => {
    const phase = {
      operationId: "operation-1",
      kind: "phase" as const,
      phase: "cloning" as const,
      message: "Cloning openai/codex",
    };
    const completed = {
      operationId: "operation-1",
      kind: "completed" as const,
      result: {
        operationId: "operation-1",
        repository: "openai/codex",
        workspaceRoot: "/projects/codex",
        projectId: "project-1",
        checkout: "created" as const,
      },
    };
    const emit = vi.fn();
    const transport = Object.create(WsTransport.prototype) as WsTransport;
    Object.assign(transport, {
      emit,
      getClientRuntime: () => ({ runPromise: Effect.runPromise }),
    });
    const runProjectProvisionStream = (
      transport as unknown as {
        runProjectProvisionStream: (
          client: Record<string, () => Stream.Stream<typeof phase | typeof completed>>,
          params: unknown,
        ) => Promise<typeof completed.result>;
      }
    ).runProjectProvisionStream.bind(transport);

    await expect(
      runProjectProvisionStream(
        {
          [WS_METHODS.projectsProvisionFromGitHub]: () => Stream.make(phase, completed),
        },
        { repository: "openai/codex" },
      ),
    ).resolves.toEqual(completed.result);
    expect(emit).toHaveBeenNthCalledWith(1, WS_CHANNELS.projectProvisionProgress, phase);
    expect(emit).toHaveBeenNthCalledWith(2, WS_CHANNELS.projectProvisionProgress, completed);
  });

  it("does not reconnect the socket for typed stream-admission failures", () => {
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({
          code: "STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "THREAD_SNAPSHOT_NOT_FOUND", retryable: false }),
      ),
    ).toBe(false);
    expect(shouldReconnectAfterStreamFailure(Cause.fail(new Error("transient")))).toBe(true);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBe(false);
    expect(
      isTerminalCompatibilityFailure({
        code: "WS_PROTOCOL_INCOMPATIBLE",
        retryable: false,
      }),
    ).toBe(true);
  });

  it("retries capacity-rejected streams in place with the server-provided delay", () => {
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({
          code: "THREAD_STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(1_000);
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "STREAM_CAPACITY_EXCEEDED", retryable: true }),
      ),
    ).toBe(1_000);
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBeNull();
    expect(getStreamCapacityRetryDelayMs(Cause.fail(new Error("transient")))).toBeNull();
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBeNull();
  });

  it("backs off unexpected normal stream completions with a bounded delay", () => {
    expect(getUnexpectedStreamCompletionRetryDelayMs(1)).toBe(100);
    expect(getUnexpectedStreamCompletionRetryDelayMs(2)).toBe(200);
    expect(getUnexpectedStreamCompletionRetryDelayMs(7)).toBe(5_000);
    expect(getUnexpectedStreamCompletionRetryDelayMs(100)).toBe(5_000);
  });

  it("reconnects after an unexpected normal completion instead of reopening a zombie stream", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.domain";
      const snapshots: string[] = [];
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream<string>(
        {},
        key,
        Stream.make("snapshot"),
        (event) => snapshots.push(event),
        restart,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(internals.streamCompletionRetryTimers.has(key)).toBe(true);
      expect(internals.streamCleanups.has(key)).toBe(false);
      expect(snapshots).toEqual(["snapshot"]);

      expect(reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled();
      expect(snapshots).toEqual(["snapshot"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending normal-completion restart when the stream is unsubscribed", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.domain";
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream({}, key, Stream.empty, () => undefined, restart);
      await Promise.resolve();
      await internals.stopStream(key);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(restart).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
      expect(internals.streamCompletionRetryTimers.has(key)).toBe(false);
      expect(internals.streamCompletionRetries.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart a normally-completed stream from a superseded session generation", async () => {
    vi.useFakeTimers();
    bindWindowTimersToCurrentGlobals();
    try {
      const { internals } = makeBareTransport();
      const key = "orchestration.domain";
      const restart = vi.fn();
      const reconnect = vi.mocked(internals.reconnect);

      internals.startStream({}, key, Stream.empty, () => undefined, restart);
      await Promise.resolve();
      internals.sessionVersion += 1;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(restart).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries duplicate-rejected streams in place despite the non-retryable marker", () => {
    const duplicate = Cause.fail({
      code: "STREAM_DUPLICATE_SUBSCRIPTION",
      retryable: false,
    });

    expect(getStreamDuplicateRetryDelayMs(duplicate, 0)).toBe(250);
    expect(
      getStreamDuplicateRetryDelayMs(
        Cause.fail({
          code: "THREAD_STREAM_DUPLICATE_SUBSCRIPTION",
          retryable: false,
          retryAfterMs: 400,
        }),
        1,
      ),
    ).toBe(400);
    expect(
      getStreamDuplicateRetryDelayMs(duplicate, MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS),
    ).toBeNull();
    expect(
      getStreamDuplicateRetryDelayMs(
        Cause.fail({ code: "STREAM_CAPACITY_EXCEEDED", retryable: true }),
        0,
      ),
    ).toBeNull();
    expect(getStreamDuplicateRetryDelayMs(Cause.fail(new Error("transient")), 0)).toBeNull();
  });

  it("keeps duplicate retry admission independent from prior capacity retries", () => {
    const capacity = Cause.fail({
      code: "STREAM_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 1_000,
    });
    const duplicate = Cause.fail({
      code: "STREAM_DUPLICATE_SUBSCRIPTION",
      retryable: false,
    });

    expect(resolveStreamAdmissionRetry(capacity, 5, 0)).toEqual({
      kind: "capacity",
      attempt: 6,
      delayMs: 1_000,
    });
    expect(resolveStreamAdmissionRetry(duplicate, 5, 0)).toEqual({
      kind: "duplicate",
      attempt: 1,
      delayMs: 250,
    });
    expect(
      resolveStreamAdmissionRetry(duplicate, 0, MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS),
    ).toBeNull();
  });

  it("retries a missing draft snapshot until its projection becomes visible", () => {
    const projectionLag = Cause.fail({
      code: "THREAD_SNAPSHOT_NOT_FOUND",
      retryable: false,
    });

    expect(getThreadSnapshotBootstrapRetryDelayMs(projectionLag, 0)).toBe(100);
    expect(resolveStreamAdmissionRetry(projectionLag, 0, 0, 0)).toEqual({
      kind: "thread-bootstrap",
      attempt: 1,
      delayMs: 100,
    });
    expect(
      getThreadSnapshotBootstrapRetryDelayMs(
        projectionLag,
        MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
      ),
    ).toBeNull();
    expect(
      resolveStreamAdmissionRetry(
        projectionLag,
        0,
        0,
        MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
      ),
    ).toBeNull();
  });

  it("extracts the typed failure code used for thread stream failure reporting", () => {
    expect(
      getStreamFailureCode(Cause.fail({ code: "THREAD_SNAPSHOT_NOT_FOUND", retryable: false })),
    ).toBe("THREAD_SNAPSHOT_NOT_FOUND");
    expect(getStreamFailureCode(Cause.fail(new Error("transient")))).toBeNull();
  });

  it("treats structurally identical thread subscribe params as the same input", () => {
    const input = { threadId: "thread-1" };

    expect(threadStreamInputsEqual(input, input)).toBe(true);
    expect(threadStreamInputsEqual(input, { threadId: "thread-1" })).toBe(true);
    expect(threadStreamInputsEqual(input, { threadId: "thread-2" })).toBe(false);
    expect(threadStreamInputsEqual(input, { threadId: "thread-1", extra: true })).toBe(false);
    expect(threadStreamInputsEqual(undefined, { threadId: "thread-1" })).toBe(false);
  });

  it("delivers thread stream failures to listeners until they unsubscribe", () => {
    const { transport, internals } = makeBareTransport();
    const failure: WsThreadStreamFailure = {
      threadId: "thread-failed",
      code: "THREAD_SNAPSHOT_NOT_FOUND",
      error: new Error("snapshot missing"),
    };
    const throwing = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const listener = vi.fn();

    const unsubscribeThrowing = transport.onThreadStreamFailure(throwing);
    const unsubscribe = transport.onThreadStreamFailure(listener);
    internals.emitThreadStreamFailure(failure);

    expect(throwing).toHaveBeenCalledWith(failure);
    expect(listener).toHaveBeenCalledWith(failure);

    unsubscribe();
    unsubscribeThrowing();
    internals.emitThreadStreamFailure(failure);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("waits for a thread stream to settle before resolving unsubscribe", async () => {
    const { transport, internals } = makeBareTransport();
    const threadId = "thread-release-order";
    const key = `orchestration.thread:${threadId}`;
    let settleStream: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settleStream = resolve;
    });
    const cleanup = vi.fn();
    internals.threadSubscriptions.set(threadId, { threadId });
    internals.streamCleanups.set(key, cleanup);
    internals.streamSettled.set(key, settled);

    let unsubscribeResolved = false;
    const unsubscribe = transport
      .request(ORCHESTRATION_WS_METHODS.unsubscribeThread, { threadId })
      .then(() => {
        unsubscribeResolved = true;
      });
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribeResolved).toBe(false);

    settleStream();
    await unsubscribe;
    expect(unsubscribeResolved).toBe(true);
  });

  it("cancels owned capacity retry timers when a stream stops", async () => {
    vi.useFakeTimers();
    try {
      const { transport, internals } = makeBareTransport();
      const key = "orchestration.thread:thread-cancel-retry";
      const retry = vi.fn();
      const timeoutId = window.setTimeout(retry, 1_000);
      internals.streamCapacityRetries.set(key, 2);
      internals.streamCapacityRetryTimers.set(key, timeoutId);

      await transport.request(ORCHESTRATION_WS_METHODS.unsubscribeThread, {
        threadId: "thread-cancel-retry",
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(retry).not.toHaveBeenCalled();
      expect(internals.streamCapacityRetryTimers.has(key)).toBe(false);
      expect(internals.streamCapacityRetries.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stale or duplicate thread restarts replace the active stream", async () => {
    const { internals } = makeBareTransport();
    const threadId = "thread-current-generation";
    const key = `orchestration.thread:${threadId}`;
    const currentInput = { threadId, generation: "current" };
    const staleInput = { threadId, generation: "stale" };
    const cleanup = vi.fn();
    internals.threadSubscriptions.set(threadId, currentInput);
    internals.streamCleanups.set(key, cleanup);
    internals.activeThreadStreamInputs.set(key, currentInput);

    await internals.startThreadStream({}, threadId, staleInput);
    await internals.startThreadStream({}, threadId, currentInput);

    expect(cleanup).not.toHaveBeenCalled();
    expect(internals.streamCleanups.get(key)).toBe(cleanup);
  });

  it("force-restarts an identical live thread stream for a fresh snapshot", async () => {
    const { internals } = makeBareTransport();
    const threadId = "thread-force-snapshot";
    const key = `orchestration.thread:${threadId}`;
    const input = { threadId };
    const cleanup = vi.fn();
    const subscribeThread = vi.fn(() => ({}));
    const stopStream = vi.fn(async () => {
      internals.streamCleanups.delete(key);
      internals.activeThreadStreamInputs.delete(key);
    });
    const startStream = vi.fn();
    Object.assign(internals, {
      disposed: false,
      sessionVersion: 7,
      stopStream,
      startStream,
    });
    internals.threadSubscriptions.set(threadId, input);
    internals.streamCleanups.set(key, cleanup);
    internals.activeThreadStreamInputs.set(key, input);

    await internals.startThreadStream(
      { [ORCHESTRATION_WS_METHODS.subscribeThread]: subscribeThread },
      threadId,
      input,
      true,
    );

    expect(stopStream).toHaveBeenCalledWith(key, { resetCapacityRetry: false });
    expect(subscribeThread).toHaveBeenCalledWith(input);
    expect(startStream).toHaveBeenCalledWith(
      expect.anything(),
      key,
      {},
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("treats an explicit identical thread subscribe as a forced snapshot refresh", async () => {
    const { transport, internals } = makeBareTransport();
    const threadId = "thread-explicit-snapshot";
    const input = { threadId };
    const client = {};
    const startThreadStream = vi.fn(async () => undefined);
    Object.assign(internals, {
      disposed: false,
      getClient: vi.fn(async () => client),
      startThreadStream,
    });
    internals.threadSubscriptions.set(threadId, input);

    await transport.request(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId });

    expect(startThreadStream).toHaveBeenCalledWith(client, threadId, input, true);
  });

  it("latches terminal compatibility guidance for late UI subscribers", () => {
    const issue = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    const listener = vi.fn();

    emitWsCompatibilityIssue(issue);
    const unsubscribe = addWsCompatibilityIssueListener(listener, { replayCurrent: true });

    expect(readLatestWsCompatibilityIssue()).toBe(issue);
    expect(listener).toHaveBeenCalledWith(issue);
    expect(getTerminalCompatibilityError(issue)).toBe(issue);

    unsubscribe();
    emitWsCompatibilityIssue(null);
  });

  it("owns request deadlines and external aborts without leaving timers active", async () => {
    vi.useFakeTimers();
    try {
      const deadline = makeRequestAbortScope({ timeoutMs: 25 });
      expect(deadline.signal?.aborted).toBe(false);
      expect(deadline.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      expect(deadline.signal?.aborted).toBe(true);
      expect(deadline.didTimeout()).toBe(true);
      deadline.cleanup();
      deadline.cleanup();

      const external = new AbortController();
      const cancelled = makeRequestAbortScope({ timeoutMs: 1_000, signal: external.signal });
      external.abort(new Error("cancelled by caller"));
      expect(cancelled.signal?.aborted).toBe(true);
      expect(cancelled.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(cancelled.didTimeout()).toBe(false);
      cancelled.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shared lifecycle stream while either lifecycle channel is active", () => {
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverMaintenanceUpdated]))).toBe(
      true,
    );
    expect(
      shouldKeepServerLifecycleStream(
        new Set([WS_CHANNELS.serverWelcome, WS_CHANNELS.serverMaintenanceUpdated]),
      ),
    ).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(false);
  });

  it("falls back to the legacy bootstrap socket when HTTP negotiation is unavailable", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    expect(transport.getState()).toBe("connecting");
    await waitForSockets(1);
    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
  });

  it("detects a server identity change across a failed reconnect", () => {
    // The negotiated compatibility is cleared on every failed reconnect, so
    // the comparison must use the last identity actually reached — otherwise a
    // restore whose downtime outlasts the first retry keeps stale cursors,
    // which is the case this guard exists for.
    expect(serverIdentityChanged(null, "instance-a")).toBe(false);
    expect(serverIdentityChanged("instance-a", "instance-a")).toBe(false);
    expect(serverIdentityChanged("instance-a", "instance-b")).toBe(true);
  });

  it("negotiates over HTTP so a connect opens only the feature socket", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request) =>
      Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    await waitForSockets(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const negotiateUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(negotiateUrl.protocol).toBe("http:");
    expect(negotiateUrl.pathname).toBe("/ws/negotiate");
    expect(negotiateUrl.searchParams.get(WS_NEGOTIATE_QUERY.protocolEpoch)).toBe(
      String(WS_PROTOCOL_EPOCH),
    );
    expect(sockets).toHaveLength(1);
    const featureUrl = new URL(sockets[0]!.url);
    expect(featureUrl.pathname).toBe("/ws");
    expect(featureUrl.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      NEGOTIATION_RESULT.serverInstanceId,
    );

    await transport.dispose();
  });

  it("surfaces a 426 HTTP negotiation refusal as a terminal compatibility error", async () => {
    const refusal = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(426, JSON.parse(JSON.stringify(refusal))))),
    );

    await expect(negotiateOverHttp("ws://localhost:3020")).rejects.toSatisfy((error) =>
      isTerminalCompatibilityFailure(error),
    );
    // A non-426 failure (older server, transient outage) must fall back to the
    // legacy bootstrap socket instead of failing the connect.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(404, null))),
    );
    await expect(negotiateOverHttp("ws://localhost:3020")).resolves.toBeNull();
  });

  it("falls back to bootstrap when the negotiate request never settles", async () => {
    // A connection that accepts and then stalls (WAN/tunnel black hole) must
    // not wedge the transport: browsers apply no default fetch timeout, so
    // without an abort signal the bootstrap fallback would never run.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );

    await expect(negotiateOverHttp("ws://localhost:3020")).resolves.toBeNull();
  }, 10_000);

  it("aborts a stalled negotiate when the caller's lifetime signal fires", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );

    const negotiation = negotiateOverHttp("ws://localhost:3020", controller.signal);
    controller.abort();
    // Resolves well before the 5s deadline because disposal, not the timeout,
    // ended the request.
    await expect(negotiation).resolves.toBeNull();
  });

  it("does not create a bootstrap socket when disposed during negotiation", async () => {
    // dispose() captures a null runtime and returns while the HTTP request is
    // still pending; the transport must not build one afterwards.
    let abortNegotiation: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            abortNegotiation = () =>
              reject(new DOMException("The operation was aborted.", "AbortError"));
            init?.signal?.addEventListener("abort", () => abortNegotiation?.());
          }),
      ),
    );

    const transport = new WsTransport();
    // subscribeShell reaches getClient(), so the request genuinely drives the
    // connect path rather than relying on the constructor's eager session.
    const connecting = transport
      .request(ORCHESTRATION_WS_METHODS.subscribeShell, {})
      .catch(() => null);
    await Promise.resolve();
    const socketsBefore = sockets.length;

    await transport.dispose();
    await connecting;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sockets.length).toBe(socketsBefore);
  }, 10_000);

  it("uses the desktop bridge URL before falling back to the browser location", async () => {
    const getWsUrl = vi.fn().mockReturnValue("ws://127.0.0.1:53036/?token=old");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", port: "3020" },
        desktopBridge: { getWsUrl },
      },
    });

    const transport = new WsTransport();
    await waitForSockets(1);

    expect(getWsUrl).toHaveBeenCalled();
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws/bootstrap?token=old");

    await transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", async () => {
    const transport = new WsTransport();
    await waitForSockets(1);

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
  });

  it("reuses cached negotiation on reconnect while the server instance is unchanged", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)));
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    const internals = transport as unknown as {
      createSession(): { clientPromise: Promise<unknown> };
      probeFeatureConnection: (...args: unknown[]) => Promise<void>;
      compatibility: WsBootstrapNegotiateResult | null;
    };
    await waitForSockets(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(internals.compatibility).toEqual(NEGOTIATION_RESULT);

    const probe = vi.fn(async () => undefined);
    internals.probeFeatureConnection = probe;
    await internals.createSession().clientPromise;

    // Reconnect on the same server generation opens exactly one new socket and
    // performs no renegotiation round trip — only the liveness probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    const reconnectUrl = new URL(sockets[1]!.url);
    expect(reconnectUrl.pathname).toBe("/ws");
    expect(reconnectUrl.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      NEGOTIATION_RESULT.serverInstanceId,
    );

    await transport.dispose();
  });

  it("renegotiates and resets replayed push state when the server instance changed", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)));
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    const internals = transport as unknown as {
      createSession(): { clientPromise: Promise<unknown> };
      compatibility: WsBootstrapNegotiateResult | null;
      latestPushByChannel: Map<string, unknown>;
      sequence: number;
    };
    await waitForSockets(1);
    internals.latestPushByChannel.set("server.welcome", { stale: true });
    internals.sequence = 7;

    // A failed session clears the cache (probe or socket failure), so the next
    // reconnect renegotiates and lands on the restarted server generation.
    internals.compatibility = null;
    const restarted = { ...NEGOTIATION_RESULT, serverInstanceId: "server-instance-2" };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, restarted)));
    await internals.createSession().clientPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(internals.compatibility).toEqual(restarted);
    expect(internals.latestPushByChannel.size).toBe(0);
    expect(internals.sequence).toBe(0);
    const reconnectUrl = new URL(sockets[1]!.url);
    expect(reconnectUrl.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      "server-instance-2",
    );

    await transport.dispose();
  });

  it("clears cached negotiation when the reconnect liveness probe fails", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, NEGOTIATION_RESULT)));
    vi.stubGlobal("fetch", fetchMock);

    const transport = new WsTransport("ws://localhost:3020");
    const internals = transport as unknown as {
      createSession(): { clientPromise: Promise<unknown> };
      probeFeatureConnection: (...args: unknown[]) => Promise<void>;
      compatibility: WsBootstrapNegotiateResult | null;
    };
    await waitForSockets(1);
    expect(internals.compatibility).toEqual(NEGOTIATION_RESULT);

    internals.probeFeatureConnection = async function (this: typeof internals) {
      this.compatibility = null;
      throw new Error("stale server generation");
    }.bind(internals);
    await expect(internals.createSession().clientPromise).rejects.toThrow(
      "stale server generation",
    );

    expect(internals.compatibility).toBeNull();

    await transport.dispose();
  });

  it("mirrors the negotiate endpoint onto the WS host with an HTTP scheme", () => {
    const url = new URL(makeNegotiateHttpUrl("wss://remote.example:8443/?token=old"));

    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("remote.example:8443");
    expect(url.pathname).toBe("/ws/negotiate");
    expect(url.searchParams.get("token")).toBe("old");
    expect(url.searchParams.get(WS_NEGOTIATE_QUERY.minRevision)).toBe(
      String(WS_PROTOCOL_MIN_REVISION),
    );
    expect(url.searchParams.get(WS_NEGOTIATE_QUERY.maxRevision)).toBe(
      String(WS_PROTOCOL_MAX_REVISION),
    );
  });

  it("pins the feature socket to the negotiated revision and server generation", () => {
    const resolved = new URL(
      makeFeatureSocketUrl("ws://127.0.0.1:53036/?token=old", {
        protocolEpoch: WS_PROTOCOL_EPOCH,
        negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
        serverBuild: "0.5.2",
        serverInstanceId: "server-instance",
        capabilities: ["orchestration.cursor-safe-streams"],
      }),
    );

    expect(resolved.pathname).toBe("/ws");
    expect(resolved.searchParams.get("token")).toBe("old");
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision)).toBe(
      String(WS_PROTOCOL_MAX_REVISION),
    );
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      "server-instance",
    );
  });

  it("notifies state listeners and replays the current state on demand", async () => {
    const transport = new WsTransport();
    const listener = vi.fn();

    const unsubscribe = transport.onStateChange(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledWith("connecting");

    listener.mockClear();
    await transport.dispose();

    expect(listener).toHaveBeenCalledWith("disposed");

    listener.mockClear();
    unsubscribe();
    await transport.dispose();

    expect(listener).not.toHaveBeenCalled();
  });
});
