// FILE: DevinAdapter.test.ts
// Purpose: Compact adapter/runtime contract tests for Devin session configuration,
// model discovery, and plan-mode fail-closed behavior.
// Layer: Provider adapter tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import { ThreadId, TurnId } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Semaphore, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpRequestError, AcpTransportError } from "../acp/AcpErrors.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { ServerConfig } from "../../config.ts";
import * as AcpErrors from "../acp/AcpErrors.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import type { DevinAcpRuntimeInput } from "../acp/DevinAcpSupport.ts";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import { DevinAdapter } from "../Services/DevinAdapter.ts";
import {
  applyDevinSessionConfiguration,
  buildDevinPromptMeta,
  buildDevinStaticModelDescriptors,
  canRecoverDevinWedge,
  closeDevinSessionResources,
  evaluateDevinWedgeSignal,
  makeCachedDevinModelDiscovery,
  mergeDevinModelDescriptors,
  makeDevinAdapterLive,
  parseDevinCliModelList,
  pruneDevinToolCallTurnIds,
  resolveDevinAdapterTimeouts,
  resolveDevinEffectiveModel,
  resolveDevinOptionalTimeoutMs,
  resolveDevinWedgeRecoveryOptions,
  resolveDevinStartModel,
  resolveDevinToolCallUpdatedTurnId,
  resolveRequestedModeId,
} from "./DevinAdapter.ts";

const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeFakeAcpRuntime(initialModeState?: {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string }>;
}): {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getModeState" | "setMode">;
  readonly calls: Array<{ method: string; args: ReadonlyArray<unknown> }>;
} {
  const calls: Array<{ method: string; args: ReadonlyArray<unknown> }> = [];
  let modeState = initialModeState;

  const runtime = {
    getModeState: Effect.sync(() =>
      modeState
        ? {
            currentModeId: modeState.currentModeId,
            availableModes: modeState.availableModes,
          }
        : undefined,
    ),
    setMode: (modeId: string) =>
      Effect.sync(() => {
        calls.push({ method: "setMode", args: [modeId] });
        if (modeState) {
          modeState = { ...modeState, currentModeId: modeId };
        }
        return {} as Acp.SetSessionModeResponse;
      }),
  };
  return { runtime, calls };
}

function makeLifecycleAcpRuntime(
  prompt: AcpSessionRuntimeShape["prompt"] = () =>
    Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse),
): AcpSessionRuntimeShape {
  const registerHandler = () => Effect.void;
  return {
    handleRequestPermission: registerHandler,
    handleElicitation: registerHandler,
    handleReadTextFile: registerHandler,
    handleWriteTextFile: registerHandler,
    handleCreateTerminal: registerHandler,
    handleTerminalOutput: registerHandler,
    handleTerminalWaitForExit: registerHandler,
    handleTerminalKill: registerHandler,
    handleTerminalRelease: registerHandler,
    handleSessionUpdate: registerHandler,
    handleElicitationComplete: registerHandler,
    handleExtRequest: registerHandler,
    handleExtNotification: registerHandler,
    start: () =>
      Effect.succeed({
        sessionId: "devin-test-session",
        initializeResult: {} as Acp.InitializeResponse,
        sessionSetupResult: {} as Acp.NewSessionResponse,
        modelConfigId: undefined,
        sessionSetupMethod: "new",
      }),
    awaitExit: Effect.never,
    getEvents: () => Stream.never,
    sessionUpdatesEnqueuedCount: Effect.succeed(0),
    supportsSessionFork: Effect.succeed(false),
    supportsSessionRecovery: Effect.succeed(true),
    getModeState: Effect.succeed({
      currentModeId: "bypass",
      availableModes: [{ id: "bypass", name: "Full Access" }],
    }),
    getSessionEpoch: () => Effect.succeed(0 as never),
    getPendingSessionNotificationCount: () => Effect.succeed(0),
    getConfigOptions: Effect.succeed([]),
    getAvailableCommands: Effect.succeed([]),
    awaitLoadReplayReady: Effect.void,
    prompt,
    cancel: Effect.void,
    setMode: () => Effect.succeed({} as Acp.SetSessionModeResponse),
    setConfigOption: () => Effect.succeed({} as Acp.SetSessionConfigOptionResponse),
    setModel: () => Effect.void,
    forkSession: () => Effect.succeed({} as Acp.ForkSessionResponse),
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
  } as AcpSessionRuntimeShape;
}

function makeEventAcpRuntime(prompt: AcpSessionRuntimeShape["prompt"]) {
  type EventEnvelope = {
    readonly event: AcpParsedSessionEvent;
    readonly processed: Deferred.Deferred<void>;
  };
  const events = Effect.runSync(Queue.unbounded<EventEnvelope>());
  const pendingCompletions: Array<Deferred.Deferred<void>> = [];
  const runtime = makeLifecycleAcpRuntime(prompt);
  const emit = (event: AcpParsedSessionEvent) =>
    Effect.gen(function* () {
      const processed = yield* Deferred.make<void>();
      yield* Queue.offer(events, { event, processed });
      yield* flushTimers();
      yield* Deferred.await(processed);
    });
  return {
    runtime: {
      ...runtime,
      getEvents: () =>
        Stream.fromQueue(events).pipe(
          Stream.map(({ event, processed }) => {
            pendingCompletions.push(processed);
            return event;
          }),
        ),
    } as AcpSessionRuntimeShape,
    emitToolCall: (toolCallId: string, status: "pending" | "inProgress" | "completed" | "failed") =>
      emit({
        _tag: "ToolCallUpdated",
        toolCall: { toolCallId, status, data: {} },
        rawPayload: { toolCallId, status },
      }),
    emitProgress: (text = "progress") =>
      emit({
        _tag: "ContentDelta",
        text,
        rawPayload: { text },
      }),
    completeProcessedEvent: () => {
      const processed = pendingCompletions.shift();
      if (processed !== undefined) {
        Effect.runSync(Deferred.succeed(processed, undefined));
      }
    },
  };
}

function advanceTimers(ms: number): Effect.Effect<void> {
  return Effect.promise(() => vi.advanceTimersByTimeAsync(ms));
}

function flushTimers(): Effect.Effect<void> {
  return advanceTimers(0);
}

