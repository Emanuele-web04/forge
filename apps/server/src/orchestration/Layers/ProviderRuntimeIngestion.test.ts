import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  collectPersistedGeneratedImagePaths,
  ProviderRuntimeIngestionLive,
} from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): RuntimeItemId => RuntimeItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    forkThread: () => Effect.succeed(null),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: (provider) =>
      Effect.succeed({
        sessionModelSwitch: "in-session",
        supportsLiveTurnDiffPatch: provider === "codex",
      }),
    rollbackConversation: () => unsupported(),
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    const canonicalEvent = (() => {
      if (event.payload !== undefined) return event;
      const {
        type,
        eventId,
        provider,
        createdAt,
        threadId,
        turnId,
        itemId,
        requestId,
        ...legacyPayload
      } = event;
      const payload =
        type === "turn.completed" && legacyPayload.state === undefined
          ? { ...legacyPayload, state: legacyPayload.status }
          : legacyPayload;
      return {
        type,
        eventId,
        provider,
        createdAt,
        threadId,
        ...(turnId === undefined ? {} : { turnId }),
        ...(itemId === undefined ? {} : { itemId }),
        ...(requestId === undefined ? {} : { requestId }),
        payload,
      };
    })();
    Effect.runSync(
      PubSub.publish(runtimeEventPubSub, canonicalEvent as unknown as ProviderRuntimeEvent),
    );
  };

  return {
    service,
    emit,
    setSession,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProviderRuntimeEventRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: { readonly startIngestion?: boolean }) {
    const workspaceRoot = makeTempDir("synara-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const runtimeEventRepositoryLayer = ProviderRuntimeEventRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(runtimeEventRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const runtimeEventRepository = await runtime.runPromise(
      Effect.service(ProviderRuntimeEventRepository),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    let ingestionStarted = false;
    const startIngestion = async () => {
      if (ingestionStarted) return;
      ingestionStarted = true;
      await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope!)));
    };
    if (options?.startIngestion !== false) {
      await startIngestion();
    }
    const drain = () => Effect.runPromise(ingestion.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      emit: provider.emit,
      setProviderSession: provider.setSession,
      drain,
      startIngestion,
      runtimeEventRepository,
    };
  }

  it("REL-01C gate: replays output persisted before subscription without duplicate acceptance", async () => {
    const harness = await createHarness({ startIngestion: false });
    const event: ProviderRuntimeEvent = {
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-journal-before-subscribe"),
      provider: "codex",
      createdAt: "2026-07-14T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      payload: {
        message: "Recovered durable provider output",
      },
    };
    // This is the exact command the runtime event dispatches. Persisting it
    // first models a crash after orchestration acceptance but before cursor ack.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(
          `provider:${event.eventId}:thread-activity-append:thread-1:${event.eventId}`,
        ),
        threadId: asThreadId("thread-1"),
        activity: {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: "Recovered durable provider output",
            detail: "Recovered durable provider output",
          },
          turnId: null,
        },
        createdAt: event.createdAt,
      }),
    );
    const persisted = await Effect.runPromise(harness.runtimeEventRepository.append(event));

    await harness.startIngestion();
    await waitForThread(harness.engine, (thread) =>
      thread.activities.some((activity) => activity.id === event.eventId),
    );
    expect(
      await Effect.runPromise(
        harness.runtimeEventRepository.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
      ),
    ).toBe(persisted.sequence);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const recoveredActivities = readModel.threads
      .find((thread) => thread.id === asThreadId("thread-1"))
      ?.activities.filter((activity) => activity.id === event.eventId);
    expect(recoveredActivities).toHaveLength(1);
    expect(
      await Effect.runPromise(
        harness.runtimeEventRepository.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
      ),
    ).toBe(persisted.sequence);
  });

  it("REL-01C gate: rebuilds accepted buffered output before a terminal event", async () => {
    const harness = await createHarness({ startIngestion: false });
    const turnId = asTurnId("turn-buffered-restart");
    const itemId = asItemId("item-buffered-restart");
    const bufferedEvent: ProviderRuntimeEvent = {
      type: "content.delta",
      eventId: asEventId("evt-buffered-before-restart"),
      provider: "codex",
      createdAt: "2026-07-14T00:01:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: "buffered before restart",
      },
    };
    const persisted = await Effect.runPromise(harness.runtimeEventRepository.append(bufferedEvent));
    expect(
      await Effect.runPromise(
        harness.runtimeEventRepository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: persisted.sequence,
          updatedAt: "2026-07-14T00:01:01.000Z",
        }),
      ),
    ).toBe(true);

    await harness.startIngestion();
    await Effect.runPromise(
      harness.runtimeEventRepository.append({
        type: "item.completed",
        eventId: asEventId("evt-buffered-after-restart-complete"),
        provider: "codex",
        createdAt: "2026-07-14T00:01:02.000Z",
        threadId: asThreadId("thread-1"),
        turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    );
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) =>
          message.id === "assistant:item-buffered-restart" &&
          message.text === "buffered before restart" &&
          message.streaming === false,
      ),
    );
    expect(
      thread.messages.find((message) => message.id === "assistant:item-buffered-restart")?.text,
    ).toBe("buffered before restart");
  });

  it("REL-01C gate: does not re-buffer accepted streaming output during rebuild", async () => {
    const harness = await createHarness({ startIngestion: false });
    const turnId = asTurnId("turn-streaming-restart");
    const itemId = asItemId("item-streaming-restart");
    const messageId = asMessageId("assistant:item-streaming-restart");
    const event: ProviderRuntimeEvent = {
      type: "content.delta",
      eventId: asEventId("evt-streaming-before-restart"),
      provider: "codex",
      createdAt: "2026-07-14T00:02:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: { streamKind: "assistant_text", delta: "streamed once" },
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe(`provider:${event.eventId}:assistant-delta:${messageId}`),
        threadId: asThreadId("thread-1"),
        messageId,
        delta: "streamed once",
        turnId,
        createdAt: event.createdAt,
      }),
    );
    const persisted = await Effect.runPromise(harness.runtimeEventRepository.append(event));
    expect(
      await Effect.runPromise(
        harness.runtimeEventRepository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: persisted.sequence,
          updatedAt: "2026-07-14T00:02:01.000Z",
        }),
      ),
    ).toBe(true);

    await harness.startIngestion();
    await Effect.runPromise(
      harness.runtimeEventRepository.append({
        type: "item.completed",
        eventId: asEventId("evt-streaming-after-restart-complete"),
        provider: "codex",
        createdAt: "2026-07-14T00:02:02.000Z",
        threadId: asThreadId("thread-1"),
        turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    );
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === messageId && message.streaming === false),
    );
    expect(thread.messages.find((message) => message.id === messageId)?.text).toBe("streamed once");
  });

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("clears active turn state when a provider session reports ready", async () => {
    const harness = await createHarness();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-before-ready"),
      provider: "opencode",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-ready-clears"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-ready-clears",
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-ready-clears-turn"),
      provider: "opencode",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-ready-clears"),
      payload: {
        state: "ready",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.activeTurnId).toBeNull();
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("clears running turn state when a stop emits turn.aborted without a turn id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stop-aborted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-stop-aborted"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-stop-aborted",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-turn-delta-stop-aborted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-stop-aborted"),
      itemId: asItemId("item-stop-aborted"),
      payload: {
        streamKind: "assistant_text",
        delta: "partial",
      },
    });

    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-turn-aborted-stop-aborted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      payload: {
        state: "interrupted",
        reason: "provider stopped",
      },
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "interrupted" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-stop-aborted" && message.streaming === false,
        ),
    );
  });

  it("projects a turn/completed provider notification with interrupted state as interrupted", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-completed-interrupted");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-completed-interrupted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
    });
    await waitForThread(harness.engine, (thread) => thread.session?.activeTurnId === turnId);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-interrupted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: { state: "interrupted" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "interrupted" &&
        entry.session.activeTurnId === null &&
        entry.latestTurn?.state === "interrupted" &&
        entry.activities.some((activity) => activity.id === "evt-turn-completed-interrupted"),
    );
    expect(thread.activities).toContainEqual(
      expect.objectContaining({
        kind: "turn.completed",
        summary: "Turn interrupted",
        payload: expect.objectContaining({ state: "interrupted" }),
      }),
    );
  });

  it("appends generated-image markdown to the turn's assistant message when the turn settles", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-image");
    const imagePath = "/tmp/provider-thread/call.png";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-image"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-image-answer-delta"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("answer-image"),
      payload: {
        streamKind: "assistant_text",
        delta: "Here is the generated result.",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-image-answer-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("answer-image"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message) =>
          message.id === "assistant:answer-image" &&
          message.text.includes("Here is the generated result.") &&
          message.streaming === false,
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-generated-image-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("call"),
      payload: {
        itemType: "image_generation",
        status: "completed",
        title: "Generated image",
        detail: imagePath,
        data: {
          kind: "codex.generated_image",
          path: imagePath,
          callId: "call",
        },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-image"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) =>
          message.id === "assistant:answer-image" &&
          message.text.includes("Here is the generated result.") &&
          message.text.includes(`![Generated image](${imagePath})`) &&
          message.streaming === false,
      ),
    );
    const assistantMessage = thread.messages.find(
      (message) => message.id === "assistant:answer-image",
    );
    expect(assistantMessage?.streaming).toBe(false);
  });

  it("prefers a persisted Studio copy over its provider-home image source", () => {
    expect(
      collectPersistedGeneratedImagePaths([
        {
          kind: "studio.outputs.captured",
          payload: {
            itemType: "studio_outputs",
            data: {
              files: [{ path: "Outbox/Images/generated.png" }],
              generatedImage: {
                sourcePath: "/codex/generated.png",
                fullPath: "/studio/Outbox/Images/generated.png",
              },
            },
          },
        },
        {
          kind: "tool.completed",
          payload: {
            itemType: "image_generation",
            status: "completed",
            data: { kind: "codex.generated_image", path: "/codex/generated.png" },
          },
        },
      ]),
    ).toEqual(["/studio/Outbox/Images/generated.png"]);
  });

  it("recovers generated-image references from persisted turn activities", async () => {
    // Simulates a server restart after the image activity was projected: this
    // ingestion instance has no matching entry in its in-memory pending cache.
    const harness = await createHarness();
    const turnId = asTurnId("turn-image-persisted-recovery");
    const imagePath = "/tmp/provider-thread/persisted-recovery.png";
    const createdAt = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-persisted-recovery-turn-started"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      turnId,
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-persisted-recovery-answer-complete"),
      provider: "codex",
      createdAt,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("persisted-recovery-answer"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message) =>
          message.id === "assistant:persisted-recovery-answer" && message.streaming === false,
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-persisted-generated-image-activity"),
        threadId: asThreadId("thread-1"),
        activity: {
          id: asEventId("activity-persisted-generated-image"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Generated image",
          payload: {
            itemType: "image_generation",
            status: "completed",
            data: {
              kind: "codex.generated_image",
              path: imagePath,
              callId: "persisted-recovery",
            },
          },
          turnId,
          createdAt,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-persisted-recovery-turn-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) =>
          message.id === "assistant:persisted-recovery-answer" &&
          message.text.includes(`![Generated image](${imagePath})`),
      ),
    );
    expect(
      thread.messages.find((message) => message.id === "assistant:persisted-recovery-answer")?.text,
    ).toContain(`![Generated image](${imagePath})`);
  });

  it("attaches generated images to the empty terminal assistant message, not collapsed commentary", async () => {
    // Regression: Codex emits commentary, then the image artifact, then a distinct
    // *intentionally empty* final assistant item (the artifact is the answer). The
    // image must end up on the terminal message the transcript keeps visible — an
    // image attached to commentary is folded into the "Worked for…" disclosure and
    // the visible row renders "(empty response)".
    const harness = await createHarness();
    const turnId = asTurnId("turn-image-empty-final");
    const imagePath = "/tmp/provider-thread/empty-final.png";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-empty-final-turn-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-empty-final-commentary-delta"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("commentary"),
      payload: {
        streamKind: "assistant_text",
        delta: "Generating the image now…",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-empty-final-commentary-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("commentary"),
      payload: { itemType: "assistant_message", status: "completed" },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message) => message.id === "assistant:commentary" && message.streaming === false,
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-empty-final-image-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("image-call"),
      payload: {
        itemType: "image_generation",
        status: "completed",
        title: "Generated image",
        detail: imagePath,
        data: { kind: "codex.generated_image", path: imagePath, callId: "image-call" },
      },
    });
    // The empty final item: no deltas, no fallback detail — mirrors the real trace.
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-empty-final-answer-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("final-answer"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-empty-final-turn-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) =>
          message.id === "assistant:final-answer" &&
          message.text.includes(`![Generated image](${imagePath})`) &&
          message.streaming === false,
      ),
    );

    // The terminal message owns the image; commentary stays untouched and no
    // synthetic image-only message was created.
    const commentary = thread.messages.find((message) => message.id === "assistant:commentary");
    expect(commentary?.text).toBe("Generating the image now…");
    const messagesWithImage = thread.messages.filter((message) =>
      message.text.includes(`![Generated image](${imagePath})`),
    );
    expect(messagesWithImage.map((message) => message.id)).toEqual(["assistant:final-answer"]);
  });

  it("does not re-emit message-sent events when the same image_generation completion replays", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-image-replay");
    const imagePath = "/tmp/provider-thread/replay.png";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-replay-turn-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-replay-answer-delta"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("answer-replay"),
      payload: { streamKind: "assistant_text", delta: "Here you go." },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-replay-answer-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("answer-replay"),
      payload: { itemType: "assistant_message", status: "completed" },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message) =>
          message.id === "assistant:answer-replay" &&
          message.text.includes("Here you go.") &&
          message.streaming === false,
      ),
    );

    const imageEvent = {
      type: "item.completed" as const,
      eventId: asEventId("evt-replay-image-complete"),
      provider: "codex" as const,
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("call-replay"),
      payload: {
        itemType: "image_generation",
        status: "completed",
        title: "Generated image",
        detail: imagePath,
        data: { kind: "codex.generated_image", path: imagePath, callId: "call-replay" },
      },
    };

    harness.emit(imageEvent);
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-replay-turn-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message) =>
          message.id === "assistant:answer-replay" &&
          message.text.includes(`![Generated image](${imagePath})`),
      ),
    );

    const eventCountBeforeReplay = await Effect.runPromise(
      harness.engine.getReadModel().pipe(
        Effect.map((readModel) => {
          const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
          const message = thread?.messages.find((entry) => entry.id === "assistant:answer-replay");
          return message?.text ?? "";
        }),
      ),
    );

    // Replay the same image_generation_end event with a fresh eventId (provider would use a
    // new id even for an idempotent replay). The dedup guard should prevent any further
    // delta or complete dispatches because the target message already references the image.
    harness.emit({
      ...imageEvent,
      eventId: asEventId("evt-replay-image-complete-2"),
    });

    // Give the ingestion worker a beat to process the replay.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const finalText = await Effect.runPromise(
      harness.engine.getReadModel().pipe(
        Effect.map((readModel) => {
          const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
          const message = thread?.messages.find((entry) => entry.id === "assistant:answer-replay");
          return message?.text ?? "";
        }),
      ),
    );

    // Same text, still finalized, and the image markdown is not duplicated.
    expect(finalText).toBe(eventCountBeforeReplay);
    const occurrences = finalText.split(`![Generated image](${imagePath})`).length - 1;
    expect(occurrences).toBe(1);
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("does not project reasoning content deltas into transcript work rows", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-delta"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("thought-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "checking files",
      },
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-reasoning-turn-completed"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-turn-completed",
      ),
    );

    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-delta",
      ),
    ).toBe(false);
    expect(thread.messages).toHaveLength(0);
  });

  it("projects only completed Codex reasoning with a readable summary", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const detail = `**${"Verify the protocol mapping ".repeat(12).trim()}**\n\n<!-- -->\n\n**Update the adapter**\n\n<!-- -->`;

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-reasoning-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-stale-reasoning-summary-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-1"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: "Stale streamed summary",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-reasoning-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
        detail,
      },
    });

    const stableActivityId = "provider-reasoning:thread-1:reasoning-1";
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity: ProviderRuntimeTestActivity) => {
        if (activity.id !== stableActivityId || typeof activity.payload !== "object") {
          return false;
        }
        return (activity.payload as { status?: unknown }).status === "completed";
      }),
    );
    const reasoningActivities = thread.activities.filter(
      (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
    );

    expect(reasoningActivities).toHaveLength(1);
    expect(reasoningActivities[0]).toMatchObject({
      kind: "task.progress",
      tone: "tool",
      summary: "Reasoning trace",
      payload: {
        status: "completed",
        detail,
        data: { toolCallId: "reasoning-1" },
      },
    });
  });

  it("projects narrated Antigravity planner steps as completed reasoning", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const detail = "I will inspect the current working directory before continuing.";
    const baseEvent = {
      provider: "antigravity" as const,
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-antigravity-reasoning"),
      itemId: asItemId("antigravity-reasoning-1"),
    };

    harness.emit({
      ...baseEvent,
      type: "item.started",
      eventId: asEventId("evt-antigravity-reasoning-started"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
      },
    });
    harness.emit({
      ...baseEvent,
      type: "content.delta",
      eventId: asEventId("evt-antigravity-reasoning-delta"),
      payload: {
        streamKind: "reasoning_text",
        delta: detail,
      },
    });
    harness.emit({
      ...baseEvent,
      type: "item.completed",
      eventId: asEventId("evt-antigravity-reasoning-completed"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
        detail,
      },
    });

    const stableActivityId = "provider-reasoning:thread-1:antigravity-reasoning-1";
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    );

    expect(
      thread.activities.filter(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "task.progress",
        tone: "tool",
        summary: "Reasoning trace",
        payload: expect.objectContaining({
          status: "completed",
          detail,
          data: { toolCallId: "antigravity-reasoning-1" },
        }),
      }),
    ]);
  });

  it("buffers Codex summary deltas into one completed reasoning activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const baseEvent = {
      provider: "codex" as const,
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-reasoning"),
      itemId: asItemId("reasoning-buffered-1"),
    };

    harness.emit({
      ...baseEvent,
      type: "content.delta",
      eventId: asEventId("evt-buffered-reasoning-delta-1"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: "**Inspect",
      },
    });
    harness.emit({
      ...baseEvent,
      type: "content.delta",
      eventId: asEventId("evt-buffered-reasoning-delta-2"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: " the protocol**\n\n<!-- -->",
      },
    });
    harness.emit({
      ...baseEvent,
      type: "content.delta",
      eventId: asEventId("evt-buffered-reasoning-delta-3"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 1,
        delta: "**Update the adapter**\n\n<!-- -->",
      },
    });
    harness.emit({
      ...baseEvent,
      type: "item.completed",
      eventId: asEventId("evt-buffered-reasoning-completed"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
      },
    });

    const stableActivityId = "provider-reasoning:thread-1:reasoning-buffered-1";
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    );
    const reasoningActivities = thread.activities.filter(
      (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
    );

    expect(reasoningActivities).toHaveLength(1);
    expect(reasoningActivities[0]).toMatchObject({
      kind: "task.progress",
      tone: "tool",
      summary: "Reasoning trace",
      payload: {
        status: "completed",
        detail: "**Inspect the protocol**\n\n<!-- -->\n\n**Update the adapter**\n\n<!-- -->",
        data: { toolCallId: "reasoning-buffered-1" },
      },
    });
  });

  it("settles buffered Codex reasoning when a turn is aborted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-aborted-reasoning-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted-reasoning"),
      itemId: asItemId("reasoning-aborted-1"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: "**Preserve this partial summary**\n\n<!-- -->",
      },
    });
    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-aborted-reasoning-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted-reasoning"),
      payload: { state: "interrupted", reason: "provider aborted" },
    });

    const stableActivityId = "provider-reasoning:thread-1:reasoning-aborted-1";
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    );

    expect(
      thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    ).toMatchObject({
      summary: "Reasoning trace",
      payload: {
        status: "failed",
        detail: "**Preserve this partial summary**\n\n<!-- -->",
      },
    });
  });

  it("marks buffered Codex reasoning failed when the turn completes with an error", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-failed-turn-reasoning-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-failed-reasoning"),
      itemId: asItemId("reasoning-failed-turn-1"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: "**Preserve this failed turn summary**\n\n<!-- -->",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-failed-turn-reasoning-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-failed-reasoning"),
      payload: { state: "failed", errorMessage: "turn failed" },
    });

    const stableActivityId = "provider-reasoning:thread-1:reasoning-failed-turn-1";
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    );

    expect(
      thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    ).toMatchObject({
      summary: "Reasoning trace",
      payload: {
        status: "failed",
        detail: "**Preserve this failed turn summary**\n\n<!-- -->",
      },
    });
  });

  it("settles and clears buffered Codex reasoning on runtime errors", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-errored-reasoning-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-errored-reasoning"),
      itemId: asItemId("reasoning-errored-1"),
      payload: {
        streamKind: "reasoning_summary_text",
        summaryIndex: 0,
        delta: "**Preserve this failed summary**\n\n<!-- -->",
      },
    });
    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-errored-reasoning-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-errored-reasoning"),
      payload: { message: "app-server exited" },
    });

    const stableActivityId = "provider-reasoning:thread-1:reasoning-errored-1";
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    );

    expect(
      thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === stableActivityId,
      ),
    ).toMatchObject({
      summary: "Reasoning trace",
      payload: {
        status: "failed",
        detail: "**Preserve this failed summary**\n\n<!-- -->",
      },
    });
  });

  it("omits empty completed Codex reasoning just like thread/read", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-empty-reasoning-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-empty-reasoning"),
      itemId: asItemId("empty-reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-empty-reasoning-raw-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-empty-reasoning"),
      itemId: asItemId("empty-reasoning-1"),
      payload: {
        streamKind: "reasoning_text",
        contentIndex: 0,
        delta: "private raw trace",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-empty-reasoning-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-empty-reasoning"),
      itemId: asItemId("empty-reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
        detail: "<!-- -->",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-empty-reasoning-turn-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-empty-reasoning"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-empty-reasoning-turn-completed",
      ),
    );

    expect(
      thread.activities.filter(
        (activity: ProviderRuntimeTestActivity) => activity.summary === "Reasoning trace",
      ),
    ).toHaveLength(0);
  });

  it("does not project unsupported or unidentified reasoning lifecycle rows", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-pi-reasoning-started"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("pi-reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-pi-reasoning-completed"),
      provider: "pi",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("pi-reasoning-1"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Reasoning",
      },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-codex-reasoning-without-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-reasoning-filter-turn-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-reasoning-filter-turn-completed",
      ),
    );

    expect(
      thread.activities.filter(
        (activity: ProviderRuntimeTestActivity) => activity.summary === "Reasoning trace",
      ),
    ).toHaveLength(0);
  });

  it("persists a compact per-model token breakdown on turn.completed activities", async () => {
    const harness = await createHarness();

    harness.setProviderSession({
      threadId: asThreadId("thread-1"),
      provider: "claudeAgent",
      status: "running",
      runtimeMode: "approval-required",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
      activeTurnId: asTurnId("turn-1"),
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-model-usage"),
      provider: "claudeAgent",
      createdAt: "2026-03-01T10:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "completed",
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadInputTokens: 800,
            cacheCreationInputTokens: 60,
            webSearchRequests: 0,
            costUSD: 0.12,
            contextWindow: 200000,
          },
          "claude-haiku-4-5": {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 200000,
          },
        },
      },
    } as ProviderRuntimeEvent);

    const thread = await waitForThread(harness.engine, (candidate) =>
      candidate.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-completed-model-usage",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-turn-completed-model-usage",
    );
    // Zero-usage models are dropped; cache reads/writes fold into inputTokens.
    expect(activity).toMatchObject({
      kind: "turn.completed",
      payload: {
        state: "completed",
        modelUsage: {
          "claude-fable-5": { inputTokens: 960, outputTokens: 40, totalTokens: 1000 },
        },
      },
    });
    const persistedModelUsage = (
      activity?.payload as { modelUsage?: Record<string, unknown> } | undefined
    )?.modelUsage;
    expect(Object.keys(persistedModelUsage ?? {})).toEqual(["claude-fable-5"]);
  });

  it("projects MCP tool progress into thread activity with preserved tool metadata", async () => {
    const harness = await createHarness();

    harness.setProviderSession({
      threadId: asThreadId("thread-1"),
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
      activeTurnId: asTurnId("turn-1"),
    });

    harness.emit({
      type: "tool.progress",
      eventId: asEventId("evt-mcp-progress"),
      provider: "codex",
      createdAt: "2026-03-01T10:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        toolUseId: "tool-1",
        toolName: "mcp__codex_apps__github_fetch_pr",
        summary: "Fetching PR details",
        elapsedSeconds: 1.2,
      },
    } as ProviderRuntimeEvent);

    const thread = await waitForThread(harness.engine, (candidate) =>
      candidate.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-mcp-progress",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-mcp-progress",
    );
    expect(activity).toMatchObject({
      kind: "tool.updated",
      tone: "tool",
      summary: "mcp__codex_apps__github_fetch_pr",
      payload: {
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        detail: "Fetching PR details",
        data: {
          toolUseId: "tool-1",
          toolName: "mcp__codex_apps__github_fetch_pr",
          summary: "Fetching PR details",
          elapsedSeconds: 1.2,
        },
      },
    });
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: "codex",
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("ignores whitespace-only buffered assistant deltas on completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-whitespace"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-whitespace",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-whitespace"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace"),
      itemId: asItemId("item-buffered-whitespace"),
      payload: {
        streamKind: "assistant_text",
        delta: "  \n\t  ",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-whitespace"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace"),
      itemId: asItemId("item-buffered-whitespace"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-whitespace",
    );
    expect(message?.text).toBe("");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("binds overlapping same-thread delivery modes in provider turn order", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-same-thread-buffered"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-same-thread-buffered"),
          role: "user",
          text: "buffer first",
          attachments: [],
        },
        assistantDeliveryMode: "buffered",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-same-thread-streaming"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-same-thread-streaming"),
          role: "user",
          text: "stream second",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-same-thread-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-same-thread-buffered"),
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-same-thread-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-same-thread-streaming"),
    });
    await harness.drain();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-same-thread-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-same-thread-buffered"),
      itemId: asItemId("item-same-thread-buffered"),
      payload: { streamKind: "assistant_text", delta: "first stays hidden" },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-same-thread-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-same-thread-streaming"),
      itemId: asItemId("item-same-thread-streaming"),
      payload: { streamKind: "assistant_text", delta: "second is live" },
    });
    await harness.drain();

    const liveThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-same-thread-streaming" &&
          message.streaming &&
          message.text === "second is live",
      ),
    );
    expect(
      liveThread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-same-thread-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completed-same-thread-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-same-thread-buffered"),
      itemId: asItemId("item-same-thread-buffered"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-same-thread-buffered" &&
          !message.streaming &&
          message.text === "first stays hidden",
      ),
    );
  });

  it("does not assign a new same-thread request mode to the already active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-active-a"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-active-a"),
          role: "user",
          text: "buffer A",
          attachments: [],
        },
        assistantDeliveryMode: "buffered",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-active-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-active-a"),
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "turn-active-a",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-active-a-before-b"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-active-a"),
      itemId: asItemId("item-active-a"),
      payload: { streamKind: "assistant_text", delta: "A stays " },
    });
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.dispatch-queued",
        commandId: CommandId.makeUnsafe("cmd-dispatch-active-b"),
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("message-active-b"),
        assistantDeliveryMode: "streaming",
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-active-a-after-b"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-active-a"),
      itemId: asItemId("item-active-a"),
      payload: { streamKind: "assistant_text", delta: "buffered" },
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-active-b"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-active-b"),
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-active-b"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-active-b"),
      itemId: asItemId("item-active-b"),
      payload: { streamKind: "assistant_text", delta: "B streams" },
    });
    await harness.drain();

    const liveThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-active-b" &&
          message.streaming &&
          message.text === "B streams",
      ),
    );
    expect(
      liveThread.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-active-a",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completed-active-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-active-a"),
      itemId: asItemId("item-active-a"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-active-a" &&
          !message.streaming &&
          message.text === "A stays buffered",
      ),
    );
  });

  it("isolates overlapping buffered and streaming turns across threads", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const secondThreadId = asThreadId("thread-delivery-buffered");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-delivery-buffered"),
        threadId: secondThreadId,
        projectId: asProjectId("project-1"),
        title: "Buffered Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-delivery-buffered"),
        threadId: secondThreadId,
        session: {
          threadId: secondThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-overlap-streaming"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-overlap-streaming"),
          role: "user",
          text: "stream this turn",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-overlap-buffered"),
        threadId: secondThreadId,
        message: {
          messageId: asMessageId("message-overlap-buffered"),
          role: "user",
          text: "buffer this turn",
          attachments: [],
        },
        assistantDeliveryMode: "buffered",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-overlap-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-streaming"),
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-overlap-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: secondThreadId,
      turnId: asTurnId("turn-overlap-buffered"),
    });
    await harness.drain();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-overlap-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-streaming"),
      itemId: asItemId("item-overlap-streaming"),
      payload: { streamKind: "assistant_text", delta: "visible immediately" },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-overlap-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: secondThreadId,
      turnId: asTurnId("turn-overlap-buffered"),
      itemId: asItemId("item-overlap-buffered"),
      payload: { streamKind: "assistant_text", delta: "hidden until complete" },
    });
    await harness.drain();

    const streamingThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-overlap-streaming" &&
            message.streaming &&
            message.text === "visible immediately",
        ),
      2_000,
      asThreadId("thread-1"),
    );
    expect(
      streamingThread.messages.find(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-overlap-streaming",
      )?.streaming,
    ).toBe(true);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const bufferedThread = readModel.threads.find((thread) => thread.id === secondThreadId);
    expect(
      bufferedThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-overlap-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completed-overlap-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: secondThreadId,
      turnId: asTurnId("turn-overlap-buffered"),
      itemId: asItemId("item-overlap-buffered"),
      payload: { itemType: "assistant_message", status: "completed" },
    });

    const completedBufferedThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-overlap-buffered" &&
            !message.streaming &&
            message.text === "hidden until complete",
        ),
      2_000,
      secondThreadId,
    );
    expect(
      completedBufferedThread.messages.find(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-overlap-buffered",
      )?.streaming,
    ).toBe(false);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-overlap-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: secondThreadId,
      turnId: asTurnId("turn-overlap-buffered"),
      payload: { state: "completed" },
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session.activeTurnId === null,
      2_000,
      secondThreadId,
    );

    // A terminal event for the buffered turn must neither erase its policy for
    // late events nor disturb the still-active streaming turn on another thread.
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-late-delta-overlap-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: secondThreadId,
      turnId: asTurnId("turn-overlap-buffered"),
      itemId: asItemId("item-late-overlap-buffered"),
      payload: { streamKind: "assistant_text", delta: "late but still buffered" },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-second-delta-overlap-streaming"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-streaming"),
      itemId: asItemId("item-second-overlap-streaming"),
      payload: { streamKind: "assistant_text", delta: "still streams" },
    });
    await harness.drain();

    const afterTerminalReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const afterTerminalBufferedThread = afterTerminalReadModel.threads.find(
      (thread) => thread.id === secondThreadId,
    );
    expect(
      afterTerminalBufferedThread?.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-late-overlap-buffered",
      ),
    ).toBe(false);
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-second-overlap-streaming" &&
            message.streaming &&
            message.text === "still streams",
        ),
      2_000,
      asThreadId("thread-1"),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-late-completed-overlap-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: secondThreadId,
      turnId: asTurnId("turn-overlap-buffered"),
      itemId: asItemId("item-late-overlap-buffered"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-late-overlap-buffered" &&
            !message.streaming &&
            message.text === "late but still buffered",
        ),
      2_000,
      secondThreadId,
    );
  });

  it("flushes the active Codex turn when a steer requests streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-start-late-streaming-mode-buffered"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-late-streaming-mode-buffered"),
          role: "user",
          text: "begin buffered",
          attachments: [],
        },
        assistantDeliveryMode: "buffered",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-late-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-late-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-late-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-streaming-mode"),
      itemId: asItemId("item-late-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "show me live",
      },
    });
    await harness.drain();

    const beforeFlush = await Effect.runPromise(harness.engine.getReadModel());
    const beforeFlushThread = beforeFlush.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      beforeFlushThread?.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-late-streaming-mode",
      ),
    ).toBe(false);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-steer-late-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-late-streaming-mode"),
          role: "user",
          text: "show the active turn live",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    const flushedThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-late-streaming-mode" &&
          message.streaming &&
          message.text === "show me live",
      ),
    );
    const flushedMessage = flushedThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-late-streaming-mode",
    );
    expect(flushedMessage?.streaming).toBe(true);
    expect(flushedMessage?.text).toBe("show me live");
  });

  it("lazily binds a streaming request when assistant delta precedes turn.started", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-start-delta-without-turn-started"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-delta-without-turn-started"),
          role: "user",
          text: "stream before lifecycle start",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-without-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-without-started"),
      itemId: asItemId("item-without-started"),
      payload: { streamKind: "assistant_text", delta: "live without start" },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-without-started" &&
          message.streaming &&
          message.text === "live without start",
      ),
    );
  });

  it("consumes a pending mode when a terminal event arrives without turn.started", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-start-terminal-without-started"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-terminal-without-started"),
          role: "user",
          text: "finish before start signal",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-terminal-without-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-terminal-without-started"),
      payload: { state: "completed" },
    });
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-start-after-terminal-without-started"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-after-terminal-without-started"),
          role: "user",
          text: "this one buffers",
          attachments: [],
        },
        assistantDeliveryMode: "buffered",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-started-after-terminal-without-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-terminal-without-started"),
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-after-terminal-without-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-terminal-without-started"),
      itemId: asItemId("item-after-terminal-without-started"),
      payload: { streamKind: "assistant_text", delta: "must stay hidden" },
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    expect(
      thread?.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-after-terminal-without-started",
      ),
    ).toBe(false);
  });

  it("does not let a completed unmatched turn claim a future request mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-started-before-request-then-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-started-before-request-then-terminal"),
    });
    await harness.drain();
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-completed-before-request-then-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-started-before-request-then-terminal"),
      payload: { state: "completed" },
    });
    await harness.drain();

    // The causally earlier request can arrive late from the independent domain
    // stream. It belongs to the already-settled unmatched turn and must be
    // discarded rather than queued ahead of the next real request.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-late-request-after-unmatched-terminal"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-late-request-after-unmatched-terminal"),
          role: "user",
          text: "late request for completed turn",
          attachments: [],
        },
        assistantDeliveryMode: "buffered",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-start-after-unmatched-terminal"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("message-after-unmatched-terminal"),
          role: "user",
          text: "stream the future turn",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-future-started-after-unmatched-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-future-after-unmatched-terminal"),
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-future-delta-after-unmatched-terminal"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-future-after-unmatched-terminal"),
      itemId: asItemId("item-future-after-unmatched-terminal"),
      payload: { streamKind: "assistant_text", delta: "future mode is live" },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-future-after-unmatched-terminal" &&
          message.streaming &&
          message.text === "future mode is live",
      ),
    );
  });

  it("flushes buffered assistant text before session exit clears turn state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-session-exit"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-session-exit"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-session-exit",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-session-exit"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-session-exit"),
      itemId: asItemId("item-buffered-session-exit"),
      payload: {
        streamKind: "assistant_text",
        delta: "persist me before exit",
      },
    });
    await harness.drain();

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-session-exited-buffered-session-exit"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-session-exit" &&
          message.text === "persist me before exit" &&
          message.streaming === false,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-session-exit",
    );
    expect(message?.text).toBe("persist me before exit");
    expect(message?.streaming).toBe(false);
  });

  it("flushes buffered assistant text before runtime.error marks the session errored", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-runtime-error"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-runtime-error",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-runtime-error"),
      itemId: asItemId("item-buffered-runtime-error"),
      payload: {
        streamKind: "assistant_text",
        delta: "persist me before error",
      },
    });
    await harness.drain();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-buffered-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-runtime-error"),
      payload: {
        message: "boom",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffered-runtime-error" &&
            message.text === "persist me before error" &&
            message.streaming === false,
        ) && entry.session?.status === "error",
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-runtime-error",
    );
    expect(message?.text).toBe("persist me before error");
    expect(message?.streaming).toBe(false);
    expect(thread.session?.status).toBe("error");
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
    const completionEvent = completionEvents[0] as
      | Extract<OrchestrationEvent, { type: "thread.message-sent" }>
      | undefined;
    expect(completionEvent?.payload.text).toBe("done");
  });

  it("preserves the assistant turn id when a late item.completed omits it", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-late-completion"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-completion"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-late-completion",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-late-completion"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-completion"),
      itemId: asItemId("item-late-completion"),
      payload: {
        streamKind: "assistant_text",
        delta: "final answer",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-late-completion"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-completion"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-late-completion" &&
            message.turnId === "turn-late-completion" &&
            !message.streaming,
        ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-item-completed-late-without-turn"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      itemId: asItemId("item-late-completion"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-late-completion" &&
          message.turnId === "turn-late-completion" &&
          !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-late-completion",
    );
    expect(message?.text).toBe("final answer");
    expect(message?.turnId).toBe("turn-late-completion");

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-late-completion" &&
        event.payload.streaming === false
      );
    }) as Array<Extract<OrchestrationEvent, { type: "thread.message-sent" }>>;
    expect(completionEvents.length).toBeGreaterThanOrEqual(1);
    expect(completionEvents.every((event) => event.payload.turnId === "turn-late-completion")).toBe(
      true,
    );
  });

  it("keeps an existing assistant turn id when a late completion carries a newer turn id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-late-reassign-source"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-reassign-source"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "turn-late-reassign-source",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-late-reassign-source"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-reassign-source"),
      itemId: asItemId("item-late-reassign"),
      payload: {
        streamKind: "assistant_text",
        delta: "source answer",
      },
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-late-reassign-source"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-reassign-source"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-late-reassign" &&
            message.turnId === "turn-late-reassign-source" &&
            !message.streaming,
        ),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-late-reassign-next"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-reassign-next"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "turn-late-reassign-next",
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-item-completed-late-reassign-wrong-turn"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-reassign-next"),
      itemId: asItemId("item-late-reassign"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.activeTurnId === "turn-late-reassign-next" &&
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-late-reassign" &&
            message.turnId === "turn-late-reassign-source" &&
            !message.streaming,
        ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-late-reassign",
    );
    expect(message?.text).toBe("source answer");
    expect(message?.turnId).toBe("turn-late-reassign-source");
  });

  it("reuses the live assistant message when item.completed omits the item id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-missing-completion-item-id"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-missing-completion-item-id"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-missing-completion-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-missing-completion-item-id"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-missing-completion-item-id",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-assistant-delta-missing-completion-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-missing-completion-item-id"),
      itemId: asItemId("item-missing-completion-item-id"),
      payload: {
        streamKind: "assistant_text",
        delta: "Come together",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-missing-completion-item-id" &&
          message.streaming &&
          message.text === "Come together",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-completed-missing-completion-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-missing-completion-item-id"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "ther",
      },
    });

    const finalizedThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-missing-completion-item-id" && !message.streaming,
      ),
    );

    const assistantMessages = finalizedThread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.role === "assistant" && message.turnId === "turn-missing-completion-item-id",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe("assistant:item-missing-completion-item-id");
    expect(assistantMessages[0]?.text).toBe("Come together");
  });

  it("reuses the live assistant message when item.completed supplies a late item id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-late-completion-item-id"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-late-completion-item-id"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-late-completion-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-completion-item-id"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-late-completion-item-id",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-assistant-delta-late-completion-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-completion-item-id"),
      payload: {
        streamKind: "assistant_text",
        delta: "same answer",
      },
    });

    await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:turn-late-completion-item-id" &&
          message.streaming &&
          message.text === "same answer",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-completed-late-completion-item-id"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late-completion-item-id"),
      itemId: asItemId("item-late-completion-item-id"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "same answer",
      },
    });

    const finalizedThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:turn-late-completion-item-id" && !message.streaming,
      ),
    );

    const assistantMessages = finalizedThread.messages.filter(
      (message: ProviderRuntimeTestMessage) =>
        message.role === "assistant" && message.turnId === "turn-late-completion-item-id",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe("assistant:turn-late-completion-item-id");
    expect(assistantMessages[0]?.text).toBe("same answer");
  });

  it("honors the completed item id when a turn has multiple live assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-multiple-assistant-items"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-multiple-assistant-items"),
          role: "user",
          text: "stream two messages",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-multiple-assistant-items"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-multiple-assistant-items"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-multiple-assistant-items",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-assistant-delta-multiple-assistant-items-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-multiple-assistant-items"),
      itemId: asItemId("item-multiple-assistant-items-a"),
      payload: {
        streamKind: "assistant_text",
        delta: "first answer",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-assistant-delta-multiple-assistant-items-b"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-multiple-assistant-items"),
      itemId: asItemId("item-multiple-assistant-items-b"),
      payload: {
        streamKind: "assistant_text",
        delta: "second answer",
      },
    });

    await waitForThread(harness.engine, (thread) => {
      const assistantMessages = thread.messages.filter(
        (message: ProviderRuntimeTestMessage) =>
          message.role === "assistant" && message.turnId === "turn-multiple-assistant-items",
      );
      return (
        assistantMessages.length === 2 && assistantMessages.every((message) => message.streaming)
      );
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-completed-multiple-assistant-items-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-multiple-assistant-items"),
      itemId: asItemId("item-multiple-assistant-items-a"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "first answer",
      },
    });

    const finalizedThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-multiple-assistant-items-a" && !message.streaming,
      ),
    );

    const firstMessage = finalizedThread.messages.find(
      (message: ProviderRuntimeTestMessage) =>
        message.id === "assistant:item-multiple-assistant-items-a",
    );
    const secondMessage = finalizedThread.messages.find(
      (message: ProviderRuntimeTestMessage) =>
        message.id === "assistant:item-multiple-assistant-items-b",
    );
    expect(firstMessage?.text).toBe("first answer");
    expect(firstMessage?.streaming).toBe(false);
    expect(secondMessage?.text).toBe("second answer");
    expect(secondMessage?.streaming).toBe(true);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      lifecycleGeneration: "approval-generation",
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      lifecycleGeneration: "approval-generation",
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");
    expect(requestedPayload?.lifecycleGeneration).toBe("approval-generation");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
    expect(resolvedPayload?.lifecycleGeneration).toBe("approval-generation");
  });

  it("bounds large tool activity data while keeping command metadata", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const largeOutput = "line\n".repeat(20_000);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-large-tool-data"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-large-tool-data"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun run something",
        data: {
          rawInput: { command: "bun run something" },
          rawOutput: {
            stdout: largeOutput,
            stderr: largeOutput,
          },
          item: {
            command: "bun run something",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-large-tool-data"),
    );
    const activity = thread.activities.find((entry) => entry.id === "evt-large-tool-data");
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const data =
      payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : {};
    const rawInput =
      data.rawInput && typeof data.rawInput === "object"
        ? (data.rawInput as Record<string, unknown>)
        : {};
    const rawOutput =
      data.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : {};

    expect(data.__synaraTruncated).toBe(true);
    expect(JSON.stringify(data).length).toBeLessThan(17_000);
    expect(rawInput.command).toBe("bun run something");
    expect(String(rawOutput.stdout ?? "").length).toBeLessThan(3_000);
  });

  it("attaches buffered command output deltas to the completed tool activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-output-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        streamKind: "command_output",
        delta: "first line\n",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-output-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        streamKind: "command_output",
        delta: "second line\n",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "printf lines",
        data: {
          rawInput: { command: "printf lines" },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-command-completed"),
    );
    const activity = thread.activities.find((entry) => entry.id === "evt-command-completed");
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const data =
      payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : {};
    const rawOutput =
      data.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : {};

    expect(rawOutput.output).toBe("first line\nsecond line\n");
  });

  it("keeps buffered command output when completed raw streams are empty", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-empty-stream-buffered-output"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-empty-stream-output"),
      itemId: asItemId("item-empty-stream-output"),
      payload: {
        streamKind: "command_output",
        delta: "captured through delta\n",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-empty-stream-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-empty-stream-output"),
      itemId: asItemId("item-empty-stream-output"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "printf buffered",
        data: {
          rawInput: { command: "printf buffered" },
          rawOutput: {
            stdout: "",
            stderr: "",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-empty-stream-completed"),
    );
    const activity = thread.activities.find((entry) => entry.id === "evt-empty-stream-completed");
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const data =
      payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : {};
    const rawOutput =
      data.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : {};

    expect(rawOutput).toMatchObject({
      stdout: "",
      stderr: "",
      output: "captured through delta\n",
    });
  });

  it("hard-caps pathological tool activity data", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const wideData = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`wideField${index}`, "x".repeat(5_000)]),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-pathological-tool-data"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pathological-tool-data"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran noisy command",
        data: wideData,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-pathological-tool-data"),
    );
    const activity = thread.activities.find((entry) => entry.id === "evt-pathological-tool-data");
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const data =
      payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : {};

    expect(data.__synaraTruncated).toBe(true);
    expect(typeof data.preview).toBe("string");
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(16_000);
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("labels OpenCode retry warnings with a provider-specific summary and visible detail", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-opencode-retry-warning"),
      provider: "opencode",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-opencode"),
      payload: {
        message: "Provider request failed; retrying.",
        detail: {
          attempt: 2,
        },
      },
      raw: {
        source: "opencode.sdk.event",
        payload: {
          type: "session.next.retried",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-opencode-retry-warning",
      ),
    );

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-opencode-retry-warning",
    );
    const payload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning).toMatchObject({
      kind: "runtime.warning",
      summary: "OpenCode retrying",
    });
    expect(payload).toMatchObject({
      message: "Provider request failed; retrying.",
      detail: "Provider request failed; retrying.",
      nativeEventType: "session.next.retried",
      data: {
        attempt: 2,
      },
    });
  });

  it("labels Claude background moves as a background notice, not a runtime warning", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-background-move-notice"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-background"),
      payload: {
        message: "sleep 120",
        detail: {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "sleep 120" }],
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-background-move-notice",
      ),
    );

    const notice = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-background-move-notice",
    );
    expect(notice).toMatchObject({
      kind: "runtime.warning",
      summary: "Moved to background",
      tone: "info",
    });
    expect(notice?.payload).toMatchObject({
      message: "sleep 120",
      detail: "sleep 120",
      nativeEventType: "background_tasks_changed",
    });
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.tasks.updated",
      eventId: asEventId("evt-turn-tasks-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the tasks",
        tasks: [
          { task: "Inspect files", status: "completed" },
          { task: "Apply patch", status: "inProgress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: [
          "diff --git a/file.txt b/file.txt",
          "index 1111111..2222222 100644",
          "--- a/file.txt",
          "+++ b/file.txt",
          "@@ -1 +1,2 @@",
          "-hello",
          "+hello updated",
          "+again",
          "",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.tasks.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const taskActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-tasks-updated",
    );
    const taskPayload =
      taskActivity?.payload && typeof taskActivity.payload === "object"
        ? (taskActivity.payload as Record<string, unknown>)
        : undefined;
    expect(taskActivity?.kind).toBe("turn.tasks.updated");
    expect(Array.isArray(taskPayload?.tasks)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("inProgress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBeNull();
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
    expect(checkpoint?.files).toEqual([
      { path: "file.txt", kind: "modified", additions: 2, deletions: 1 },
    ]);
  });

  it("updates live provider diff placeholders for the same turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-first"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-live"),
      payload: {
        unifiedDiff: [
          "diff --git a/file.txt b/file.txt",
          "index 1111111..2222222 100644",
          "--- a/file.txt",
          "+++ b/file.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint: ProviderRuntimeTestCheckpoint) =>
          checkpoint.turnId === "turn-live" && checkpoint.files.length === 1,
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-second"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-live"),
      payload: {
        unifiedDiff: [
          "diff --git a/file.txt b/file.txt",
          "index 1111111..2222222 100644",
          "--- a/file.txt",
          "+++ b/file.txt",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+second",
          "diff --git a/src/next.ts b/src/next.ts",
          "new file mode 100644",
          "index 0000000..3333333",
          "--- /dev/null",
          "+++ b/src/next.ts",
          "@@ -0,0 +1 @@",
          "+export const next = true;",
          "",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint: ProviderRuntimeTestCheckpoint) =>
          checkpoint.turnId === "turn-live" && checkpoint.files.length === 2,
      ),
    );

    const checkpoints = thread.checkpoints.filter(
      (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-live",
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      checkpointTurnCount: 1,
      checkpointRef: "provider-diff:evt-turn-diff-first",
      status: "missing",
      files: [
        { path: "file.txt", kind: "modified", additions: 2, deletions: 1 },
        { path: "src/next.ts", kind: "modified", additions: 1, deletions: 0 },
      ],
    });
  });

  it("does not parse live diff files for providers without patch capability", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-claude-diff-placeholder"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude"),
      payload: {
        unifiedDiff: [
          "diff --git a/file.txt b/file.txt",
          "index 1111111..2222222 100644",
          "--- a/file.txt",
          "+++ b/file.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-claude",
      ),
    );

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-claude",
    );
    expect(checkpoint).toMatchObject({
      checkpointRef: "provider-diff:evt-claude-diff-placeholder",
      status: "missing",
      files: [],
    });
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          usedPercent: 0.83984375,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      usedPercent: 0.83984375,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("suppresses identical consecutive context window updates", async () => {
    const harness = await createHarness();
    const now = "2026-07-09T00:00:00.000Z";
    const makeUsageEvent = (eventId: string, usedTokens: number) => ({
      type: "thread.token-usage.updated" as const,
      eventId: asEventId(eventId),
      provider: "claudeAgent" as const,
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens,
          lastUsedTokens: usedTokens,
          maxTokens: 200_000,
          inputTokens: usedTokens,
          outputTokens: 0,
        },
      },
    });

    harness.emit(makeUsageEvent("evt-context-first", 4_000));
    harness.emit(makeUsageEvent("evt-context-duplicate", 4_000));
    harness.emit(makeUsageEvent("evt-context-changed", 4_001));
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-context-changed"),
    );
    const contextActivities = thread.activities.filter(
      (activity) => activity.kind === "context-window.updated",
    );
    expect(contextActivities.map((activity) => activity.id).toSorted()).toEqual([
      "evt-context-changed",
      "evt-context-first",
    ]);
  });

  it("projects percent-only context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-percent"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 0,
          usedPercent: 5.8,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 0,
      usedPercent: 5.8,
      compactsAutomatically: true,
    });
  });

  it("projects real zero-percent context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-zero-percent"),
      provider: "cursor",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 0,
          usedPercent: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 0,
      usedPercent: 0,
      compactsAutomatically: true,
    });
  });

  it("projects configured Claude context windows into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.configured",
      eventId: asEventId("evt-session-configured-context-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        config: {
          model: "claude-opus-4-7[1m]",
          contextWindow: "1m",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.configured",
      ),
    );

    const configuredActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.configured",
    );
    expect(configuredActivity?.payload).toMatchObject({
      contextWindow: "1m",
      maxTokens: 1_000_000,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted manually");
    expect(activity?.tone).toBe("info");
  });

  it("projects context compaction progress updates into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-thread-compacting"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        itemType: "context_compaction",
        status: "inProgress",
        detail: "Compacting context",
        data: { state: "compacting" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "context-compaction" &&
          activity.summary === "Compacting conversation...",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.kind === "context-compaction" &&
        candidate.summary === "Compacting conversation...",
    );
    expect(activity?.tone).toBe("info");
  });

  it("projects context compaction completion and failure into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-thread-compaction-completed"),
      provider: "grok",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        itemType: "context_compaction",
        status: "completed",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-thread-compaction-failed"),
      provider: "grok",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        itemType: "context_compaction",
        status: "failed",
        detail: "Compaction was interrupted",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "context-compaction" &&
          activity.summary === "Context compaction failed",
      ),
    );

    const completed = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.kind === "context-compaction" && candidate.summary === "Context compacted",
    );
    expect(completed?.tone).toBe("info");
    const failed = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.kind === "context-compaction" &&
        candidate.summary === "Context compaction failed",
    );
    expect(failed?.tone).toBe("error");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("still appends turn.completed activity when the provider omits cost metadata", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-no-cost"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-cost"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-completed-no-cost",
      ),
    );

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-completed-no-cost",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(completed?.kind).toBe("turn.completed");
    expect(completed?.turnId).toBe("turn-no-cost");
    expect(completedPayload?.state).toBe("completed");
    expect(completedPayload?.totalCostUsd).toBeUndefined();
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      lifecycleGeneration: "user-input-generation",
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      lifecycleGeneration: "user-input-generation",
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.runtimeMode === "approval-required" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");
    expect(
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>).lifecycleGeneration
        : undefined,
    ).toBe("user-input-generation");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
    expect(resolvedPayload?.lifecycleGeneration).toBe("user-input-generation");
    expect(thread.runtimeMode).toBe("approval-required");
  });

  it("creates and routes subagent runtime events into child threads", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-collab-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("item-collab"),
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Task",
        data: {
          item: {
            type: "collabAgentToolCall",
            receiverThreadIds: ["child-provider-1"],
            receiverAgents: [
              {
                threadId: "child-provider-1",
                agentNickname: "Locke",
                agentRole: "explorer",
                agentId: "agent-1",
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-child-turn-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child"),
      parentTurnId: asTurnId("turn-parent"),
      providerRefs: {
        providerThreadId: "child-provider-1",
        providerParentThreadId: "parent-provider-1",
        providerTurnId: "turn-child",
        parentProviderTurnId: "turn-parent",
      },
      payload: {},
    });

    const childThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.parentThreadId === "thread-1" &&
        entry.subagentNickname === "Locke" &&
        entry.subagentRole === "explorer" &&
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-child",
      2000,
      asThreadId("subagent:thread-1:child-provider-1"),
    );

    expect(childThread.title).toBe("Locke [explorer]");
    expect(childThread.creationSource).toBe("provider_native");
    expect(childThread.sourceThreadId).toBe("thread-1");
    expect(childThread.sourceTurnId).toBe("turn-parent");

    const parentThread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-collab-updated" && activity.kind === "tool.updated",
      ),
    );
    expect(
      parentThread.activities.some((activity) => activity.id === "evt-child-turn-started"),
    ).toBe(false);
  });

  it("handles collab receiver and child provider refs on the same event without duplicate thread creation", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-collab-child-thread-event"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-child"),
      parentTurnId: asTurnId("turn-parent"),
      itemId: asItemId("item-collab-child"),
      providerRefs: {
        providerThreadId: "child-provider-same-event",
        providerParentThreadId: "parent-provider-1",
        providerTurnId: "turn-child",
        parentProviderTurnId: "turn-parent",
      },
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Task",
        data: {
          item: {
            type: "collabAgentToolCall",
            receiverThreadIds: ["child-provider-same-event"],
            receiverAgents: [
              {
                threadId: "child-provider-same-event",
                agentNickname: "Noether",
                agentRole: "explorer",
              },
            ],
          },
        },
      },
    });

    const childThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.parentThreadId === "thread-1" &&
        entry.subagentNickname === "Noether" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-collab-child-thread-event" && activity.kind === "tool.updated",
        ),
      2000,
      asThreadId("subagent:thread-1:child-provider-same-event"),
    );

    expect(childThread.title).toBe("Noether [explorer]");
  });

  it("materializes subagent child threads even when the collab payload only exposes receiverAgents", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-collab-receiver-agents"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-parent"),
      itemId: asItemId("item-collab"),
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Task",
        data: {
          item: {
            type: "collabAgentToolCall",
            receiverAgents: [
              {
                threadId: "child-provider-2",
                agentNickname: "Harper",
                agentRole: "reviewer",
                requestedModel: "gpt-5.4-mini",
              },
            ],
          },
        },
      },
    });

    const childThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.id === "subagent:thread-1:child-provider-2" &&
        entry.subagentNickname === "Harper" &&
        entry.subagentRole === "reviewer",
      2000,
      asThreadId("subagent:thread-1:child-provider-2"),
    );

    expect(childThread.title).toBe("Harper [reviewer]");
  });

  it("keeps ingesting after a subagent child thread is deleted instead of re-creating it", async () => {
    const harness = await createHarness();
    const childThreadId = asThreadId("subagent:thread-1:child-provider-deleted");
    const collabEvent = {
      type: "item.updated",
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-deleted-child"),
      itemId: asItemId("item-collab-deleted"),
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Task",
        data: {
          item: {
            type: "collabAgentToolCall",
            receiverThreadIds: ["child-provider-deleted"],
          },
        },
      },
    } as const;

    harness.emit({
      ...collabEvent,
      eventId: asEventId("evt-collab-deleted-child-1"),
      createdAt: new Date().toISOString(),
    });
    await harness.drain();
    await waitForThread(
      harness.engine,
      (entry) => entry.parentThreadId === "thread-1",
      2000,
      childThreadId,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-delete-native-child"),
        threadId: childThreadId,
      }),
    );

    // A later provider event for the same child must not try to resurrect the
    // tombstoned thread: `thread.create` would be rejected, and the rejection is
    // stored against a deterministic command id, so every later replay of this
    // event would fail on the stored rejection.
    harness.emit({
      ...collabEvent,
      eventId: asEventId("evt-collab-deleted-child-2"),
      createdAt: new Date().toISOString(),
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const child = readModel.threads.find((thread) => thread.id === childThreadId);
    expect(child?.deletedAt).not.toBeNull();

    // The journal keeps flowing: a blocked row would pin the cursor and stall
    // every thread's projection.
    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-after-deleted-child"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      payload: { message: "still ingesting" },
    });
    await harness.drain();
    const parent = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-after-deleted-child",
      ),
    );
    expect(parent.id).toBe("thread-1");
  });

  it("starts when an accepted open-turn row can no longer replay its stored command", async () => {
    const harness = await createHarness({ startIngestion: false });
    const eventId = asEventId("evt-open-turn-unreplayable");
    const event: ProviderRuntimeEvent = {
      type: "item.updated",
      eventId,
      provider: "codex",
      createdAt: "2026-07-14T00:03:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-open-turn-unreplayable"),
      itemId: asItemId("item-collab-unreplayable"),
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Task",
        data: {
          item: {
            type: "collabAgentToolCall",
            receiverThreadIds: ["child-provider-unreplayable"],
          },
        },
      },
    };

    // Bind the child-create command id to a rejected command, the way a build
    // that reshaped provider command ids leaves receipts the next build can
    // never reuse. The startup rebuild runs on the server's boot path, so a row
    // it can never replay must degrade to a warning, not a crash loop.
    const rejected = await Effect.runPromise(
      Effect.result(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(
            `provider:${eventId}:subagent-thread-create:subagent:thread-1:child-provider-unreplayable`,
          ),
          threadId: asThreadId("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Duplicate",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: event.createdAt,
        }),
      ),
    );
    expect(rejected._tag).toBe("Failure");

    const persisted = await Effect.runPromise(harness.runtimeEventRepository.append(event));
    expect(
      await Effect.runPromise(
        harness.runtimeEventRepository.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: persisted.sequence,
          updatedAt: event.createdAt,
        }),
      ),
    ).toBe(true);

    await harness.startIngestion();

    await Effect.runPromise(
      harness.runtimeEventRepository.append({
        type: "runtime.warning",
        eventId: asEventId("evt-after-unreplayable-open-turn"),
        provider: "codex",
        createdAt: "2026-07-14T00:03:01.000Z",
        threadId: asThreadId("thread-1"),
        payload: { message: "still ingesting" },
      }),
    );
    await harness.drain();
    const parent = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-after-unreplayable-open-turn",
      ),
    );
    expect(parent.id).toBe("thread-1");
  });

  it("caps native child materialization per parent turn and deduplicates replay", async () => {
    const harness = await createHarness();
    const receiverThreadIds = Array.from({ length: 22 }, (_, index) => `native-child-${index}`);
    const event = {
      type: "item.updated",
      eventId: asEventId("evt-collab-overflow"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-native-budget"),
      itemId: asItemId("item-collab-overflow"),
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Task",
        data: {
          item: {
            type: "collabAgentToolCall",
            receiverThreadIds,
          },
        },
      },
    } as const;

    harness.emit(event);
    await harness.drain();
    harness.emit(event);
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const nativeChildren = readModel.threads.filter(
      (thread) =>
        thread.parentThreadId === "thread-1" && thread.sourceTurnId === "turn-native-budget",
    );
    expect(nativeChildren).toHaveLength(20);
    expect(
      nativeChildren.every(
        (thread) =>
          thread.creationSource === "provider_native" &&
          thread.sourceThreadId === "thread-1" &&
          thread.gatewayOperationId === null,
      ),
    ).toBe(true);
    const parent = readModel.threads.find((thread) => thread.id === "thread-1");
    expect(
      parent?.activities.filter((activity) => activity.kind === "subagent.materialization.capped"),
    ).toHaveLength(1);
  });

  it("routes fallback-annotated child events without polluting the parent projection", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const childThreadId = asThreadId("subagent:thread-1:child-provider-unmapped");
    const childTurnId = asTurnId("turn-child-unmapped");
    const providerRefs = {
      providerThreadId: "child-provider-unmapped",
      providerParentThreadId: "parent-provider-1",
    } as const;

    const before = await Effect.runPromise(harness.engine.getReadModel());
    const parentBefore = before.threads.find((thread) => thread.id === asThreadId("thread-1"));
    expect(parentBefore).toBeDefined();
    const parentProjectionBefore = structuredClone({
      messages: parentBefore?.messages,
      latestTurn: parentBefore?.latestTurn,
      activities: parentBefore?.activities,
      proposedPlans: parentBefore?.proposedPlans,
      checkpoints: parentBefore?.checkpoints,
      pendingInteractions: parentBefore?.pendingInteractions,
      session: parentBefore?.session,
      hasPendingApprovals: parentBefore?.hasPendingApprovals,
      hasPendingUserInput: parentBefore?.hasPendingUserInput,
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-unmapped-child-message-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      itemId: asItemId("item-unmapped-child-message"),
      providerRefs,
      payload: {
        streamKind: "assistant_text",
        delta: "Child-only answer",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-unmapped-child-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      itemId: asItemId("item-unmapped-child-message"),
      providerRefs,
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-unmapped-child-approval-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      requestId: ApprovalRequestId.makeUnsafe("req-unmapped-child-approval"),
      providerRefs,
      payload: {
        requestType: "command_execution_approval",
        detail: "run child command",
      },
    });
    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-unmapped-child-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      requestId: ApprovalRequestId.makeUnsafe("req-unmapped-child-user-input"),
      providerRefs,
      payload: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which child scope should be used?",
            options: [
              {
                label: "child-only",
                description: "Keep the answer on the child thread",
              },
            ],
          },
        ],
      },
    });

    const pendingChildThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.activities.some(
          (activity) => activity.id === "evt-unmapped-child-approval-requested",
        ) &&
        thread.activities.some(
          (activity) => activity.id === "evt-unmapped-child-user-input-requested",
        ),
      2000,
      childThreadId,
    );
    expect(pendingChildThread.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "evt-unmapped-child-approval-requested",
          kind: "approval.requested",
        }),
        expect.objectContaining({
          id: "evt-unmapped-child-user-input-requested",
          kind: "user-input.requested",
        }),
      ]),
    );

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-unmapped-child-approval-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      requestId: ApprovalRequestId.makeUnsafe("req-unmapped-child-approval"),
      providerRefs,
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });
    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-unmapped-child-user-input-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      requestId: ApprovalRequestId.makeUnsafe("req-unmapped-child-user-input"),
      providerRefs,
      payload: {
        answers: {
          scope: "child-only",
        },
      },
    });
    harness.emit({
      type: "turn.tasks.updated",
      eventId: asEventId("evt-unmapped-child-tasks"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      providerRefs,
      payload: {
        explanation: "Child work only",
        tasks: [{ task: "Finish child work", status: "completed" }],
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-unmapped-child-file-change"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      itemId: asItemId("item-unmapped-child-file-change"),
      providerRefs,
      payload: {
        itemType: "file_change",
        status: "completed",
        title: "Updated child file",
        detail: "apps/server/src/child-only.ts",
        data: {
          changes: [{ path: "apps/server/src/child-only.ts", kind: "update" }],
        },
      },
    });
    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-unmapped-child-diff"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: childTurnId,
      itemId: asItemId("item-unmapped-child-message"),
      providerRefs,
      payload: {
        unifiedDiff: [
          "diff --git a/child-only.txt b/child-only.txt",
          "index 1111111..2222222 100644",
          "--- a/child-only.txt",
          "+++ b/child-only.txt",
          "@@ -1 +1 @@",
          "-parent-safe",
          "+child-only",
          "",
        ].join("\n"),
      },
    });

    const childThread = await waitForThread(
      harness.engine,
      (thread) =>
        thread.messages.some(
          (message) =>
            message.id === "assistant:item-unmapped-child-message" &&
            message.text === "Child-only answer" &&
            message.streaming === false,
        ) &&
        thread.latestTurn?.turnId === childTurnId &&
        [
          "evt-unmapped-child-approval-requested",
          "evt-unmapped-child-approval-resolved",
          "evt-unmapped-child-user-input-requested",
          "evt-unmapped-child-user-input-resolved",
          "evt-unmapped-child-tasks",
          "evt-unmapped-child-file-change",
        ].every((eventId) => thread.activities.some((activity) => activity.id === eventId)) &&
        thread.checkpoints.some(
          (checkpoint) =>
            checkpoint.turnId === childTurnId &&
            checkpoint.files.some((file) => file.path === "child-only.txt"),
        ),
      2000,
      childThreadId,
    );

    expect(childThread.projectId).toBe(asProjectId("project-1"));
    expect(childThread.parentThreadId).toBe(asThreadId("thread-1"));

    const after = await Effect.runPromise(harness.engine.getReadModel());
    const parentAfter = after.threads.find((thread) => thread.id === asThreadId("thread-1"));
    expect(parentAfter).toBeDefined();
    expect({
      messages: parentAfter?.messages,
      latestTurn: parentAfter?.latestTurn,
      activities: parentAfter?.activities,
      proposedPlans: parentAfter?.proposedPlans,
      checkpoints: parentAfter?.checkpoints,
      pendingInteractions: parentAfter?.pendingInteractions,
      session: parentAfter?.session,
      hasPendingApprovals: parentAfter?.hasPendingApprovals,
      hasPendingUserInput: parentAfter?.hasPendingUserInput,
    }).toEqual(parentProjectionBefore);
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
