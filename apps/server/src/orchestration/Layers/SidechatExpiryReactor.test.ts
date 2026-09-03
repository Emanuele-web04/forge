import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { SIDECHAT_INACTIVITY_EXPIRY_MS } from "@synara/shared/sidechatExpiry";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { makeSidechatExpiryReactor } from "./SidechatExpiryReactor.ts";

interface ScheduledTimer {
  readonly callback: () => void;
  readonly dueAtMs: number;
}

function makeClock(startAtMs: number) {
  let nowMs = startAtMs;
  let nextTimerId = 1;
  const timers = new Map<number, ScheduledTimer>();
  const backgroundEffects: Promise<void>[] = [];

  const advanceTo = (targetMs: number) => {
    nowMs = targetMs;
    while (true) {
      const dueTimer = [...timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= nowMs)
        .toSorted((left, right) => left[1].dueAtMs - right[1].dueAtMs)[0];
      if (!dueTimer) return;
      timers.delete(dueTimer[0]);
      dueTimer[1].callback();
    }
  };

  return {
    now: () => nowMs,
    schedule: (callback: () => void, delayMs: number) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, dueAtMs: nowMs + delayMs });
      return timerId;
    },
    cancel: (timerId: number) => {
      timers.delete(timerId);
    },
    runFork: (effect: Effect.Effect<void>) => {
      backgroundEffects.push(Effect.runPromise(effect));
    },
    advanceTo,
    flushBackgroundEffects: async () => {
      await Promise.all(backgroundEffects.splice(0));
    },
  };
}

function makeSidechatThread(input: {
  readonly threadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly lastActivityAtMs: number;
  readonly archivedAt?: string | null;
}): OrchestrationThread {
  const lastActivityAt = new Date(input.lastActivityAtMs).toISOString();
  return {
    id: input.threadId,
    projectId: ProjectId.makeUnsafe("project-sidechat-expiry"),
    title: "Side investigation",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    sidechatSourceThreadId: input.sourceThreadId,
    sidechatLastActivityAt: lastActivityAt,
    sidechatExpiredAt: null,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    latestTurn: null,
    handoff: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    archivedAt: input.archivedAt ?? null,
    deletedAt: null,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: thread.updatedAt,
    spaces: [],
    projects: [],
    threads: [thread],
  };
}

function makeExpiredEvent(threadId: ThreadId, expiredAt: string): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.makeUnsafe("event-sidechat-expired"),
    type: "thread.sidechat-expired",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: expiredAt,
    commandId: CommandId.makeUnsafe("cmd-sidechat-expired"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      expectedLastActivityAt: new Date(0).toISOString(),
      expiredAt,
    },
  };
}