function makeDevinAdapterTestLayer(
  runtime: AcpSessionRuntimeShape,
  onSessionUpdateProcessed?: () => void,
  timeouts: { turnIdleMs: number; toolIdleMs: number } = { turnIdleMs: 30, toolIdleMs: 60 },
  wedgeRecovery?: {
    stallFuseMs: number;
    spawnStallTimeoutMs: number;
    checkIntervalMs: number;
    maxPerThread: number;
    windowMs: number;
  },
) {
  return makeDevinAdapterLive(
    {},
    {
      makeAcpRuntime: () => Effect.succeed(runtime),
      timeouts,
      ...(wedgeRecovery ? { wedgeRecovery } : {}),
      ...(onSessionUpdateProcessed ? { onSessionUpdateProcessed } : {}),
    },
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "devin-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

interface WedgeRuntimePlan {
  /** Prompt behavior per prompt CALL (task, continuation, task, ...), in order. Last entry repeats. */
  readonly prompts: ReadonlyArray<AcpSessionRuntimeShape["prompt"]>;
  /** When present, the makeAcpRuntime call at this index fails instead. */
  readonly failStartAtIndex?: number;
  readonly beforeCreate?: (index: number) => Effect.Effect<void>;
  readonly cancel?: (index: number) => Effect.Effect<void>;
}

function makeWedgeRuntimeFactory(plan: WedgeRuntimePlan) {
  const promptInputs: Array<string> = [];
  const stderrTaps: Array<(line: string) => void> = [];
  let callIndex = 0;
  let promptCallIndex = 0;
  let current: ReturnType<typeof makeEventAcpRuntime> | undefined;
  const makeAcpRuntime = (input: DevinAcpRuntimeInput) => {
    const index = callIndex++;
    if (plan.failStartAtIndex === index) {
      return Effect.fail(
        new AcpErrors.AcpSpawnError({ command: "devin", cause: new Error("start failed") }),
      );
    }
    const handles = makeEventAcpRuntime((params) => {
      promptInputs.push(
        (params.prompt ?? [])
          .map((part: { type: string; text?: string }) => (part.type === "text" ? part.text : ""))
          .join(""),
      );
      const behavior = plan.prompts[Math.min(promptCallIndex, plan.prompts.length - 1)]!;
      promptCallIndex++;
      return behavior(params);
    });
    if (input.onChildStderrLine) stderrTaps.push(input.onChildStderrLine);
    current = handles;
    return (plan.beforeCreate?.(index) ?? Effect.void).pipe(
      Effect.as({ ...handles.runtime, cancel: plan.cancel?.(index) ?? handles.runtime.cancel }),
    );
  };
  return {
    makeAcpRuntime,
    promptInputs,
    stderrTaps,
    emitToolCall: (...args: Parameters<ReturnType<typeof makeEventAcpRuntime>["emitToolCall"]>) =>
      current!.emitToolCall(...args),
    completeProcessedEvent: () => current!.completeProcessedEvent(),
  };
}

const WEDGE_TEST_OPTIONS = {
  stallFuseMs: 90,
  spawnStallTimeoutMs: 30,
  checkIntervalMs: 5,
  maxPerThread: 3,
  windowMs: 60_000,
};

const STALL_WATCH_LINE =
  "2026-09-02T04:02:26.184938Z  WARN affogato::stall_watch: waited_secs=30 what=emit(Subagent) to agent event channel Agent pipeline await still pending";
const SPAWN_START_LINE =
  "2026-09-02T04:43:31.297484Z  INFO toolbox::tools::exec::session_manager: session_id=abc123 [create_session] starting";
const SPAWN_READY_LINE =
  "2026-09-02T04:43:31.297623Z  INFO toolbox::tools::exec::session_manager: session_id=abc123 [create_session] waiting for shell ready";

const stripHarnessPrefix = (text: string): string =>
  text.replace(/^<synara_host_context>[\s\S]*?<\/synara_host_context>/, "");

/** Advance past the supervisor tick, the fuse, and the recovery's resume-replay gate. */
function advanceThroughRecovery(): Effect.Effect<void> {
  return advanceTimers(
    WEDGE_TEST_OPTIONS.stallFuseMs + WEDGE_TEST_OPTIONS.checkIntervalMs * 2 + 2_000,
  );
}

function makeWedgeTestLayer(factory: ReturnType<typeof makeWedgeRuntimeFactory>) {
  return makeDevinAdapterLive(
    {},
    {
      makeAcpRuntime: factory.makeAcpRuntime,
      onSessionUpdateProcessed: factory.completeProcessedEvent,
      timeouts: { turnIdleMs: 3_600_000, toolIdleMs: 3_600_000 },
      wedgeRecovery: WEDGE_TEST_OPTIONS,
    },
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "devin-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("resolveDevinAdapterTimeouts", () => {
  it("uses the production defaults when overrides are absent", () => {
    expect(resolveDevinAdapterTimeouts({})).toEqual({
      turnIdleMs: 30 * 60 * 1000,
      toolIdleMs: 60 * 60 * 1000,
    });
  });

  it("uses valid environment overrides", () => {
    expect(
      resolveDevinAdapterTimeouts({
        SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS: "1234",
        SYNARA_DEVIN_TOOL_IDLE_TIMEOUT_MS: "5678",
      }),
    ).toEqual({ turnIdleMs: 1234, toolIdleMs: 5678 });
  });
});

describe("resolveDevinOptionalTimeoutMs", () => {
  it("falls back to the default when unset or invalid", () => {
    expect(resolveDevinOptionalTimeoutMs({ envVar: "X", defaultMs: 100, env: {} })).toBe(100);
    expect(resolveDevinOptionalTimeoutMs({ envVar: "X", defaultMs: 100, env: { X: "   " } })).toBe(
      100,
    );
    expect(resolveDevinOptionalTimeoutMs({ envVar: "X", defaultMs: 100, env: { X: "abc" } })).toBe(
      100,
    );
    expect(resolveDevinOptionalTimeoutMs({ envVar: "X", defaultMs: 100, env: { X: "-5" } })).toBe(
      100,
    );
  });

  it("treats zero as an explicit disable and passes positive values through", () => {
    expect(resolveDevinOptionalTimeoutMs({ envVar: "X", defaultMs: 100, env: { X: "0" } })).toBe(0);
    expect(resolveDevinOptionalTimeoutMs({ envVar: "X", defaultMs: 100, env: { X: "250" } })).toBe(
      250,
    );
  });

  it("resolves the production wedge defaults", () => {
    expect(resolveDevinWedgeRecoveryOptions({})).toMatchObject({
      stallFuseMs: 90_000,
      spawnStallTimeoutMs: 30_000,
      maxPerThread: 3,
    });
  });
});

describe("evaluateDevinWedgeSignal", () => {
  const base = {
    activeTurnId: "turn-1",
    awaitingHuman: false,
    stallWatchDetectedAt: undefined,
    spawnStalls: new Map<string, number>(),
    now: 10_000,
    stallFuseMs: 90,
    spawnStallTimeoutMs: 30,
  };

  it("is silent without an active turn or while awaiting a human", () => {
    expect(evaluateDevinWedgeSignal({ ...base, activeTurnId: undefined })).toBeUndefined();
    expect(evaluateDevinWedgeSignal({ ...base, awaitingHuman: true })).toBeUndefined();
  });

  it("fires the stall-watch signal only after the fuse elapses", () => {
    expect(evaluateDevinWedgeSignal({ ...base, stallWatchDetectedAt: 9_990 })).toBeUndefined();
    expect(evaluateDevinWedgeSignal({ ...base, stallWatchDetectedAt: 9_000 })).toEqual({
      kind: "stall-watch",
      silentMs: 1_000,
    });
  });

  it("ignores the stall-watch path when the fuse is disabled", () => {
    expect(
      evaluateDevinWedgeSignal({ ...base, stallWatchDetectedAt: 0, stallFuseMs: 0 }),
    ).toBeUndefined();
  });

  it("fires the spawn-stall signal for the oldest un-ready spawn", () => {
    const spawnStalls = new Map([
      ["aaa", 9_000],
      ["bbb", 9_990],
    ]);
    expect(evaluateDevinWedgeSignal({ ...base, spawnStalls })).toEqual({
      kind: "spawn-stall",
      spawnSessionId: "aaa",
      stalledMs: 1_000,
    });
  });

  it("ignores spawns inside the budget and respects the disable flag", () => {
    expect(
      evaluateDevinWedgeSignal({ ...base, spawnStalls: new Map([["aaa", 9_990]]) }),
    ).toBeUndefined();
    expect(
      evaluateDevinWedgeSignal({
        ...base,
        spawnStalls: new Map([["aaa", 0]]),
        spawnStallTimeoutMs: 0,
      }),
    ).toBeUndefined();
  });
});

describe("canRecoverDevinWedge", () => {
  const base = { now: 100_000, maxPerWindow: 3, windowMs: 30_000 };

  it("allows recoveries inside the budget and blocks beyond it", () => {
    expect(canRecoverDevinWedge({ ...base, recoveryAt: [] })).toBe(true);
    expect(canRecoverDevinWedge({ ...base, recoveryAt: [90_000, 95_000] })).toBe(true);
    expect(canRecoverDevinWedge({ ...base, recoveryAt: [80_000, 90_000, 95_000] })).toBe(false);
  });

  it("forgets recoveries that fell out of the rolling window", () => {
    expect(canRecoverDevinWedge({ ...base, recoveryAt: [0, 1_000, 2_000] })).toBe(true);
  });
});

describe("Devin wedge auto-recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["fiber-interrupt", "cancel-response"] as const)(
    "recovers a stall-watch wedge with %s: cancels the turn, restarts, and continues",
    async (settlement) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const cancelledResponse = Effect.runSync(Deferred.make<Acp.PromptResponse>());
      const factory = makeWedgeRuntimeFactory({
        prompts: [
          () =>
            settlement === "cancel-response" ? Deferred.await(cancelledResponse) : Effect.never,
          () => Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse),
        ],
        cancel: () =>
          settlement === "cancel-response"
            ? Deferred.succeed(cancelledResponse, {
                stopReason: "cancelled",
              } as Acp.PromptResponse).pipe(Effect.andThen(flushTimers()))
            : Effect.void,
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* DevinAdapter;
          const threadId = ThreadId.makeUnsafe("thread-devin-wedge-stall");
          const runtimeEvents: Array<{
            type: string;
            turnId?: string | undefined;
            payload?: Record<string, unknown> | undefined;
          }> = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() =>
                runtimeEvents.push({
                  type: event.type,
                  ...(event.turnId !== undefined ? { turnId: String(event.turnId) } : {}),
                  payload: event.payload as Record<string, unknown> | undefined,
                }),
              ),
            ),
            Effect.forkScoped,
          );
          yield* adapter.startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
          });
          const wedgedTurn = yield* adapter.sendTurn({
            threadId,
            input: "do the task",
            attachments: [],
          });
          yield* flushTimers();
          expect(factory.stderrTaps.length).toBe(1);
          factory.stderrTaps[0]!(STALL_WATCH_LINE);
          yield* advanceThroughRecovery();
          expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["do the task", "continue"]);
          expect(factory.stderrTaps.length).toBe(2);
          const session = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
          expect(session?.status).toBe("ready");
          const warning = runtimeEvents.find((event) => event.type === "runtime.warning");
          expect(String(warning?.payload?.message)).toContain(
            "restarting this session automatically",
          );
          const settled = runtimeEvents.find(
            (event) =>
              event.type === "turn.completed" &&
              event.turnId === String(wedgedTurn.turnId) &&
              event.payload?.state === "cancelled",
          );
          expect(settled?.payload?.stopReason).toBe("synara.devin.wedge-recovery");
        }).pipe(Effect.scoped, Effect.provide(makeWedgeTestLayer(factory))),
      );
    },
  );

  it("recovers a spawn-stall wedge when a command never reaches shell-ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const factory = makeWedgeRuntimeFactory({
      prompts: [
        () => Effect.never,
        () => Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse),
      ],
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-wedge-spawn");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        yield* adapter.sendTurn({ threadId, input: "run it", attachments: [] });
        yield* flushTimers();
        factory.stderrTaps[0]!(SPAWN_START_LINE);
        yield* advanceTimers(WEDGE_TEST_OPTIONS.checkIntervalMs);
        expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["run it"]);
        yield* advanceThroughRecovery();
        expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["run it", "continue"]);
      }).pipe(Effect.provide(makeWedgeTestLayer(factory))),
    );
  });

  it("does not recover when the spawn reaches shell-ready or progress resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const factory = makeWedgeRuntimeFactory({
      prompts: [() => Effect.never],
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-wedge-quiet");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        yield* adapter.sendTurn({ threadId, input: "work", attachments: [] });
        yield* flushTimers();
        factory.stderrTaps[0]!(SPAWN_START_LINE);
        factory.stderrTaps[0]!(SPAWN_READY_LINE);
        yield* advanceTimers(10_000);
        expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["work"]);
        expect(factory.stderrTaps.length).toBe(1);
        factory.stderrTaps[0]!(STALL_WATCH_LINE);
        yield* factory.emitToolCall("tool-1", "inProgress");
        factory.completeProcessedEvent();
        yield* advanceTimers(10_000);
        expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["work"]);
      }).pipe(Effect.provide(makeWedgeTestLayer(factory))),
    );
  });

  it("fails the turn instead of recovering once the thread budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const wedged = () => Effect.never;
    const healthy = () => Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse);
    const factory = makeWedgeRuntimeFactory({
      prompts: [wedged, healthy, wedged, healthy, wedged, healthy, wedged],
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-wedge-budget");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        for (let wedge = 0; wedge < 4; wedge++) {
          yield* adapter.sendTurn({ threadId, input: `task ${wedge}`, attachments: [] });
          yield* flushTimers();
          factory.stderrTaps[factory.stderrTaps.length - 1]!(STALL_WATCH_LINE);
          yield* advanceThroughRecovery();
        }
        expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual([
          "task 0",
          "continue",
          "task 1",
          "continue",
          "task 2",
          "continue",
          "task 3",
        ]);
        const session = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
        expect(session?.status).toBe("error");
      }).pipe(Effect.provide(makeWedgeTestLayer(factory))),
    );
  });

  it.each(["interrupt", "interrupt-current", "stop", "stop-all", "restart"] as const)(
    "honors %s while recovery is waiting to create the replacement session",
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const entered = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const factory = makeWedgeRuntimeFactory({
        prompts: [() => Effect.never],
        beforeCreate: (index) =>
          index === 1
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* DevinAdapter;
          const threadId = ThreadId.makeUnsafe(`thread-wedge-cancel-${action}`);
          const input = {
            provider: "devin" as const,
            threadId,
            runtimeMode: "full-access" as const,
            cwd: process.cwd(),
          };
          const events: Array<{ type: string }> = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkScoped,
          );
          yield* adapter.startSession(input);
          const turn = yield* adapter.sendTurn({ threadId, input: "task", attachments: [] });
          yield* flushTimers();
          factory.stderrTaps[0]!(STALL_WATCH_LINE);
          yield* advanceTimers(100);
          yield* Deferred.await(entered);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          const actionFiber = yield* (
            action === "stop-all"
              ? adapter.stopAll()
              : action === "stop"
                ? adapter.stopSession(threadId)
                : action === "restart"
                  ? adapter.startSession(input).pipe(Effect.asVoid)
                  : adapter.interruptTurn(
                      threadId,
                      action === "interrupt" ? turn.turnId : undefined,
                    )
          ).pipe(Effect.forkScoped);
          yield* flushTimers();
          yield* Deferred.succeed(release, undefined);
          yield* advanceThroughRecovery();
          yield* Fiber.join(actionFiber);
          expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["task"]);
          expect(yield* adapter.hasSession(threadId)).toBe(action === "restart");
          expect(events.filter((event) => event.type === "runtime.error")).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(makeWedgeTestLayer(factory))),
      );
    },
  );

  it.each(["user-turn", "stale-interrupt", "interrupt"] as const)(
    "preserves %s ownership while the replacement is draining resume replay",
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const factory = makeWedgeRuntimeFactory({
        prompts: [
          () => Effect.never,
          () => Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse),
        ],
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* DevinAdapter;
          const threadId = ThreadId.makeUnsafe(`thread-wedge-replay-${action}`);
          yield* adapter.startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
          });
          const turn = yield* adapter.sendTurn({ threadId, input: "task", attachments: [] });
          yield* flushTimers();
          factory.stderrTaps[0]!(STALL_WATCH_LINE);
          yield* advanceTimers(100);
          expect(factory.stderrTaps).toHaveLength(2);
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["task"]);
          const userAction = yield* (
            action === "user-turn"
              ? adapter
                  .sendTurn({ threadId, input: "new user task", attachments: [] })
                  .pipe(Effect.asVoid)
              : adapter.interruptTurn(
                  threadId,
                  action === "interrupt" ? turn.turnId : asTurnId("unrelated-turn"),
                )
          ).pipe(Effect.forkScoped);
          yield* advanceThroughRecovery();
          yield* Fiber.join(userAction);
          expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(
            action === "interrupt"
              ? ["task"]
              : ["task", action === "user-turn" ? "new user task" : "continue"],
          );
          expect(yield* adapter.hasSession(threadId)).toBe(action !== "interrupt");
        }).pipe(Effect.scoped, Effect.provide(makeWedgeTestLayer(factory))),
      );
    },
  );

  it("honors user cancellation while the recovery cancel notification is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const factory = makeWedgeRuntimeFactory({
      prompts: [() => Effect.never],
      cancel: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const completions: Array<unknown> = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "turn.completed") completions.push(event.payload);
            }),
          ),
          Effect.forkScoped,
        );
        const threadId = ThreadId.makeUnsafe("thread-wedge-cancel-notification");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "task", attachments: [] });
        yield* flushTimers();
        factory.stderrTaps[0]!(STALL_WATCH_LINE);
        yield* advanceTimers(100);
        yield* Deferred.await(entered);
        const cancelled = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkScoped);
        yield* flushTimers();
        yield* Deferred.succeed(release, undefined);
        yield* advanceThroughRecovery();
        yield* Fiber.join(cancelled);
        expect(completions).toEqual([
          expect.objectContaining({ state: "cancelled", stopReason: "cancelled" }),
        ]);
        expect(factory.stderrTaps).toHaveLength(1);
        expect(factory.promptInputs.map(stripHarnessPrefix)).toEqual(["task"]);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }).pipe(Effect.scoped, Effect.provide(makeWedgeTestLayer(factory))),
    );
  });

  it("leaves no session when the recovery restart itself fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const factory = makeWedgeRuntimeFactory({
      prompts: [() => Effect.never],
      failStartAtIndex: 1,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-wedge-restart-fail");
        const events: Array<{
          type: string;
          turnId?: TurnId | undefined;
          payload: Record<string, unknown>;
        }> = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() =>
              events.push({
                type: event.type,
                turnId: event.turnId,
                payload: event.payload as Record<string, unknown>,
              }),
            ),
          ),
          Effect.forkScoped,
        );
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "task", attachments: [] });
        yield* flushTimers();
        factory.stderrTaps[0]!(STALL_WATCH_LINE);
        yield* advanceTimers(
          WEDGE_TEST_OPTIONS.stallFuseMs + WEDGE_TEST_OPTIONS.checkIntervalMs * 2,
        );
        expect(
          (yield* adapter.listSessions()).find((s) => s.threadId === threadId),
        ).toBeUndefined();
        expect(
          events.filter((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
        ).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ state: "cancelled" }) }),
        ]);
        expect(events.filter((event) => event.type === "runtime.error")).toEqual([
          expect.objectContaining({
            turnId: turn.turnId,
            payload: expect.objectContaining({
              message: expect.stringContaining("start failed"),
              detail: { reason: "synara.devin.wedge-recovery" },
            }),
          }),
        ]);
      }).pipe(Effect.scoped, Effect.provide(makeWedgeTestLayer(factory))),
    );
  });
});

