import {
  EventId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Duration, Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  applySessionEvent,
  computeDesired,
  isActiveSession,
  KEEP_AWAKE_ARGS,
  KEEP_AWAKE_MAX_RESTARTS,
  type KeepAwakeChild,
  type KeepAwakeRuntime,
  KeepAwakeService,
  makeKeepAwake,
  seedActiveThreads,
} from "./keepAwake";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ServerSettingsService } from "./serverSettings";

const NOW = "2026-09-03T10:00:00.000Z";

function sessionSetEvent(input: {
  readonly threadId: string;
  readonly status: "running" | "idle" | "stopped";
  readonly activeTurnId: string | null;
  readonly sequence: number;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe(input.threadId),
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    type: "thread.session-set",
    payload: {
      threadId: ThreadId.makeUnsafe(input.threadId),
      session: {
        threadId: ThreadId.makeUnsafe(input.threadId),
        status: input.status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: input.activeTurnId === null ? null : TurnId.makeUnsafe(input.activeTurnId),
        lastError: null,
        updatedAt: NOW,
      },
    },
  } as OrchestrationEvent;
}

describe("keepAwake pure helpers", () => {
  it("computeDesired follows the mode and active turn count", () => {
    expect(computeDesired("off", 0)).toBe(false);
    expect(computeDesired("off", 3)).toBe(false);
    expect(computeDesired("always", 0)).toBe(true);
    expect(computeDesired("agent", 0)).toBe(false);
    expect(computeDesired("agent", 1)).toBe(true);
  });

  it("isActiveSession requires running status and an active turn", () => {
    expect(isActiveSession(null)).toBe(false);
    expect(isActiveSession({ status: "running", activeTurnId: null })).toBe(false);
    expect(isActiveSession({ status: "idle", activeTurnId: "turn-1" })).toBe(false);
    expect(isActiveSession({ status: "running", activeTurnId: "turn-1" })).toBe(true);
  });

  it("seedActiveThreads collects threads with a running turn", () => {
    const readModel = {
      threads: [
        { id: "t1", session: { status: "running", activeTurnId: "turn-1" } },
        { id: "t2", session: { status: "running", activeTurnId: null } },
        { id: "t3", session: null },
      ],
    } as unknown as Pick<OrchestrationReadModel, "threads">;
    expect([...seedActiveThreads(readModel)]).toEqual(["t1"]);
  });

  it("applySessionEvent adds and removes threads on thread.session-set", () => {
    let active: ReadonlySet<string> = new Set();
    active = applySessionEvent(
      active,
      sessionSetEvent({ threadId: "t1", status: "running", activeTurnId: "turn-1", sequence: 1 }),
    );
    expect(active.has("t1")).toBe(true);
    active = applySessionEvent(
      active,
      sessionSetEvent({ threadId: "t1", status: "idle", activeTurnId: null, sequence: 2 }),
    );
    expect(active.size).toBe(0);
  });

  it("spawns caffeinate with -dims", () => {
    expect([...KEEP_AWAKE_ARGS]).toEqual(["-dims"]);
  });
});

type FakeChild = KeepAwakeChild & {
  readonly kills: NodeJS.Signals[];
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
};

function makeFakeChild(): FakeChild {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const kills: NodeJS.Signals[] = [];
  const child: FakeChild = {
    kills,
    kill(signal) {
      kills.push(signal ?? "SIGTERM");
      // Mimic a cooperative caffeinate: SIGTERM exits on the next tick.
      queueMicrotask(() => child.emitExit(null, signal ?? "SIGTERM"));
      return true;
    },
    once(_event, listener) {
      exitListeners.push(listener);
      return child;
    },
    emitExit(code, signal) {
      for (const listener of exitListeners.splice(0)) listener(code, signal);
    },
  };
  return child;
}