function makeUnarchivedEvent(threadId: ThreadId, updatedAt: string): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.makeUnsafe("event-sidechat-unarchived"),
    type: "thread.unarchived",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: updatedAt,
    commandId: CommandId.makeUnsafe("cmd-sidechat-unarchived"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, updatedAt },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sidechat expiry reactor.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("SidechatExpiryReactor", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function createHarness(input: {
    readonly nowMs: number;
    readonly lastActivityAtMs: number;
    readonly archivedAt?: string | null;
  }) {
    const threadId = ThreadId.makeUnsafe("sidechat-expiry-reactor-thread");
    const sourceThreadId = ThreadId.makeUnsafe("sidechat-expiry-reactor-source");
    let thread = makeSidechatThread({
      threadId,
      sourceThreadId,
      lastActivityAtMs: input.lastActivityAtMs,
      archivedAt: input.archivedAt ?? null,
    });
    const clock = makeClock(input.nowMs);
    const commands: OrchestrationCommand[] = [];
    const domainEvents = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
    const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    );
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const orchestrationEngine = {
      dispatch,
      getReadModel: () => Effect.succeed(makeReadModel(thread)),
      subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
        Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
      ),
    } as unknown as OrchestrationEngineShape;
    const providerService = { stopSession } as unknown as ProviderServiceShape;
    const layer = Layer.effect(SidechatExpiryReactor, makeSidechatExpiryReactor(clock)).pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    );
    const runtime = ManagedRuntime.make(layer);
    const reactor = await runtime.runPromise(Effect.service(SidechatExpiryReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    cleanups.push(async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    });
    return {
      clock,
      commands,
      domainEvents,
      reactor,
      updateThread: (patch: Partial<OrchestrationThread>) => {
        thread = { ...thread, ...patch };
      },
      stopSession,
      threadId,
    };
  }

  it("expires an already-idle side chat immediately after restart", async () => {
    const harness = await createHarness({
      nowMs: SIDECHAT_INACTIVITY_EXPIRY_MS + 1,
      lastActivityAtMs: 0,
    });

    harness.clock.advanceTo(harness.clock.now());
    await harness.clock.flushBackgroundEffects();

    expect(harness.commands).toContainEqual(
      expect.objectContaining({
        type: "thread.sidechat.expire",
        threadId: harness.threadId,
        expectedLastActivityAt: new Date(0).toISOString(),
      }),
    );
  });

  it("pauses inactivity while viewed and restarts it when the view closes", async () => {
    const harness = await createHarness({ nowMs: 1_000, lastActivityAtMs: 1_000 });
    harness.clock.advanceTo(2_000);
    await Effect.runPromise(harness.reactor.viewStarted(harness.threadId));

    harness.clock.advanceTo(2_000 + SIDECHAT_INACTIVITY_EXPIRY_MS);
    await harness.clock.flushBackgroundEffects();
    expect(harness.commands.some((command) => command.type === "thread.sidechat.expire")).toBe(
      false,
    );

    await Effect.runPromise(harness.reactor.viewEnded(harness.threadId));
    const closedAtMs = harness.clock.now();
    harness.clock.advanceTo(closedAtMs + SIDECHAT_INACTIVITY_EXPIRY_MS);
    await harness.clock.flushBackgroundEffects();

    expect(harness.commands.some((command) => command.type === "thread.sidechat.expire")).toBe(
      true,
    );
  });

  it("restarts inactivity from unarchive instead of expiring from archived idle time", async () => {
    const nowMs = SIDECHAT_INACTIVITY_EXPIRY_MS + 1_000;
    const archivedAt = new Date(1_000).toISOString();
    const harness = await createHarness({ nowMs, lastActivityAtMs: 0, archivedAt });
    harness.updateThread({ archivedAt: null });

    await Effect.runPromise(
      PubSub.publish(
        harness.domainEvents,
        makeUnarchivedEvent(harness.threadId, new Date(nowMs).toISOString()),
      ).pipe(Effect.asVoid),
    );
    await waitFor(() =>
      harness.commands.some((command) => command.type === "thread.sidechat.activity.record"),
    );

    expect(harness.commands).toContainEqual(
      expect.objectContaining({
        type: "thread.sidechat.activity.record",
        threadId: harness.threadId,
        activityAt: new Date(nowMs).toISOString(),
      }),
    );
    expect(harness.commands.some((command) => command.type === "thread.sidechat.expire")).toBe(
      false,
    );

    harness.clock.advanceTo(nowMs + SIDECHAT_INACTIVITY_EXPIRY_MS);
    await harness.clock.flushBackgroundEffects();
    expect(harness.commands).toContainEqual(
      expect.objectContaining({
        type: "thread.sidechat.expire",
        expectedLastActivityAt: new Date(nowMs).toISOString(),
      }),
    );
  });

  it("unloads the provider session when the expiry event is observed", async () => {
    const harness = await createHarness({ nowMs: 1_000, lastActivityAtMs: 1_000 });
    const expiredAt = new Date(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS).toISOString();

    await Effect.runPromise(
      PubSub.publish(harness.domainEvents, makeExpiredEvent(harness.threadId, expiredAt)).pipe(
        Effect.asVoid,
      ),
    );
    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession).toHaveBeenCalledWith({ threadId: harness.threadId });
  });
});