describe("Devin adapter lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an overlapping send without replacing the active turn", async () => {
    const promptStarted = await Effect.runPromise(Deferred.make<void>());
    const runtime = makeLifecycleAcpRuntime(() =>
      Deferred.succeed(promptStarted, undefined).pipe(Effect.andThen(Effect.never)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-overlap");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const firstTurn = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
        yield* Deferred.await(promptStarted);
        const duplicateError = yield* adapter
          .sendTurn({ threadId, input: "second", attachments: [] })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
        expect(duplicateError).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "sendTurn",
        });
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "running", activeTurnId: firstTurn.turnId });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const readySession = (yield* adapter.listSessions()).find(
          (session) => session.threadId === threadId,
        );
        expect(readySession?.activeTurnId).toBeUndefined();
        expect(readySession?.status).toBe("ready");
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(
          // Real timers: keep the watchdog's first check (5s cadence at these
          // budgets) far beyond the assertion window instead of racing it.
          makeDevinAdapterTestLayer(runtime, undefined, {
            turnIdleMs: 3_600_000,
            toolIdleMs: 3_600_000,
          }),
        ),
      ),
    );
  });

  it("keeps tool budget for every active tool and ignores terminal regressions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { runtime, emitToolCall, completeProcessedEvent } = makeEventAcpRuntime(
      () => Effect.never,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-tool-budget");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "run tools", attachments: [] });
        for (const [toolCallId, status] of [
          ["tool-a", "pending"],
          ["tool-b", "inProgress"],
          ["tool-a", "completed"],
          ["tool-a", "pending"],
        ] as const) {
          yield* emitToolCall(toolCallId, status);
        }
        yield* advanceTimers(30);
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "running", activeTurnId: turn.turnId });
        yield* emitToolCall("tool-b", "failed");
        yield* advanceTimers(30);
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "error" });
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(makeDevinAdapterTestLayer(runtime, completeProcessedEvent))),
    );
  });

  it("does not let stale prior-turn tool updates refresh or extend the current turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const firstPrompt = Effect.runSync(Deferred.make<Acp.PromptResponse>());
    const prompts = [
      Deferred.await(firstPrompt),
      Effect.never as Effect.Effect<Acp.PromptResponse>,
    ];
    const { runtime, emitToolCall, completeProcessedEvent } = makeEventAcpRuntime(
      () => prompts.shift() ?? Effect.never,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-stale-tool");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
        yield* emitToolCall("old-tool", "pending");
        yield* Deferred.succeed(firstPrompt, { stopReason: "end_turn" } as Acp.PromptResponse);
        yield* advanceTimers(1);
        const second = yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
        yield* emitToolCall("old-tool", "completed");
        yield* advanceTimers(15);
        yield* emitToolCall("old-tool", "inProgress");
        yield* advanceTimers(40);
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "error" });
        expect(second.turnId).toBeDefined();
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(makeDevinAdapterTestLayer(runtime, completeProcessedEvent))),
    );
  });

  it("resets the ordinary clock for other valid progress events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { runtime, emitProgress, completeProcessedEvent } = makeEventAcpRuntime(
      () => Effect.never,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-progress-clock");
        yield* adapter.startSession({
          provider: "devin",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "progress", attachments: [] });
        yield* advanceTimers(15);
        yield* emitProgress();
        yield* advanceTimers(15);
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "running", activeTurnId: turn.turnId });
        yield* advanceTimers(30);
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "error" });
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(makeDevinAdapterTestLayer(runtime, completeProcessedEvent))),
    );
  });

  it("clears active tool budget on normal settlement, interrupt, timeout, and teardown", async () => {
    const outcomes = ["settle", "interrupt", "timeout", "teardown"] as const;
    for (const outcome of outcomes) {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const promptResult = Effect.runSync(Deferred.make<Acp.PromptResponse>());
      const { runtime, emitToolCall, completeProcessedEvent } = makeEventAcpRuntime(() =>
        Deferred.await(promptResult),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* DevinAdapter;
          const threadId = ThreadId.makeUnsafe(`thread-devin-clear-${outcome}`);
          yield* adapter.startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
          });
          const turn = yield* adapter.sendTurn({ threadId, input: outcome, attachments: [] });
          yield* emitToolCall("tool", "pending");
          if (outcome === "settle") {
            yield* Deferred.succeed(promptResult, { stopReason: "end_turn" } as Acp.PromptResponse);
            yield* advanceTimers(1);
            expect(
              (yield* adapter.listSessions()).find((session) => session.threadId === threadId)
                ?.status,
            ).toBe("ready");
          } else if (outcome === "interrupt") {
            yield* adapter.interruptTurn(threadId, turn.turnId);
          } else if (outcome === "timeout") {
            yield* emitToolCall("tool", "completed");
            yield* advanceTimers(40);
            expect(
              (yield* adapter.listSessions()).find((session) => session.threadId === threadId)
                ?.status,
            ).toBe("error");
          }
          yield* adapter.stopSession(threadId);
          expect(
            (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
          ).toBeUndefined();
        }).pipe(Effect.provide(makeDevinAdapterTestLayer(runtime, completeProcessedEvent))),
      );
      vi.useRealTimers();
    }
  });
});