function makeHarness(input: {
  readonly mode: "always" | "agent" | "off";
  readonly platform?: NodeJS.Platform;
  readonly binaryAvailable?: boolean;
  readonly initialThreads?: ReadonlyArray<{ id: string; activeTurnId: string | null }>;
}) {
  const spawned: FakeChild[] = [];
  const runtime: KeepAwakeRuntime = {
    platform: input.platform ?? "darwin",
    isBinaryAvailable: Effect.succeed(input.binaryAvailable ?? true),
    spawnCaffeinate: () => {
      const child = makeFakeChild();
      spawned.push(child);
      return child;
    },
    restartDelay: () => Duration.zero,
  };
  const readModel = {
    snapshotSequence: 0,
    spaces: [],
    projects: [],
    updatedAt: NOW,
    threads: (input.initialThreads ?? []).map((thread) => ({
      id: thread.id,
      session:
        thread.activeTurnId === null
          ? null
          : { status: "running", activeTurnId: thread.activeTurnId },
    })),
  } as unknown as OrchestrationReadModel;

  const layer = Effect.gen(function* () {
    const eventsPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const engine = {
      subscribeDomainEvents: PubSub.subscribe(eventsPubSub).pipe(
        Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
      ),
    } as unknown as (typeof OrchestrationEngineService)["Service"];
    const snapshotQuery = {
      getSnapshot: () => Effect.succeed(readModel),
    } as unknown as (typeof ProjectionSnapshotQuery)["Service"];
    const keepAwakeLayer = Layer.effect(KeepAwakeService, makeKeepAwake(runtime)).pipe(
      Layer.provideMerge(ServerSettingsService.layerTest({ keepAwakeMode: input.mode })),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    );
    return { eventsPubSub, keepAwakeLayer };
  });

  return { spawned, layer };
}

const waitFor = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* read;
      if (predicate(value)) return value;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* Effect.die(new Error("waitFor timed out"));
  });

// Forked stream consumers attach on their first scheduler turn; give them one.
const letConsumersAttach = Effect.sleep(Duration.millis(20));

function runScoped<A, E>(
  harness: ReturnType<typeof makeHarness>,
  body: (input: {
    readonly keepAwake: KeepAwakeService["Service"];
    readonly settings: ServerSettingsService["Service"];
    readonly eventsPubSub: PubSub.PubSub<OrchestrationEvent>;
    readonly scope: Scope.Closeable;
  }) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { eventsPubSub, keepAwakeLayer } = yield* harness.layer;
      const scope = yield* Scope.make("sequential");
      const program = Effect.gen(function* () {
        const keepAwake = yield* KeepAwakeService;
        const settings = yield* ServerSettingsService;
        yield* Scope.provide(keepAwake.start, scope);
        yield* letConsumersAttach;
        return yield* body({ keepAwake, settings, eventsPubSub, scope });
      });
      return yield* program.pipe(Effect.provide(keepAwakeLayer));
    }) as Effect.Effect<A, never, never>,
  );
}

