import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

/**
 * Command ids whose fingerprinting throws synchronously, standing in for any
 * synchronous defect raised while the worker builds a command's pipeline.
 */
const fingerprintPoison = vi.hoisted(() => new Set<string>());

vi.mock("../commandFingerprint.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commandFingerprint.ts")>();
  return {
    ...actual,
    fingerprintOrchestrationCommand: (command: OrchestrationCommand) => {
      if (fingerprintPoison.has(command.commandId)) {
        throw new TypeError("poisoned command fingerprint");
      }
      return actual.fingerprintOrchestrationCommand(command);
    },
  };
});

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

const makeThreadEventReadMethods = (
  events: ReadonlyArray<OrchestrationEvent>,
): Pick<OrchestrationEventStoreShape, "getThreadHighWaterSequence" | "readThreadEvents"> => ({
  getThreadHighWaterSequence: (threadId) =>
    Effect.succeed(
      events
        .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
        .at(-1)?.sequence ?? 0,
    ),
  readThreadEvents: (input) =>
    Effect.succeed(
      events
        .filter(
          (event) =>
            event.aggregateKind === "thread" &&
            event.aggregateId === input.threadId &&
            event.sequence <= input.throughSequenceInclusive &&
            event.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER) &&
            (input.eventTypes === undefined || input.eventTypes.includes(event.type)),
        )
        .toSorted((left, right) => right.sequence - left.sequence)
        .slice(0, input.limit),
    ),
});
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const TestServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-orchestration-engine-test-",
});