describe("applyDevinSessionConfiguration", () => {
  it("sets plan mode when requested", async () => {
    const { runtime, calls } = makeFakeAcpRuntime({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });

    await Effect.runPromise(
      applyDevinSessionConfiguration({
        runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    );

    expect(calls).toEqual([{ method: "setMode", args: ["plan"] }]);
  });

  it("does not touch config options for the model selection", async () => {
    // Devin models are process-start `--model` flags; the per-turn
    // set_config_option path must stay gone.
    const { runtime, calls } = makeFakeAcpRuntime();

    await Effect.runPromise(
      applyDevinSessionConfiguration({
        runtime,
        runtimeMode: "full-access",
        interactionMode: undefined,
      }),
    );

    expect(calls).toEqual([]);
  });

  it("fails closed when plan mode is not available", async () => {
    const { runtime } = makeFakeAcpRuntime({
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    });

    await expect(
      Effect.runPromise(
        applyDevinSessionConfiguration({
          runtime,
          runtimeMode: "full-access",
          interactionMode: "plan",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });

  it("fails closed for approval-required when mode discovery is unavailable", async () => {
    const { runtime, calls } = makeFakeAcpRuntime();

    await expect(
      Effect.runPromise(
        applyDevinSessionConfiguration({
          runtime,
          runtimeMode: "approval-required",
          interactionMode: undefined,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
    expect(calls).toEqual([]);
  });
});

describe("resolveRequestedModeId", () => {
  const devin300067Modes = [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Full Access" },
  ];
  it("selects plan mode by exact alias", async () => {
    const modeId = await Effect.runPromise(
      resolveRequestedModeId({
        modeState: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    );
    expect(modeId).toBe("plan");
  });

  it("leaves default mode unchanged for non-plan turns", async () => {
    const modeId = await Effect.runPromise(
      resolveRequestedModeId({
        modeState: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
        runtimeMode: "full-access",
        interactionMode: undefined,
      }),
    );
    expect(modeId).toBeUndefined();
  });

  it("rejects ambiguous partial mode matches", async () => {
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: {
            currentModeId: "default",
            availableModes: [{ id: "planner", name: "Planner" }],
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });

  it("rejects approval-required when mode state is unavailable", async () => {
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: undefined,
          runtimeMode: "approval-required",
          interactionMode: undefined,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });

  it("maps approval-required to Code in the real Devin 3000.6.7 catalog", async () => {
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: { currentModeId: "smart", availableModes: devin300067Modes },
          runtimeMode: "approval-required",
          interactionMode: undefined,
        }),
      ),
    ).resolves.toBe("accept-edits");
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: { currentModeId: "accept-edits", availableModes: devin300067Modes },
          runtimeMode: "approval-required",
          interactionMode: undefined,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps Plan precedence and never maps approval-required to Smart or Ask", async () => {
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: { currentModeId: "accept-edits", availableModes: devin300067Modes },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        }),
      ),
    ).resolves.toBe("plan");

    for (const unavailableModes of [
      devin300067Modes.filter((mode) => mode.id !== "accept-edits"),
      [
        { id: "smart", name: "Smart" },
        { id: "ask", name: "Ask" },
      ],
    ]) {
      await expect(
        Effect.runPromise(
          resolveRequestedModeId({
            modeState: { currentModeId: "smart", availableModes: unavailableModes },
            runtimeMode: "approval-required",
            interactionMode: undefined,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
    }
  });

  it("maps full-access to Full Access without weakening approval-required", async () => {
    await expect(
      Effect.runPromise(
        resolveRequestedModeId({
          modeState: { currentModeId: "accept-edits", availableModes: devin300067Modes },
          runtimeMode: "full-access",
          interactionMode: undefined,
        }),
      ),
    ).resolves.toBe("bypass");
  });
});

describe("resolveDevinEffectiveModel", () => {
  it("prefers the concrete variant over the selection slug and explicit config", () => {
    expect(
      resolveDevinEffectiveModel({
        explicitModel: "default-model",
        selectionModel: "gpt-5.6-sol",
        modelVariant: "gpt-5-6-sol-high",
      }),
    ).toBe("gpt-5-6-sol-high");
    expect(
      resolveDevinEffectiveModel({
        explicitModel: "default-model",
        selectionModel: "gpt-5.6-sol",
        modelVariant: undefined,
      }),
    ).toBe("gpt-5.6-sol");
    expect(
      resolveDevinEffectiveModel({
        explicitModel: "default-model",
        selectionModel: undefined,
        modelVariant: undefined,
      }),
    ).toBe("default-model");
  });

  it("resolves static traits without a web-populated model variant", () => {
    expect(
      resolveDevinEffectiveModel({
        explicitModel: undefined,
        selectionModel: "swe-1-7",
        modelOptions: { fastMode: true },
      }),
    ).toBe("swe-1-7-lightning");
  });

  it("never substitutes a reasoning-effort label as the model", () => {
    // Regression: a runtime selection with only a reasoning effort (no
    // resolved variant) must keep the selection slug, never the effort label,
    // as the Devin `--model` value.
    expect(
      resolveDevinEffectiveModel({
        explicitModel: undefined,
        selectionModel: "gpt-5.6-sol",
        modelVariant: undefined,
      }),
    ).toBe("gpt-5.6-sol");
    expect(
      resolveDevinEffectiveModel({
        explicitModel: undefined,
        selectionModel: undefined,
        modelVariant: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("resolveDevinStartModel", () => {
  it("discovers once and caches the next non-web trait selection", async () => {
    let discoveryCalls = 0;
    const cachedFlags: Array<boolean | undefined> = [];
    const models = mergeDevinModelDescriptors([
      parseDevinCliModelList(
        JSON.stringify({
          families: [
            {
              family_uid: "gpt-5.6-sol",
              family_label: "GPT-5.6 Sol",
              slug: "gpt-5.6-sol",
              variants: [
                { model_uid: "gpt-5-6-sol-medium", label: "GPT-5.6 Sol Medium" },
                { model_uid: "gpt-5-6-sol-high", label: "GPT-5.6 Sol High" },
              ],
            },
          ],
        }),
      ),
    ]);

    const effectiveModels = await Effect.runPromise(
      Effect.gen(function* () {
        const discoveryLock = yield* Semaphore.make(1);
        const discoverModels = makeCachedDevinModelDiscovery({
          discoveryLock,
          discover: () =>
            Effect.sync(() => {
              discoveryCalls += 1;
              return { models, source: "devin-cli", cached: false };
            }),
        });
        const resolve = () =>
          resolveDevinStartModel({
            explicitModel: undefined,
            modelSelection: {
              model: "gpt-5.6-sol",
              options: { reasoningEffort: "high" },
            },
            discoverModels: () =>
              discoverModels(" /usr/local/bin/devin ").pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    cachedFlags.push(result.cached);
                  }),
                ),
              ),
          });
        return [yield* resolve(), yield* resolve()];
      }),
    );

    expect(discoveryCalls).toBe(1);
    expect(cachedFlags).toEqual([false, true]);
    expect(effectiveModels).toEqual(["gpt-5-6-sol-high", "gpt-5-6-sol-high"]);
  });

  it("retries model discovery after a fallback error", async () => {
    let discoveryCalls = 0;
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const discoveryLock = yield* Semaphore.make(1);
        const discoverModels = makeCachedDevinModelDiscovery({
          discoveryLock,
          discover: () =>
            Effect.sync(() => {
              discoveryCalls += 1;
              return discoveryCalls === 1
                ? { models: [], source: "devin.static", cached: false, error: "not ready" }
                : { models: [], source: "devin-cli", cached: false };
            }),
        });
        return [yield* discoverModels("devin"), yield* discoverModels("devin")];
      }),
    );

    expect(discoveryCalls).toBe(2);
    expect(results[0]?.error).toBe("not ready");
    expect(results[1]?.error).toBeUndefined();
  });

  it("coalesces concurrent model discovery through the shared lock", async () => {
    let discoveryCalls = 0;
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const discoveryLock = yield* Semaphore.make(1);
        const discoverModels = makeCachedDevinModelDiscovery({
          discoveryLock,
          discover: () =>
            Effect.gen(function* () {
              discoveryCalls += 1;
              yield* Effect.sleep(10);
              return { models: [], source: "devin-cli", cached: false };
            }),
        });
        return yield* Effect.all([discoverModels("devin"), discoverModels("devin")], {
          concurrency: "unbounded",
        });
      }),
    );

    expect(discoveryCalls).toBe(1);
    expect(results.map((result) => result.cached)).toEqual([false, true]);
  });

  it("does not discover models when no trait needs resolution", async () => {
    let discoveryCalls = 0;
    const effectiveModel = await Effect.runPromise(
      resolveDevinStartModel({
        explicitModel: undefined,
        modelSelection: { model: "gpt-5.6-sol" },
        discoverModels: () => {
          discoveryCalls += 1;
          return Effect.succeed({ models: [], source: "devin-cli", cached: false });
        },
      }),
    );

    expect(discoveryCalls).toBe(0);
    expect(effectiveModel).toBe("gpt-5.6-sol");
  });

  it("rejects requested traits that have no concrete model variant", async () => {
    await expect(
      Effect.runPromise(
        resolveDevinStartModel({
          explicitModel: undefined,
          modelSelection: {
            model: "gpt-5.6-sol",
            options: { reasoningEffort: "medium" },
          },
          discoverModels: () =>
            Effect.succeed({
              source: "devin-cli",
              cached: false,
              models: [
                {
                  slug: "gpt-5.6-sol",
                  name: "GPT-5.6 Sol",
                  modelVariants: [
                    { model: "gpt-5-6-sol-low", reasoningEffort: "low" },
                    { model: "gpt-5-6-sol-high", reasoningEffort: "high" },
                  ],
                },
              ],
            }),
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterValidationError",
      operation: "resolveDevinStartModel",
    });
  });

  it("resolves traits when the stored model is already a concrete variant", async () => {
    const effectiveModel = await Effect.runPromise(
      resolveDevinStartModel({
        explicitModel: undefined,
        modelSelection: {
          model: "gpt-5-6-sol-high",
          options: { reasoningEffort: "high" },
        },
        discoverModels: () =>
          Effect.succeed({
            source: "devin-cli",
            cached: false,
            models: [
              {
                slug: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                modelVariants: [
                  { model: "gpt-5-6-sol-low", reasoningEffort: "low" },
                  { model: "gpt-5-6-sol-high", reasoningEffort: "high" },
                ],
              },
            ],
          }),
      }),
    );

    expect(effectiveModel).toBe("gpt-5-6-sol-high");
  });
});

describe("buildDevinPromptMeta", () => {
  it("advertises plan mode through prompt metadata", () => {
    expect(buildDevinPromptMeta("plan")).toEqual({ mode: "plan" });
  });

  it("maps omitted and default modes to agent", () => {
    expect(buildDevinPromptMeta("default")).toEqual({ mode: "agent" });
  });
});

describe("buildDevinStaticModelDescriptors", () => {
  it("falls back to the static contract catalog", () => {
    const descriptors = buildDevinStaticModelDescriptors();
    expect(descriptors.some((d) => d.slug === "swe-1-7")).toBe(true);
    expect(descriptors.some((d) => d.slug === "adaptive")).toBe(true);
  });

  it("advertises SWE fast mode with concrete resolvable variants", () => {
    const descriptors = buildDevinStaticModelDescriptors();
    expect(descriptors.find((descriptor) => descriptor.slug === "swe-1-6")).toMatchObject({
      supportsFastMode: true,
      modelVariants: [
        { model: "swe-1-6", fastMode: false },
        { model: "swe-1-6-fast", fastMode: true },
      ],
    });
    expect(descriptors.find((descriptor) => descriptor.slug === "swe-1-7")).toMatchObject({
      supportsFastMode: true,
      modelVariants: [
        { model: "swe-1-7", fastMode: false },
        { model: "swe-1-7-lightning", fastMode: true },
      ],
    });
  });
});

describe("Devin CLI model discovery", () => {
  it("publishes reasoning, fast, context, and concrete variant metadata", () => {
    const models = parseDevinCliModelList(
      JSON.stringify({
        families: [
          {
            family_uid: "gpt-5.6-sol",
            family_label: "GPT-5.6 Sol",
            slug: "gpt-5.6-sol",
            variants: [
              {
                model_uid: "gpt-5-6-sol-medium",
                label: "GPT-5.6 Sol Medium",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-low",
                label: "GPT-5.6 Sol Low",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-high",
                label: "GPT-5.6 Sol High",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "gpt-5-6-sol-medium-priority",
                label: "GPT-5.6 Sol Medium Priority",
                max_context_tokens: 1_000_000,
              },
            ],
          },
        ],
      }),
    );

    const [model] = mergeDevinModelDescriptors([models]);
    if (!model) throw new Error("Expected GPT-5.6 Sol to be discovered");
    expect(model).toMatchObject({
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportsFastMode: true,
      defaultContextWindow: "200k",
    });
    expect(model.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(model.contextWindowOptions?.map((option) => option.value)).toEqual(["200k", "1m"]);
    expect(model.modelVariants).toContainEqual({
      model: "gpt-5-6-sol-medium-priority",
      reasoningEffort: "medium",
      contextWindow: "1m",
      fastMode: true,
    });
  });

  it("recognizes SWE lightning as a fast variant", () => {
    const [model] = mergeDevinModelDescriptors([
      parseDevinCliModelList(
        JSON.stringify({
          families: [
            {
              family_uid: "swe-1-7",
              family_label: "SWE 1.7",
              slug: "swe-1-7",
              variants: [
                { model_uid: "swe-1-7", label: "SWE 1.7" },
                { model_uid: "swe-1-7-lightning", label: "SWE 1.7 Lightning" },
              ],
            },
          ],
        }),
      ),
    ]);

    expect(model).toMatchObject({
      slug: "swe-1-7",
      supportsFastMode: true,
      modelVariants: [
        { model: "swe-1-7", fastMode: false },
        { model: "swe-1-7-lightning", fastMode: true },
      ],
    });
  });

  it("exposes thinking and long-context toggles for Claude-style variants", () => {
    const models = parseDevinCliModelList(
      JSON.stringify({
        families: [
          {
            family_uid: "claude-opus-4.6",
            family_label: "Claude Opus 4.6",
            slug: "claude-opus-4.6",
            variants: [
              {
                model_uid: "claude-opus-4-6",
                label: "Claude Opus 4.6",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "claude-opus-4-6-thinking",
                label: "Claude Opus 4.6 Thinking",
                max_context_tokens: 200_000,
              },
              {
                model_uid: "claude-opus-4-6-1m",
                label: "Claude Opus 4.6 1M",
                max_context_tokens: 1_000_000,
              },
              {
                model_uid: "claude-opus-4-6-thinking-1m",
                label: "Claude Opus 4.6 Thinking 1M",
                max_context_tokens: 1_000_000,
              },
            ],
          },
        ],
      }),
    );

    const [model] = mergeDevinModelDescriptors([models]);
    if (!model) throw new Error("Expected Claude Opus 4.6 to be discovered");
    expect(model).toMatchObject({
      supportsThinkingToggle: true,
      defaultContextWindow: "200k",
    });
    expect(model.contextWindowOptions?.map((option) => option.value)).toEqual(["200k", "1m"]);
    expect(model.modelVariants).toContainEqual({
      model: "claude-opus-4-6-thinking-1m",
      contextWindow: "1m",
      thinking: true,
    });
    expect(model.modelVariants).toContainEqual({
      model: "claude-opus-4-6",
      contextWindow: "200k",
      thinking: false,
    });
  });

  it("returns no descriptors for non-JSON CLI output", () => {
    expect(parseDevinCliModelList("devin: not logged in")).toEqual([]);
  });
});

describe("resolveDevinToolCallUpdatedTurnId", () => {
  it("keeps a trailing update on its recorded older turn while a newer turn is active", () => {
    // Regression: a late ToolCallUpdated for turn A arriving while turn B is
    // active must resolve under turn A (so A's tool row updates in place) and
    // must never be re-associated with turn B — the handler only applies
    // current-turn failed-tool detail when the resolved turn is the active
    // turn, so a non-active resolution cannot set turn B's failure state.
    const toolCallTurnIds = new Map<string, TurnId>([["tc-1", asTurnId("turn-A")]]);

    expect(
      resolveDevinToolCallUpdatedTurnId({
        toolCallId: "tc-1",
        activeTurnId: asTurnId("turn-B"),
        resumeReplayReady: false,
        toolCallTurnIds,
      }),
    ).toBe(asTurnId("turn-A"));
  });

  it("routes same-turn updates to the active turn and suppresses during replay", () => {
    const toolCallTurnIds = new Map<string, TurnId>([["tc-1", asTurnId("turn-A")]]);

    // A not-yet-recorded id belongs to the active turn.
    expect(
      resolveDevinToolCallUpdatedTurnId({
        toolCallId: "tc-2",
        activeTurnId: asTurnId("turn-B"),
        resumeReplayReady: false,
        toolCallTurnIds,
      }),
    ).toBe(asTurnId("turn-B"));

    // A recorded id with no active turn (between turns) stays on its turn.
    expect(
      resolveDevinToolCallUpdatedTurnId({
        toolCallId: "tc-1",
        activeTurnId: undefined,
        resumeReplayReady: false,
        toolCallTurnIds,
      }),
    ).toBe(asTurnId("turn-A"));

    // Resume replay stays suppressed like every other session/update event.
    expect(
      resolveDevinToolCallUpdatedTurnId({
        toolCallId: "tc-1",
        activeTurnId: asTurnId("turn-B"),
        resumeReplayReady: true,
        toolCallTurnIds,
      }),
    ).toBeUndefined();
  });
});

describe("pruneDevinToolCallTurnIds", () => {
  it("keeps only the kept turn's tool-call mappings", () => {
    const toolCallTurnIds = new Map<string, TurnId>([
      ["tc-a", asTurnId("turn-A")],
      ["tc-b", asTurnId("turn-B")],
      ["tc-c", asTurnId("turn-C")],
    ]);

    pruneDevinToolCallTurnIds(toolCallTurnIds, asTurnId("turn-B"));

    expect(toolCallTurnIds).toEqual(new Map([["tc-b", asTurnId("turn-B")]]));
  });

  it("drops every mapping when there is no kept turn", () => {
    const toolCallTurnIds = new Map<string, TurnId>([["tc-a", asTurnId("turn-A")]]);

    pruneDevinToolCallTurnIds(toolCallTurnIds, undefined);

    expect(toolCallTurnIds.size).toBe(0);
  });

  it("leaves an empty map unchanged", () => {
    const toolCallTurnIds = new Map<string, TurnId>();

    pruneDevinToolCallTurnIds(toolCallTurnIds, asTurnId("turn-A"));

    expect(toolCallTurnIds.size).toBe(0);
  });
});

describe("closeDevinSessionResources", () => {
  it("closes the ACP scope before config cleanup and contains cleanup failure", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          calls.push("scope");
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        closeDevinSessionResources({
          scope,
          config: {
            cleanup: async () => {
              calls.push("config");
              throw new Error("cleanup rejected");
            },
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["scope", "config"]);
    expect(await Effect.runPromise(Scope.close(scope, Exit.void))).toBeUndefined();
  });
});

describe("Devin stale resume classification", () => {
  it.each([
    {
      name: "exact resume rejection",
      resume: true,
      message: "Failed to load session data",
      recoverable: true,
    },
    {
      name: "normalized resume rejection",
      resume: true,
      message: " FAILED TO LOAD SESSION DATA ",
      recoverable: true,
    },
    {
      name: "fresh startup failure",
      resume: false,
      message: "Failed to load session data",
      recoverable: false,
    },
    {
      name: "auth error containing the phrase",
      resume: true,
      message: "Authentication failed: failed to load session data",
      recoverable: false,
    },
    {
      name: "unknown suffixed error",
      resume: true,
      message: "Failed to load session data: permission denied",
      recoverable: false,
    },
    {
      name: "transport failure",
      resume: true,
      message: "Failed to load session data",
      transport: true,
      recoverable: false,
    },
  ])("classifies $name without leaving a live session", async (testCase) => {
    const cause = testCase.transport
      ? new AcpTransportError({ detail: testCase.message, cause: new Error(testCase.message) })
      : new AcpRequestError({ code: -32603, errorMessage: testCase.message });
    const runtime = { ...makeLifecycleAcpRuntime(), start: () => Effect.fail(cause) };
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const threadId = ThreadId.makeUnsafe("thread-devin-classify-stale");
        const error = yield* adapter
          .startSession({
            provider: "devin",
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
            ...(testCase.resume
              ? { resumeCursor: { schemaVersion: 1, sessionId: "old-session" } }
              : {}),
          })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProviderAdapterProcessError);
        expect(error).toMatchObject({ cause });
        expect((error as ProviderAdapterProcessError).reason).toBe(
          testCase.recoverable ? "resume-state-unavailable" : undefined,
        );
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.provide(makeDevinAdapterTestLayer(runtime))),
    );
  });
});