describe("KeepAwakeService", () => {
  it("mode off never spawns and reports available + idle", async () => {
    const harness = makeHarness({ mode: "off" });
    const state = await runScoped(harness, ({ keepAwake }) => keepAwake.getState);
    expect(state).toEqual({ available: true, mode: "off", active: false, error: null });
    expect(harness.spawned).toHaveLength(0);
  });

  it("mode always spawns immediately and stops when switched off", async () => {
    const harness = makeHarness({ mode: "always" });
    await runScoped(harness, ({ keepAwake, settings }) =>
      Effect.gen(function* () {
        yield* waitFor(keepAwake.getState, (state) => state.active);
        expect(harness.spawned).toHaveLength(1);
        yield* settings.updateSettings({ keepAwakeMode: "off" });
        const state = yield* waitFor(keepAwake.getState, (s) => !s.active && s.mode === "off");
        expect(state.error).toBeNull();
        expect(harness.spawned[0]?.kills).toEqual(["SIGTERM"]);
      }),
    );
  });

  it("mode agent follows agent turn start and stop", async () => {
    const harness = makeHarness({ mode: "agent" });
    await runScoped(harness, ({ keepAwake, eventsPubSub }) =>
      Effect.gen(function* () {
        expect((yield* keepAwake.getState).active).toBe(false);
        yield* PubSub.publish(
          eventsPubSub,
          sessionSetEvent({
            threadId: "t1",
            status: "running",
            activeTurnId: "turn-1",
            sequence: 1,
          }),
        );
        yield* waitFor(keepAwake.getState, (state) => state.active);
        expect(harness.spawned).toHaveLength(1);
        yield* PubSub.publish(
          eventsPubSub,
          sessionSetEvent({ threadId: "t1", status: "idle", activeTurnId: null, sequence: 2 }),
        );
        yield* waitFor(keepAwake.getState, (state) => !state.active);
        expect(harness.spawned[0]?.kills).toEqual(["SIGTERM"]);
      }),
    );
  });

  it("mode agent seeds from the projection snapshot", async () => {
    const harness = makeHarness({
      mode: "agent",
      initialThreads: [{ id: "t1", activeTurnId: "turn-1" }],
    });
    await runScoped(harness, ({ keepAwake }) =>
      waitFor(keepAwake.getState, (state) => state.active),
    );
    expect(harness.spawned).toHaveLength(1);
  });

  it("restarts after unexpected exits and gives up after the retry cap", async () => {
    const harness = makeHarness({ mode: "always" });
    await runScoped(harness, ({ keepAwake }) =>
      Effect.gen(function* () {
        yield* waitFor(keepAwake.getState, (state) => state.active);
        for (let attempt = 1; attempt <= KEEP_AWAKE_MAX_RESTARTS; attempt++) {
          harness.spawned[harness.spawned.length - 1]!.emitExit(1, null);
          yield* waitFor(
            Effect.sync(() => harness.spawned.length),
            (count) => count === attempt + 1,
          );
        }
        harness.spawned[harness.spawned.length - 1]!.emitExit(1, null);
        const state = yield* waitFor(keepAwake.getState, (s) => s.error !== null);
        expect(state.active).toBe(false);
        expect(harness.spawned).toHaveLength(KEEP_AWAKE_MAX_RESTARTS + 1);
      }),
    );
  });

  it("clears the error and retries once the mode toggles", async () => {
    const harness = makeHarness({ mode: "always" });
    await runScoped(harness, ({ keepAwake, settings }) =>
      Effect.gen(function* () {
        yield* waitFor(keepAwake.getState, (state) => state.active);
        for (let attempt = 0; attempt <= KEEP_AWAKE_MAX_RESTARTS; attempt++) {
          harness.spawned[harness.spawned.length - 1]!.emitExit(1, null);
          yield* Effect.sleep(Duration.millis(10));
        }
        yield* waitFor(keepAwake.getState, (s) => s.error !== null);
        yield* settings.updateSettings({ keepAwakeMode: "off" });
        yield* waitFor(keepAwake.getState, (s) => s.mode === "off" && s.error === null);
        yield* settings.updateSettings({ keepAwakeMode: "always" });
        const state = yield* waitFor(keepAwake.getState, (s) => s.active);
        expect(state.error).toBeNull();
      }),
    );
  });

  it("kills the child when the scope closes", async () => {
    const harness = makeHarness({ mode: "always" });
    await runScoped(harness, ({ keepAwake, scope }) =>
      Effect.gen(function* () {
        yield* waitFor(keepAwake.getState, (state) => state.active);
        yield* Scope.close(scope, Exit.void);
        expect(harness.spawned[0]?.kills).toEqual(["SIGTERM"]);
      }),
    );
  });

  it("is a no-op when the platform is not darwin", async () => {
    const harness = makeHarness({ mode: "always", platform: "linux" });
    const state = await runScoped(harness, ({ keepAwake }) => keepAwake.getState);
    expect(state.available).toBe(false);
    expect(state.active).toBe(false);
    expect(harness.spawned).toHaveLength(0);
  });

  it("is a no-op when caffeinate is missing from PATH", async () => {
    const harness = makeHarness({ mode: "always", binaryAvailable: false });
    const state = await runScoped(harness, ({ keepAwake }) => keepAwake.getState);
    expect(state.available).toBe(false);
    expect(harness.spawned).toHaveLength(0);
  });
});