async function createOrchestrationSystem() {
  const ServerConfigLayer = TestServerConfigLayer;
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const managedAttachmentRepository = await runtime.runPromise(
    Effect.service(ManagedAttachmentRepository),
  );
  return {
    engine,
    managedAttachmentRepository,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine", () => {
  it("quiesces normal admission while draining reserved lifecycle commands", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-engine-quiesce");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-engine-quiesce-project"),
        projectId: asProjectId("project-engine-quiesce"),
        title: "Engine quiesce",
        workspaceRoot: "/tmp/engine-quiesce",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-engine-quiesce-thread"),
        threadId,
        projectId: asProjectId("project-engine-quiesce"),
        title: "Engine quiesce thread",
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

    await system.run(system.engine.quiesce);
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-normal"),
          threadId,
          title: "Rejected after quiesce",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    // A turn start takes the priority `user` lane, but priority is not
    // admissibility: the WebSocket keeps serving while the engine quiesces, and
    // starting a provider turn here would spawn a session the shutdown fences
    // moments later, orphaning the turn.
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-turn-start"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("msg-engine-quiesce-turn-start"),
            role: "user",
            text: "Rejected after quiesce",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-control"),
          threadId,
          createdAt,
        }),
      ),
    ).resolves.toMatchObject({ sequence: expect.any(Number) });
    await system.run(system.engine.drain);
    await system.run(system.engine.stop);

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-engine-stopped-control"),
          threadId,
          createdAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    await system.dispose();
  });

  it("returns the original result for an equal retry and rejects unequal command-ID reuse", async () => {
    const system = await createOrchestrationSystem();
    const command = {
      type: "project.create" as const,
      commandId: CommandId.makeUnsafe("cmd-fingerprint-retry"),
      projectId: asProjectId("project-fingerprint-retry"),
      title: "Fingerprint project",
      workspaceRoot: "/tmp/project-fingerprint-retry",
      defaultModelSelection: null,
      createdAt: "2026-07-14T00:00:00.000Z",
    };

    const first = await system.run(system.engine.dispatch(command));
    await expect(system.run(system.engine.dispatch({ ...command }))).resolves.toEqual(first);
    await expect(
      system.run(
        system.engine.dispatch({
          ...command,
          title: "Different command content",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandIdentityCollisionError",
      commandId: command.commandId,
    });

    const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
    expect(
      Array.from(events).filter((event) => event.commandId === command.commandId),
    ).toHaveLength(1);
    await system.dispose();
  });

  it("returns deterministic read models for repeated reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-1-create"),
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
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.run(engine.getReadModel());
    const readModelB = await system.run(engine.getReadModel());
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("returns the original sequence for equal retries and rejects unequal command-id reuse", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const command = {
      type: "project.create" as const,
      commandId: CommandId.makeUnsafe("cmd-project-command-identity"),
      projectId: asProjectId("project-command-identity"),
      title: "Original identity",
      workspaceRoot: "/tmp/project-command-identity",
      defaultModelSelection: null,
      createdAt: now(),
    };

    const accepted = await system.run(engine.dispatch(command));
    await expect(system.run(engine.dispatch(command))).resolves.toEqual(accepted);
    await expect(
      system.run(engine.dispatch({ ...command, title: "Different identity" })),
    ).rejects.toThrow("Command identity collision");

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    expect(events).toHaveLength(1);
    expect((await system.run(engine.getReadModel())).projects[0]?.title).toBe("Original identity");
    await system.dispose();
  });

  it("claims managed attachments atomically and rejects attachment changes on an accepted retry", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.makeUnsafe("thread-managed-attachment");
    const commandId = CommandId.makeUnsafe("cmd-managed-attachment-turn");
    const messageId = asMessageId("msg-managed-attachment");
    const principal = { ownerKind: "session" as const, ownerId: "session-a" };

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-managed-attachment-project"),
        projectId: asProjectId("project-managed-attachment"),
        title: "Managed attachment project",
        workspaceRoot: "/tmp/project-managed-attachment",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-managed-attachment-thread"),
        threadId,
        projectId: asProjectId("project-managed-attachment"),
        title: "Managed attachment thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const repository = system.managedAttachmentRepository;
    const stage = async (attachmentId: string) => {
      const reserved = await system.run(
        repository.reserve({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          kind: "image",
          originalName: `${attachmentId}.png`,
          mimeType: "image/png",
          reservedBytes: 1,
          relativePath: `objects/aa/${attachmentId}.png`,
          now: createdAt,
        }),
      );
      expect(reserved.status).toBe("reserved");
      await system.run(
        repository.finalizeStaged({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          sizeBytes: 1,
          sha256: "a".repeat(64),
          stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          now: createdAt,
        }),
      );
    };
    const firstAttachmentId = "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const secondAttachmentId = "att_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await stage(firstAttachmentId);
    await stage(secondAttachmentId);

    const command = {
      type: "thread.turn.start" as const,
      commandId,
      threadId,
      message: {
        messageId,
        role: "user" as const,
        text: "inspect",
        attachments: [
          {
            type: "image" as const,
            id: firstAttachmentId,
            name: "client-value-is-not-authoritative.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };
    const accepted = await system.run(engine.dispatch(command, { attachmentPrincipal: principal }));
    await expect(
      system.run(engine.dispatch(command, { attachmentPrincipal: principal })),
    ).resolves.toEqual(accepted);

    const editResendClaim = await system.run(
      repository.claimForAcceptedTurn({
        attachmentIds: [firstAttachmentId],
        ownerThreadId: threadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        commandId: "cmd-attachment-edit-resend",
        messageId,
        now: new Date().toISOString(),
      }),
    );
    expect(editResendClaim.status).toBe("claimed");
    await expect(
      system.run(engine.dispatch(command, { attachmentPrincipal: principal })),
    ).resolves.toEqual(accepted);

    await expect(
      system.run(
        engine.dispatch(
          {
            ...command,
            message: {
              ...command.message,
              attachments: [{ ...command.message.attachments[0]!, id: secondAttachmentId }],
            },
          },
          { attachmentPrincipal: principal },
        ),
      ),
    ).rejects.toThrow("Command identity collision");

    const claimed = await system.run(repository.findClaimedForCommand({ commandId }));
    expect(claimed.map((attachment) => attachment.attachmentId)).toEqual([firstAttachmentId]);
    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-create"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
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
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-delete"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-update"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-turn-diff-create"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
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
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-complete"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/synara/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/synara/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-flaky-1"),
          threadId: ThreadId.makeUnsafe("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
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
      ),
    ).rejects.toThrow("failed unexpectedly");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-flaky-2"),
        threadId: ThreadId.makeUnsafe("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
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

    expect(result.sequence).toBe(2);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-atomic-create"),
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
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

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-turn-start-atomic"),
      threadId: ThreadId.makeUnsafe("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "failed unexpectedly",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("keeps processing later commands after an unexpected worker defect", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldDieProjection = true;
    const defectiveProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: (event) => {
        if (
          shouldDieProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-project-defect-1")
        ) {
          shouldDieProjection = false;
          return Effect.die("projection defect");
        }
        return Effect.void;
      },
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, defectiveProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-1"),
          projectId: asProjectId("project-defect-1"),
          title: "Defective Project",
          workspaceRoot: "/tmp/project-defect-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-2"),
          projectId: asProjectId("project-defect-2"),
          title: "Recovered Project",
          workspaceRoot: "/tmp/project-defect-2",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        sequence: expect.any(Number),
      }),
    );

    const eventsAfterRecovery = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRecovery.map((event) => event.commandId)).toEqual([
      CommandId.makeUnsafe("cmd-project-defect-1"),
      CommandId.makeUnsafe("cmd-project-defect-2"),
    ]);
    expect(eventsAfterRecovery.every((event) => event.type === "project.created")).toBe(true);

    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-sync-create"),
        threadId: ThreadId.makeUnsafe("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
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

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(3);
    expect(updatedThread?.title).toBe("sync-after-failed-projection");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-invariant-missing-thread"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("retries deferred projection catch-up while idle until it recovers", async () => {
    let bootstrapCalls = 0;
    let deferredCalls = 0;
    let resolveRecoveryBootstrap: (() => void) | null = null;
    const recoveryBootstrap = new Promise<void>((resolve) => {
      resolveRecoveryBootstrap = resolve;
    });

    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.suspend(() => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 2 || bootstrapCalls === 3) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.deferredProjectionBootstrap",
              detail: "deferred projection bootstrap failed transiently",
            }),
          );
        }
        if (bootstrapCalls === 4) {
          resolveRecoveryBootstrap?.();
        }
        return Effect.void;
      }),
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => {
        deferredCalls += 1;
        if (deferredCalls === 1) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.deferredProjection",
              detail: "deferred projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-deferred-recovery"),
        projectId: asProjectId("project-deferred-recovery"),
        title: "Deferred Recovery Project",
        workspaceRoot: "/tmp/project-deferred-recovery",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-deferred-recovery"),
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        projectId: asProjectId("project-deferred-recovery"),
        title: "deferred-recovery",
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

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-deferred-recovery"),
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        message: {
          messageId: asMessageId("msg-deferred-recovery"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await recoveryBootstrap;

    expect(result.sequence).toBe(4);
    expect(deferredCalls).toBeGreaterThanOrEqual(1);
    expect(bootstrapCalls).toBe(4);
    await vi.waitFor(async () => {
      expect(await runtime.runPromise(engine.getProjectionCatchUpStatus)).toEqual({
        state: "healthy",
        inFlight: false,
        retryAttempts: 0,
        lastFailure: null,
      });
    });

    await runtime.dispose();
  });

  it("restores the repair backup when rebuilt projectors do not reach the captured fence", async () => {
    const nonAdvancingProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => Effect.void,
    };
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(
          Layer.succeed(OrchestrationProjectionPipeline, nonAdvancingProjectionPipeline),
        ),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-repair-fence"),
        projectId: asProjectId("project-repair-fence"),
        title: "Repair Fence Project",
        workspaceRoot: "/tmp/project-repair-fence",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    const beforeRepair = await runtime.runPromise(engine.getReadModel());

    await expect(runtime.runPromise(engine.repairState())).rejects.toThrow(
      "did not reach captured event fence 1",
    );
    await expect(runtime.runPromise(engine.getReadModel())).resolves.toEqual(beforeRepair);

    await runtime.dispose();
  });

  it("retires an empty existing project when re-adding the same workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stale-create"),
        projectId: asProjectId("project-stale"),
        title: "Stale Project",
        workspaceRoot: "/tmp/readd-project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-readd-create"),
          projectId: asProjectId("project-readd"),
          title: "Readded Project",
          workspaceRoot: "/tmp/readd-project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual({ sequence: 3 });

    const readModel = await system.run(engine.getReadModel());
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-stale"))?.deletedAt,
    ).toBe(createdAt);
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-readd"))?.deletedAt,
    ).toBeNull();

    await system.dispose();
  });

  it("keeps rejecting a duplicate workspace root when the existing project has threads", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-active-create"),
        projectId: asProjectId("project-active"),
        title: "Active Project",
        workspaceRoot: "/tmp/active-project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-active-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-active"),
        projectId: asProjectId("project-active"),
        title: "active",
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

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-active-duplicate-create"),
          projectId: asProjectId("project-active-duplicate"),
          title: "Active Duplicate",
          workspaceRoot: "/tmp/active-project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects duplicate Studio workspace containers", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-project-create"),
        projectId: asProjectId("project-studio"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-studio-project-duplicate-create"),
          projectId: asProjectId("project-studio-duplicate"),
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/tmp/synara-studio",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects Studio and regular projects claiming each other's workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-studio-create"),
        projectId: asProjectId("project-cross-kind-studio"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-cross-kind-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-project-create"),
        projectId: asProjectId("project-cross-kind-app"),
        kind: "project",
        title: "App",
        workspaceRoot: "/tmp/synara-cross-kind-app",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    // Adding the Studio container's folder as a regular project must not create a second
    // active project on that root (the empty container would otherwise be silently retired).
    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-project-on-studio-root"),
          projectId: asProjectId("project-on-studio-root"),
          kind: "project",
          title: "Studio folder",
          workspaceRoot: "/tmp/synara-cross-kind-studio",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // Creating a Studio container on a root an existing regular project owns must fail too.
    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-studio-on-project-root"),
          projectId: asProjectId("project-studio-on-project-root"),
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/tmp/synara-cross-kind-app",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // Root moves are covered by the same cross-kind ownership rule.
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-project-root-update"),
          projectId: asProjectId("project-cross-kind-app"),
          workspaceRoot: "/tmp/synara-cross-kind-studio",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // A kind-only update must not carry an existing pin onto a kind that can never be pinned.
    await system.run(
      engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-pin-app"),
        projectId: asProjectId("project-cross-kind-app"),
        isPinned: true,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-pinned-kind-change"),
          projectId: asProjectId("project-cross-kind-app"),
          kind: "studio",
          workspaceRoot: "/tmp/synara-cross-kind-pinned-studio",
        }),
      ),
    ).rejects.toThrow("Only projects can be pinned.");

    // A kind-only update must not bypass ownership either: a chat project sitting on an owned
    // root cannot become a workspace-owning kind without the root check running.
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-chat-create"),
        projectId: asProjectId("project-cross-kind-chat"),
        kind: "chat",
        title: "Home",
        workspaceRoot: "/tmp/synara-cross-kind-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-chat-kind-only-update"),
          projectId: asProjectId("project-cross-kind-chat"),
          kind: "studio",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects moving a Studio container onto another Studio workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-source-create"),
        projectId: asProjectId("project-studio-source"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio-source",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-target-create"),
        projectId: asProjectId("project-studio-target"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio-target",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-studio-target-root-update"),
          projectId: asProjectId("project-studio-target"),
          workspaceRoot: "/tmp/synara-studio-source",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
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

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
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
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("keeps the worker alive when a command throws while its pipeline is built", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const poisonedCommandId = CommandId.makeUnsafe("cmd-engine-poison");
    fingerprintPoison.add(poisonedCommandId);

    try {
      const poisonedOutcome = await system.run(
        Effect.result(
          system.engine.dispatch({
            type: "project.create",
            commandId: poisonedCommandId,
            projectId: asProjectId("project-engine-poison"),
            title: "Poisoned",
            workspaceRoot: "/tmp/engine-poison",
            defaultModelSelection: null,
            createdAt,
          }),
        ).pipe(Effect.timeoutOption("5 seconds")),
      );

      // The defect fails this command immediately instead of leaving the caller to
      // wait out the dispatch timeout.
      expect(Option.isSome(poisonedOutcome)).toBe(true);
      const outcome = Option.getOrThrow(poisonedOutcome);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({ _tag: "OrchestrationCommandInternalError" });
      }

      // The worker survived: the next command still runs.
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-engine-poison-next"),
            projectId: asProjectId("project-engine-poison-next"),
            title: "After poison",
            workspaceRoot: "/tmp/engine-poison-next",
            defaultModelSelection: null,
            createdAt,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });

      // The poisoned envelope was still finished, so `outstanding` did not leak.
      const drained = await system.run(
        Effect.timeoutOption(system.engine.drain, "5 seconds").pipe(Effect.map(Option.isSome)),
      );
      expect(drained).toBe(true);
    } finally {
      fingerprintPoison.delete(poisonedCommandId);
      await system.dispose();
    }
  });
});
