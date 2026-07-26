// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { Cause } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_COMPATIBILITY_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsCompatibilityError,
} from "@synara/contracts";

import {
  shouldKeepServerLifecycleStream,
  getStreamCapacityRetryDelayMs,
  getStreamDuplicateRetryDelayMs,
  getStreamFailureCode,
  getThreadSnapshotBootstrapRetryDelayMs,
  getTerminalCompatibilityError,
  isTerminalCompatibilityFailure,
  makeFeatureSocketUrl,
  makeRequestAbortScope,
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
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
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
  readonly activeThreadStreamInputs: Map<string, unknown>;
  readonly threadSubscriptions: Map<string, unknown>;
  readonly threadStreamFailureListeners: Set<(failure: WsThreadStreamFailure) => void>;
  startThreadStream(
    client: unknown,
    threadId: string,
    input: unknown,
    forceRestart?: boolean,
  ): Promise<void>;
  stopStream(key: string, options?: { readonly resetCapacityRetry?: boolean }): Promise<void>;
  startStream(...args: unknown[]): void;
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
    activeThreadStreamInputs: new Map(),
    threadSubscriptions: new Map(),
    threadStreamFailureListeners: new Set(),
  });
  return { transport, internals };
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");

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
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
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

  it("opens the stable bootstrap endpoint before the feature RPC socket", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");
    expect(transport.getState()).toBe("connecting");

    await transport.dispose();
  });

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

    expect(getWsUrl).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws/bootstrap?token=old");

    await transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", async () => {
    const transport = new WsTransport();

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
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
