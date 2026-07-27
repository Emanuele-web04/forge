// FILE: ProviderCommandReactor.test.ts
// Purpose: Verifies provider intent orchestration, queueing, rollback, and transcript bootstrap flows.
// Layer: Orchestration integration tests
// Depends on: ProviderCommandReactorLive with in-memory provider and persistence services.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ModelSelection,
  OrchestrationEvent,
  ProviderForkThreadResult,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { PROVIDER_DELIVERY_BLOCK_SUMMARY } from "@synara/shared/providerDeliveryBlock";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  classifyProviderAttemptOutcome,
  isSafeLegacyProviderBlocker,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  StudioOutputReactor,
  type StudioOutputReactorShape,
} from "../Services/StudioOutputReactor.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { resolveProviderAttachmentPath } from "../../provider/providerAttachmentPaths.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

describe("legacy provider blocker recovery", () => {
  it("keeps process lifecycle failures uncertain", () => {
    const outcome = classifyProviderAttemptOutcome(
      Exit.fail(
        new ProviderAdapterProcessError({
          provider: "claudeAgent",
          threadId: ThreadId.makeUnsafe("thread-exit-unproven"),
          detail: "Provider process tree did not prove exit (rootExited=false).",
        }),
      ),
    );

    expect(outcome._tag).toBe("uncertain");
  });

  it("accepts only failures that prove the command frame was not written", () => {
    expect(
      isSafeLegacyProviderBlocker(
        "Provider process tree 66212 did not prove exit (rootExited=true, captureComplete=false; no captured descendants remain).",
      ),
    ).toBe(false);
    expect(
      isSafeLegacyProviderBlocker("Codex app-server stdin closed before the frame was written."),
    ).toBe(true);
    expect(
      isSafeLegacyProviderBlocker(
        "Provider process tree did not prove exit (rootExited=false, captureComplete=true).",
      ),
    ).toBe(false);
    expect(
      isSafeLegacyProviderBlocker(
        "Provider process tree did not prove exit (rootExited=true, captureComplete=false; captured descendants remain).",
      ),
    ).toBe(false);
    expect(isSafeLegacyProviderBlocker("Provider process tree did not prove exit.")).toBe(false);
    expect(isSafeLegacyProviderBlocker("The provider rejected the prompt.")).toBe(false);
  });
});

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session" | "restart-session";
    readonly conversationRollback?: "native" | "restart-session";
    readonly checkpointStore?: Partial<CheckpointStoreShape>;
    readonly studioOutputReactor?: Partial<StudioOutputReactorShape>;
    readonly forkThreadResult?: ProviderForkThreadResult | null;
    readonly startReactor?: boolean;
    readonly interruptTurn?: ProviderServiceShape["interruptTurn"];
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "synara-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const sessionModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? ((input as { modelSelection?: ModelSelection }).modelSelection ?? modelSelection)
          : modelSelection;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider: sessionModelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(sessionModelSelection.model !== undefined
          ? { model: sessionModelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    // Mirrors adapter behavior: the reactor consults live provider sessions
    // (status + activeTurnId) to decide whether a turn is genuinely running.
    const setRuntimeSessionTurnState = (input: {
      readonly threadId: string;
      readonly status: ProviderSession["status"];
      readonly activeTurnId?: TurnId;
    }) => {
      const threadId = ThreadId.makeUnsafe(input.threadId);
      const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
      const base: ProviderSession = runtimeSessions[index] ?? {
        provider: modelSelection.provider,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        resumeCursor: { opaque: "resume-synthetic" },
        createdAt: now,
        updatedAt: now,
      };
      const next: ProviderSession = {
        ...base,
        status: input.status,
        ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
      };
      if (input.activeTurnId === undefined) {
        delete (next as { activeTurnId?: TurnId }).activeTurnId;
      }
      if (index >= 0) {
        runtimeSessions[index] = next;
      } else {
        runtimeSessions.push(next);
      }
    };
    const steerTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-steer-1"),
      }),
    );
    const startReview = vi.fn<ProviderServiceShape["startReview"]>((input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: asTurnId("turn-review-1"),
      }),
    );
    const forkThread = vi.fn<NonNullable<ProviderServiceShape["forkThread"]>>((forkInput) =>
      Effect.sync(() => {
        const result = input?.forkThreadResult ?? null;
        const forkModelSelection = forkInput.modelSelection ?? modelSelection;
        if (result && !runtimeSessions.some((session) => session.threadId === forkInput.threadId)) {
          runtimeSessions.push({
            provider: forkModelSelection.provider,
            status: "ready",
            runtimeMode: forkInput.runtimeMode,
            ...(forkModelSelection.model !== undefined ? { model: forkModelSelection.model } : {}),
            threadId: forkInput.threadId,
            ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
        return result;
      }),
    );
    const interruptTurn = vi.fn(input?.interruptTurn ?? ((_: unknown) => Effect.void));
    const stopTask = vi.fn<ProviderServiceShape["stopTask"]>(() => Effect.void);
    const backgroundTask = vi.fn<ProviderServiceShape["backgroundTask"]>(() => Effect.void);
    const hasLiveRuntimeTasks = vi.fn<NonNullable<ProviderServiceShape["hasLiveRuntimeTasks"]>>(
      () => Effect.succeed(false),
    );
    const steerSubagent = vi.fn<ProviderServiceShape["steerSubagent"]>(() => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
      () => Effect.void,
    );
    const restoreCheckpoint = vi.fn<CheckpointStoreShape["restoreCheckpoint"]>(() =>
      Effect.succeed(true),
    );
    const isGitRepository = vi.fn<CheckpointStoreShape["isGitRepository"]>(() =>
      Effect.succeed(false),
    );
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() => Effect.void);
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository,
      captureCheckpoint,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint,
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
      ...input?.checkpointStore,
    };
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const stopRuntimeSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const clearSessionResumeCursor = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const preserveActiveRuntime =
          typeof input === "object" &&
          input !== null &&
          "preserveActiveRuntime" in input &&
          (input as { preserveActiveRuntime?: boolean }).preserveActiveRuntime === true;
        if (preserveActiveRuntime) {
          return;
        }
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const publishBranch = vi.fn(() => Effect.void);
    const withMutation: GitCoreShape["withMutation"] = (_cwd, effect) => effect;
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const captureStudioOutputBaseline = vi.fn<
      StudioOutputReactorShape["captureBaselineBeforeTurn"]
    >(input?.studioOutputReactor?.captureBaselineBeforeTurn ?? (() => Effect.void));
    const cancelPendingStudioOutputBaseline = vi.fn<
      StudioOutputReactorShape["cancelPendingTurnBaseline"]
    >(input?.studioOutputReactor?.cancelPendingTurnBaseline ?? (() => Effect.void));
    const studioOutputReactor: StudioOutputReactorShape = {
      captureBaselineBeforeTurn: captureStudioOutputBaseline,
      cancelPendingTurnBaseline: cancelPendingStudioOutputBaseline,
      start: input?.studioOutputReactor?.start ?? Effect.void,
      drain: input?.studioOutputReactor?.drain ?? Effect.void,
    };

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      startReview,
      forkThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      steerSubagent,
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      stopRuntimeSession: stopRuntimeSession as NonNullable<
        ProviderServiceShape["stopRuntimeSession"]
      >,
      clearSessionResumeCursor: clearSessionResumeCursor as NonNullable<
        ProviderServiceShape["clearSessionResumeCursor"]
      >,
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          ...(input?.conversationRollback
            ? { conversationRollback: input.conversationRollback }
            : {}),
        }),
      rollbackConversation,
      compactThread: () => unsupported(),
      closeRuntimeEvents: Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(StudioOutputReactor, studioOutputReactor)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(GitCore, {
          renameBranch,
          publishBranch,
          withMutation,
        } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(layer);
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid));

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const deliveryRepository = await runtime.runPromise(
      Effect.service(OrchestrationEventDeliveryRepository),
    );
    const queuedTurnPromotionRepository = await runtime.runPromise(
      Effect.service(QueuedTurnPromotionRepository),
    );
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const managedAttachments = await runtime.runPromise(
      Effect.service(ManagedAttachmentRepository),
    );
    const pendingInteractionRepository = await runtime.runPromise(
      Effect.service(ProjectionPendingInteractionRepository),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    let reactorStarted = false;
    const startReactor = async () => {
      if (reactorStarted) return;
      await Effect.runPromise(reactor.start.pipe(Scope.provide(scope!)));
      reactorStarted = true;
    };
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      reactor,
      startSession,
      sendTurn,
      steerTurn,
      startReview,
      forkThread,
      interruptTurn,
      stopTask,
      backgroundTask,
      hasLiveRuntimeTasks,
      steerSubagent,
      respondToRequest,
      respondToUserInput,
      rollbackConversation,
      isGitRepository,
      captureCheckpoint,
      restoreCheckpoint,
      stopSession,
      stopRuntimeSession,
      clearSessionResumeCursor,
      renameBranch,
      publishBranch,
      generateBranchName,
      generateThreadTitle,
      captureStudioOutputBaseline,
      cancelPendingStudioOutputBaseline,
      stateDir,
      stageAttachment: async (
        attachment: {
          readonly type: "image" | "file";
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly sizeBytes: number;
        },
        ownerThreadId = "thread-1",
      ) => {
        const flatRelativePath = attachmentRelativePath(attachment);
        const relativePath = attachment.id.startsWith("att_v2_")
          ? `objects/${attachment.id.slice(7, 9)}/${flatRelativePath}`
          : flatRelativePath;
        const attachmentPath = path.join(stateDir, "attachments", relativePath);
        fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
        if (!fs.existsSync(attachmentPath)) {
          fs.writeFileSync(attachmentPath, Buffer.alloc(attachment.sizeBytes));
        }
        const stagedAt = new Date().toISOString();
        await runtime.runPromise(
          managedAttachments
            .reserve({
              attachmentId: attachment.id,
              ownerThreadId,
              ownerKind: "local-loopback",
              ownerId: "local-loopback",
              kind: attachment.type,
              originalName: attachment.name,
              mimeType: attachment.mimeType,
              reservedBytes: attachment.sizeBytes,
              relativePath,
              now: stagedAt,
            })
            .pipe(
              Effect.andThen(
                managedAttachments.finalizeStaged({
                  attachmentId: attachment.id,
                  ownerThreadId,
                  ownerKind: "local-loopback",
                  ownerId: "local-loopback",
                  sizeBytes: attachment.sizeBytes,
                  sha256: "0".repeat(64),
                  stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                  now: stagedAt,
                }),
              ),
            ),
        );
        return attachmentPath;
      },
      drain,
      emitRuntimeEvent,
      setRuntimeSessionTurnState,
      startReactor,
      deliveryRepository,
      pendingInteractionRepository,
      persistWithoutLivePublication: async (
        events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
      ) => {
        const persisted: OrchestrationEvent[] = [];
        for (const event of events) {
          const versions = await runtime.runPromise(sql<{ readonly version: number }>`
            SELECT COALESCE(MAX(stream_version), -1) + 1 AS version
            FROM orchestration_events
            WHERE aggregate_kind = ${event.aggregateKind}
              AND stream_id = ${event.aggregateId}
          `);
          const inserted = await runtime.runPromise(sql<{ readonly sequence: number }>`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, causation_event_id, correlation_id,
              actor_kind, payload_json, metadata_json
            ) VALUES (
              ${event.eventId}, ${event.aggregateKind}, ${event.aggregateId},
              ${versions[0]!.version}, ${event.type},
              ${event.occurredAt}, ${event.commandId}, ${event.causationEventId},
              ${event.correlationId}, 'user', ${JSON.stringify(event.payload)},
              ${JSON.stringify(event.metadata)}
            )
            RETURNING sequence
          `);
          const saved = { ...event, sequence: inserted[0]!.sequence } as OrchestrationEvent;
          persisted.push(saved);
          if (saved.type === "thread.message-sent") {
            await runtime.runPromise(sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, is_streaming,
                created_at, updated_at, source, sequence, dispatch_mode
              ) VALUES (
                ${saved.payload.messageId}, ${saved.payload.threadId}, ${saved.payload.turnId},
                ${saved.payload.role}, ${saved.payload.text},
                ${saved.payload.streaming ? 1 : 0}, ${saved.payload.createdAt},
                ${saved.payload.updatedAt}, ${saved.payload.source}, ${saved.sequence},
                ${saved.payload.dispatchMode ?? null}
              )
            `);
          }
        }
        return persisted;
      },
      persistSessionWithoutLivePublication: async (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly updatedAt: string;
      }) =>
        runtime.runPromise(sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, runtime_mode,
            active_turn_id, last_error, updated_at
          ) VALUES (
            ${input.threadId}, 'running', 'codex', 'approval-required',
            ${input.turnId}, NULL, ${input.updatedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            status = excluded.status,
            provider_name = excluded.provider_name,
            runtime_mode = excluded.runtime_mode,
            active_turn_id = excluded.active_turn_id,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `),
      queuedTurnPromotionRepository,
    };
  }

  async function seedRollbackTarget(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly createdAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`cmd-import-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: input.messageId,
            role: "user",
            text: "rollback target",
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        ],
        createdAt: input.createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe(`cmd-assistant-complete-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe(`assistant-${input.messageId}`),
        turnId: input.turnId,
        createdAt: input.createdAt,
      }),
    );
  }

  async function readHarnessThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId = ThreadId.makeUnsafe("thread-1"),
  ) {
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    return readModel.threads.find((thread) => thread.id === threadId);
  }

  it("REL-01B gate: delivers intents committed before the reactor subscribes", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = new Date().toISOString();
    const commandId = CommandId.makeUnsafe("cmd-durable-before-subscribe");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-durable-before-subscribe");

    harness.setRuntimeSessionTurnState({
      threadId,
      status: "running",
      activeTurnId: turnId,
    });
    await harness.persistSessionWithoutLivePublication({ threadId, turnId, updatedAt: now });

    await harness.persistWithoutLivePublication([
      {
        eventId: asEventId("evt-durable-interrupt-before-subscribe"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId,
          turnId,
          createdAt: now,
        },
      },
    ]);
    expect(harness.interruptTurn).not.toHaveBeenCalled();

    await harness.startReactor();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      turnId,
    });
  });

  it("REL-01B gate: advances the durable cursor through irrelevant events", async () => {
    const harness = await createHarness({ startReactor: false });
    const before = await Effect.runPromise(
      harness.deliveryRepository.getConsumerState("provider-command-reactor.v1"),
    );
    expect(before.pipe(Option.getOrThrow).lastAckedSequence).toBe(0);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const lastSequence = events.at(-1)!.sequence;
    await harness.startReactor();

    const after = await Effect.runPromise(
      harness.deliveryRepository.getConsumerState("provider-command-reactor.v1"),
    );
    expect(after.pipe(Option.getOrThrow).lastAckedSequence).toBe(lastSequence);
    const projectDelivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: events[0]!.sequence,
      }),
    );
    expect(Option.isNone(projectDelivery)).toBe(true);
  });

  it("REL-01B gate: reclaims an expired safe claim during startup replay", async () => {
    const harness = await createHarness({ startReactor: false });
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const threadCreated = events.find((event) => event.type === "thread.created")!;
    await Effect.runPromise(
      harness.deliveryRepository.claim({
        consumerName: "provider-command-reactor.v1",
        eventSequence: threadCreated.sequence,
        threadId: ThreadId.makeUnsafe("thread-1"),
        claimOwner: "crashed-process",
        claimedAt: "2020-01-01T00:00:00.000Z",
        claimExpiresAt: "2020-01-01T00:01:00.000Z",
      }),
    );

    await harness.startReactor();
    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: threadCreated.sequence,
      }),
    );
    expect(delivery.pipe(Option.getOrThrow)).toMatchObject({
      state: "succeeded",
      attemptCount: 2,
    });
  });

  it("REL-01B gate: quarantines an expired external claim without replaying it", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-durable-expired-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-durable-expired"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-durable-expired-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-durable-expired"),
        createdAt: now,
      }),
    );
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const interruptRequested = events.find(
      (event) => event.type === "thread.turn-interrupt-requested",
    )!;
    await Effect.runPromise(
      harness.deliveryRepository.claim({
        consumerName: "provider-command-reactor.v1",
        eventSequence: interruptRequested.sequence,
        threadId: "thread-1",
        claimOwner: "crashed-provider-command-process",
        claimedAt: "2020-01-01T00:00:00.000Z",
        claimExpiresAt: "2020-01-01T00:01:00.000Z",
      }),
    );

    await harness.startReactor();

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: interruptRequested.sequence,
      }),
    );
    expect(delivery.pipe(Option.getOrThrow)).toMatchObject({
      state: "uncertain",
      attemptCount: 1,
    });
    const consumerState = await Effect.runPromise(
      harness.deliveryRepository.getConsumerState("provider-command-reactor.v1"),
    );
    expect(consumerState.pipe(Option.getOrThrow).lastAckedSequence).toBe(events.at(-1)!.sequence);
  });

  // The ambiguous command here is a conversation rollback whose provider
  // interrupt cannot prove it landed. A bare `thread.turn.interrupt` never
  // quarantines a thread on purpose: it escalates to a full session stop, so
  // the stop button can never leave a thread blocked (see the exemption below).
  it("REL-01B gate: quarantines one thread and resumes it after explicit safe retry", async () => {
    const failure = new ProviderAdapterRequestError({
      provider: "codex",
      method: "turn/interrupt",
      detail: "connection closed after request write",
    });
    let failFirstThreadInterrupt = true;
    const harness = await createHarness({
      interruptTurn: (request) => {
        if (request.threadId === ThreadId.makeUnsafe("thread-1") && failFirstThreadInterrupt) {
          failFirstThreadInterrupt = false;
          return Effect.fail(failure);
        }
        return Effect.void;
      },
    });
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-durable-uncertain"),
      turnId: asTurnId("turn-durable-rolled-back"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-durable-unrelated-thread"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        projectId: asProjectId("project-1"),
        title: "Unrelated thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
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
        commandId: CommandId.makeUnsafe("cmd-durable-uncertain-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-durable-uncertain"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-durable-unrelated-session"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-2"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-durable-unrelated"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-durable-uncertain-rollback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-durable-uncertain"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(async () =>
      Effect.runPromise(
        harness.deliveryRepository
          .firstBlockingDelivery("provider-command-reactor.v1")
          .pipe(Effect.map(Option.isSome)),
      ),
    );
    const blocker = await Effect.runPromise(
      harness.deliveryRepository.firstBlockingDelivery("provider-command-reactor.v1"),
    );
    expect(blocker.pipe(Option.getOrThrow)).toMatchObject({
      threadId: "thread-1",
      state: "uncertain",
      attemptCount: 1,
    });

    // Interrupts are the escape hatch out of a quarantined thread, so the
    // blocked thread still runs its own interrupt; the unrelated thread is
    // untouched by another thread's quarantine.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-durable-blocked-continuation"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-durable-uncertain"),
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-durable-unrelated-continuation"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        turnId: asTurnId("turn-durable-unrelated"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 3);
    expect(harness.interruptTurn.mock.calls.map(([request]) => request.threadId)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
    // The quarantined command itself never ran: no rollback reached the provider.
    expect(harness.rollbackConversation.mock.calls.length).toBe(0);
    const unrelatedBlocker = await Effect.runPromise(
      harness.deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: "provider-command-reactor.v1",
        threadId: "thread-2",
      }),
    );
    expect(Option.isNone(unrelatedBlocker)).toBe(true);

    // A non-exempt side effect on the blocked thread is skipped while the
    // quarantine holds, and must be replayed once the thread resumes.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-durable-blocked-task-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-durable-blocked",
        createdAt: now,
      }),
    );
    const highWater = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
    await waitFor(async () => {
      const state = await Effect.runPromise(
        harness.deliveryRepository.getConsumerState("provider-command-reactor.v1"),
      );
      return state.pipe(Option.getOrThrow).lastAckedSequence >= highWater;
    });
    expect(harness.stopTask.mock.calls.length).toBe(0);

    const reconciliation = await Effect.runPromise(
      harness.reactor.reconcileDelivery({
        eventSequence: blocker.pipe(Option.getOrThrow).eventSequence,
        threadId: ThreadId.makeUnsafe("thread-1"),
        expectedState: "uncertain",
        outcome: "safe_retry",
        reconciledBy: "test-operator",
        note: "provider confirmed the first request was not accepted",
      }),
    );
    expect(reconciliation).toMatchObject({
      outcome: "safe_retry",
      state: "succeeded",
    });
    await waitFor(() => harness.interruptTurn.mock.calls.length === 4);
    expect(harness.interruptTurn.mock.calls.map(([request]) => request.threadId)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
    // The authorized retry completed the previously blocked rollback and
    // replayed the side effect the quarantine had skipped.
    expect(harness.rollbackConversation.mock.calls.length).toBe(1);
    await waitFor(() => harness.stopTask.mock.calls.length === 1);
    expect(harness.stopTask.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      taskId: "task-durable-blocked",
    });
    expect(
      Option.isNone(
        await Effect.runPromise(
          harness.deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: "provider-command-reactor.v1",
            threadId: "thread-1",
          }),
        ),
      ),
    ).toBe(true);
  });

  // Recovery contract behind the web "Unblock thread" action: abandoning the
  // blocker never replays the ambiguous command itself, but the turn starts the
  // quarantine skipped afterwards were provably never sent, so they are replayed.
  it("REL-01B gate: abandoning a blocker replays turn starts skipped while quarantined", async () => {
    const harness = await createHarness({
      interruptTurn: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/interrupt",
            detail: "connection closed after request write",
          }),
        ),
    });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-abandon-source");
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-abandon-source"),
      turnId: asTurnId("turn-abandon-rolled-back"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-abandon-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    // A rollback whose provider interrupt cannot prove it landed is ambiguous,
    // so it quarantines the thread instead of retrying itself.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-abandon-rollback"),
        threadId,
        messageId: asMessageId("user-message-abandon-source"),
        numTurns: 1,
        createdAt: now,
      }),
    );
    await waitFor(async () =>
      Effect.runPromise(
        harness.deliveryRepository
          .firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId,
          })
          .pipe(Effect.map(Option.isSome)),
      ),
    );

    // Settle the session so the follow-up message starts a turn instead of queueing.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-abandon-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    const skippedTurn = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-abandon-skipped-turn"),
        threadId,
        message: {
          messageId: asMessageId("abandon-skipped-user"),
          role: "user",
          text: "Message sent while the thread was blocked",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const state = await Effect.runPromise(
        harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
      );
      return state.pipe(Option.getOrThrow).lastAckedSequence >= skippedTurn.sequence;
    });
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    expect((await readHarnessThread(harness))?.session?.lastError).toContain(
      PROVIDER_DELIVERY_BLOCK_SUMMARY,
    );

    const blocker = (
      await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId,
        }),
      )
    ).pipe(Option.getOrThrow);
    const reconciled = await Effect.runPromise(
      harness.reactor.reconcileDelivery({
        eventSequence: blocker.eventSequence,
        threadId,
        expectedState: "uncertain",
        outcome: "abandon",
        reconciledBy: "local-loopback:local-loopback",
        note: "Unblocked from the thread error banner.",
      }),
    );

    expect(reconciled).toMatchObject({ outcome: "abandon", state: "succeeded" });
    // The abandoned rollback is never retried; the skipped message is.
    expect(harness.interruptTurn.mock.calls.length).toBe(1);
    expect(harness.rollbackConversation.mock.calls.length).toBe(0);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(
      Option.isNone(
        await Effect.runPromise(
          harness.deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId,
          }),
        ),
      ),
    ).toBe(true);
  });

  it("REL-01D gate: retries an ambiguous provider command only after explicit reconciliation", async () => {
    let interruptAttempts = 0;
    const harness = await createHarness({
      interruptTurn: () => {
        interruptAttempts += 1;
        return interruptAttempts === 1
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "turn/interrupt",
                detail: "connection closed after request write",
              }),
            )
          : Effect.void;
      },
    });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-operator-retry");
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-operator-retry"),
      turnId: asTurnId("turn-operator-retry-rolled-back"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-operator-retry-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-operator-retry-rollback"),
        threadId,
        messageId: asMessageId("user-message-operator-retry"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(async () =>
      Effect.runPromise(
        harness.deliveryRepository
          .firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId,
          })
          .pipe(Effect.map(Option.isSome)),
      ),
    );
    expect(interruptAttempts).toBe(1);
    // The ambiguous command stays unexecuted until an operator decides.
    expect(harness.rollbackConversation.mock.calls.length).toBe(0);
    const requested = (
      await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId,
        }),
      )
    ).pipe(Option.getOrThrow);

    const reconciled = await Effect.runPromise(
      harness.reactor.reconcileDelivery({
        eventSequence: requested.eventSequence,
        threadId,
        expectedState: "uncertain",
        outcome: "safe_retry",
        reconciledBy: "test-operator",
        note: "Provider confirms the first request was not accepted.",
      }),
    );

    expect(reconciled).toMatchObject({
      eventSequence: requested.eventSequence,
      threadId,
      outcome: "safe_retry",
      state: "succeeded",
    });
    expect(interruptAttempts).toBe(2);
    expect(harness.rollbackConversation.mock.calls.length).toBe(1);
    const blocker = await Effect.runPromise(
      harness.deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId,
      }),
    );
    expect(Option.isNone(blocker)).toBe(true);
  });

  it("REL-01D gate: resumes an operator-authorized retry after process loss", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-operator-retry-restart");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-operator-retry-restart-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    const requested = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-operator-retry-restart-interrupt"),
        threadId,
        turnId,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.deliveryRepository.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: requested.sequence,
        threadId,
        claimOwner: "crashed-before-reconciliation",
        claimedAt: now,
        claimExpiresAt: now,
      }),
    );
    await Effect.runPromise(
      harness.deliveryRepository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: requested.sequence,
        expectedClaimOwner: "crashed-before-reconciliation",
        state: "uncertain",
        error: "provider acceptance is unknown",
        updatedAt: now,
      }),
    );
    const events = Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
    );
    for (const event of events) {
      await Effect.runPromise(
        harness.deliveryRepository.advanceCursor({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: event.sequence,
          updatedAt: now,
        }),
      );
    }
    await Effect.runPromise(
      harness.deliveryRepository.reconcile({
        reconciliationId: "reconcile-before-restart",
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: requested.sequence,
        threadId,
        expectedState: "uncertain",
        outcome: "safe_retry",
        reconciledBy: "test-operator",
        reconciledAt: now,
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: requested.sequence,
      }),
    );
    expect(delivery.pipe(Option.getOrThrow).state).toBe("succeeded");
  });

  it("REL-01B gate: recovers a claimed queued promotion after restart", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = asMessageId("message-durable-queued-promotion");
    const commandId = CommandId.makeUnsafe("cmd-durable-queued-promotion");
    const messageEventId = asEventId("evt-durable-queued-message");
    const persisted = await harness.persistWithoutLivePublication([
      {
        eventId: messageEventId,
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "recover queued promotion",
          dispatchMode: "queue",
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        eventId: asEventId("evt-durable-turn-queued"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId,
        causationEventId: messageEventId,
        correlationId: commandId,
        metadata: {},
        type: "thread.turn-queued",
        payload: {
          threadId,
          messageId,
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
      },
    ]);
    const queuedEvent = persisted[1]!;
    await Effect.runPromise(
      harness.queuedTurnPromotionRepository.enqueue({
        queuedEventSequence: queuedEvent.sequence,
        threadId,
        messageId,
        dispatchMode: "queue",
        createdAt: now,
      }),
    );
    const allEvents = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((events) => Array.from(events)),
      ),
    );
    for (const event of allEvents) {
      await Effect.runPromise(
        harness.deliveryRepository.advanceCursor({
          consumerName: "provider-command-reactor.v1",
          eventSequence: event.sequence,
          updatedAt: now,
        }),
      );
    }
    await Effect.runPromise(
      harness.queuedTurnPromotionRepository.claimNext({
        threadId,
        claimOwner: "crashed-provider-reactor",
        claimedAt: now,
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    await harness.startReactor();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      input: "recover queued promotion",
    });
    const promotion = await Effect.runPromise(
      harness.queuedTurnPromotionRepository.getBySequence(queuedEvent.sequence),
    );
    expect(promotion.pipe(Option.getOrThrow)).toMatchObject({
      state: "promoted",
      attemptCount: 2,
    });
  });

  it("cancels queued promotions when its thread is deleted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = asMessageId("message-deleted-thread-queued");
    const commandId = CommandId.makeUnsafe("cmd-deleted-thread-queued");
    // Insert a real turn-queued source event WITHOUT live publication: a running
    // reactor never observes it (so it cannot drain the promotion), but it gives
    // the promotion row a valid FK target to reference.
    const persisted = await harness.persistWithoutLivePublication([
      {
        eventId: asEventId("evt-deleted-thread-turn-queued"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "thread.turn-queued",
        payload: {
          threadId,
          messageId,
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
      },
    ]);
    const queuedEvent = persisted[0]!;
    await Effect.runPromise(
      harness.queuedTurnPromotionRepository.enqueue({
        queuedEventSequence: queuedEvent.sequence,
        threadId,
        messageId,
        dispatchMode: "queue",
        createdAt: now,
      }),
    );

    // Deleting the thread must cancel its pending promotion so a stray drain can
    // never dispatch a turn for a thread that no longer exists.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-delete-thread-queued"),
        threadId,
      }),
    );

    await waitFor(async () => {
      const promotion = await Effect.runPromise(
        harness.queuedTurnPromotionRepository.getBySequence(queuedEvent.sequence),
      );
      return promotion.pipe(Option.getOrThrow).state === "cancelled";
    });
    expect(harness.sendTurn.mock.calls.length).toBe(0);
  });

  it("cancels promotions of a soft-deleted thread during startup recovery", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = asMessageId("message-recovery-soft-deleted");
    const commandId = CommandId.makeUnsafe("cmd-recovery-soft-deleted");
    const persisted = await harness.persistWithoutLivePublication([
      {
        eventId: asEventId("evt-recovery-soft-deleted-turn-queued"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "thread.turn-queued",
        payload: {
          threadId,
          messageId,
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
      },
    ]);
    const queuedEvent = persisted[0]!;
    await Effect.runPromise(
      harness.queuedTurnPromotionRepository.enqueue({
        queuedEventSequence: queuedEvent.sequence,
        threadId,
        messageId,
        dispatchMode: "queue",
        createdAt: now,
      }),
    );

    // Soft-delete the thread while the reactor is down (this projects deleted_at
    // on the thread row so it resolves to undefined).
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-recovery-delete-thread"),
        threadId,
      }),
    );

    // Advance the delivery cursor past every event so live replay drains nothing
    // on start: only startup recovery acts on the leftover promotion.
    const allEvents = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((events) => Array.from(events)),
      ),
    );
    for (const event of allEvents) {
      await Effect.runPromise(
        harness.deliveryRepository.advanceCursor({
          consumerName: "provider-command-reactor.v1",
          eventSequence: event.sequence,
          updatedAt: now,
        }),
      );
    }

    await harness.startReactor();

    await waitFor(async () => {
      const promotion = await Effect.runPromise(
        harness.queuedTurnPromotionRepository.getBySequence(queuedEvent.sequence),
      );
      return promotion.pipe(Option.getOrThrow).state === "cancelled";
    });
    expect(harness.sendTurn.mock.calls.length).toBe(0);
  });

  it("bootstraps sidechat context when the provider cannot fork natively", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-sidechat-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-sidechat"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Sidechat: Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("sidechat-imported-user"),
            role: "user",
            text: "Earlier question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("sidechat-imported-assistant"),
            role: "assistant",
            text: "Earlier answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-sidechat-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-sidechat"),
        message: {
          messageId: asMessageId("sidechat-native-user"),
          role: "user",
          text: "Fresh side question",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.forkThread.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Earlier question");
    expect(input?.input).toContain("Earlier answer");
    expect(input?.input).toContain("<sidechat_boundary>");
    expect(input?.input).toContain("Fresh side question");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-sidechat-second-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-sidechat"),
        message: {
          messageId: asMessageId("sidechat-second-user"),
          role: "user",
          text: "Second side question",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const secondInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(secondInput?.input).not.toContain("<sidechat_context>");
    expect(secondInput?.input).not.toContain("<thread_context>");
    expect(secondInput?.input).not.toContain("Earlier question");
    expect(secondInput?.input).not.toContain("Earlier answer");
    expect(secondInput?.input).toContain("Second side question");
  });

  it("bootstraps Droid sidechat context after a native provider fork", async () => {
    const threadId = ThreadId.makeUnsafe("thread-native-droid-sidechat");
    const harness = await createHarness({
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "native-droid-fork" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-native-droid-sidechat-fork-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Native Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("native-droid-sidechat-imported-user"),
            role: "user",
            text: "Imported Droid sidechat question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("native-droid-sidechat-imported-assistant"),
            role: "assistant",
            text: "Imported Droid sidechat answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-native-droid-sidechat-overlong-turn-start"),
        threadId,
        message: {
          messageId: asMessageId("native-droid-sidechat-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 100),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(
      async () => (await readHarnessThread(harness, threadId))?.session?.status === "error",
    );
    expect(harness.forkThread).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect((await readHarnessThread(harness, threadId))?.session?.lastError).toContain(
      "too long to include the sidechat context",
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-native-droid-sidechat-turn-start"),
        threadId,
        message: {
          messageId: asMessageId("native-droid-sidechat-user"),
          role: "user",
          text: "Continue the native Droid sidechat",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.forkThread).toHaveBeenCalledTimes(1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Imported Droid sidechat question");
    expect(input?.input).toContain("Imported Droid sidechat answer");
    expect(input?.input).toContain("Continue the native Droid sidechat");
    expect(input?.input?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
  });

  it("keeps thread mention context within the provider input limit", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const messageText = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-max-input-with-thread-mention"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("max-input-with-thread-mention"),
          role: "user",
          text: messageText,
          attachments: [],
          mentions: [{ name: "Current thread", path: "thread://thread-1" }],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as
      | { input?: string; mentions?: ReadonlyArray<unknown> }
      | undefined;
    expect(input?.input).toBe(messageText);
    expect(input?.input?.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(input?.mentions).toBeUndefined();
  });

  it("preserves pending sidechat context when the first turn is an overlong provider review", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-review-sidechat-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Review sidechat",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("review-sidechat-imported-user"),
            role: "user",
            text: "Context that must survive the review",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("review-sidechat-imported-assistant"),
            role: "assistant",
            text: "Prior sidechat answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-review-sidechat-review-start"),
        threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
        message: {
          messageId: asMessageId("review-sidechat-review-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        reviewTarget: { type: "uncommittedChanges" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startReview.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-review-sidechat-follow-up-start"),
        threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
        message: {
          messageId: asMessageId("review-sidechat-follow-up-user"),
          role: "user",
          text: "Continue with the side question",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Context that must survive the review");
    expect(input?.input).toContain("Prior sidechat answer");
    expect(input?.input).toContain("Continue with the side question");
  });

  it("preserves full transcript bootstrap when an overlong review restarts a sidechat", async () => {
    const threadId = ThreadId.makeUnsafe("thread-restarted-droid-sidechat");
    const harness = await createHarness({
      sessionModelSwitch: "restart-session",
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "restarted-droid-sidechat" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Restarted Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("restarted-droid-sidechat-imported-user"),
            role: "user",
            text: "Retained sidechat question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("restarted-droid-sidechat-imported-assistant"),
            role: "assistant",
            text: "Retained sidechat answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-review"),
        threadId,
        message: {
          messageId: asMessageId("restarted-droid-sidechat-review-user"),
          role: "user",
          text: "Review before restarting",
          attachments: [],
        },
        reviewTarget: { type: "uncommittedChanges" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startReview.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-overlong-review"),
        threadId,
        message: {
          messageId: asMessageId("restarted-droid-sidechat-overlong-review-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        reviewTarget: { type: "uncommittedChanges" },
        modelSelection: {
          provider: "droid",
          model: "claude-opus-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startReview.mock.calls.length === 2);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-turn"),
        threadId,
        message: {
          messageId: asMessageId("restarted-droid-sidechat-latest-user"),
          role: "user",
          text: "Continue after restarting",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<thread_context>");
    expect(input?.input).not.toContain("<sidechat_context>");
    expect(input?.input).toContain("Retained sidechat question");
    expect(input?.input).toContain("Retained sidechat answer");
    expect(input?.input).toContain("Continue after restarting");
  });

  it("blocks an overlong Droid fork turn and bootstraps its shorter retry", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const importedAt = new Date(Date.parse(now) - 1_000).toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-droid-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-droid-fork"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Droid fork",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("droid-fork-user"),
            role: "user",
            text: "Retained question",
            createdAt: importedAt,
            updatedAt: importedAt,
          },
          {
            messageId: asMessageId("droid-fork-assistant"),
            role: "assistant",
            text: "Retained answer",
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-fork-overlong-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-droid-fork"),
        message: {
          messageId: asMessageId("droid-fork-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness, ThreadId.makeUnsafe("thread-droid-fork")))?.session
          ?.status === "error",
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(
      (await readHarnessThread(harness, ThreadId.makeUnsafe("thread-droid-fork")))?.session
        ?.lastError,
    ).toContain("too long to include the transcript context");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-fork-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-droid-fork"),
        message: {
          messageId: asMessageId("droid-fork-latest-user"),
          role: "user",
          text: "Continue here",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.forkThread.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<thread_context>");
    expect(input?.input).toContain("Retained question");
    expect(input?.input).toContain("Retained answer");
    expect(input?.input).toContain("Continue here");
  });

  it("does not rebootstrap an empty Droid fork after its first native turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-empty-droid-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-empty-droid-fork"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Empty Droid fork",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-empty-droid-fork-first-turn"),
        threadId: ThreadId.makeUnsafe("thread-empty-droid-fork"),
        message: {
          messageId: asMessageId("empty-droid-fork-first-user"),
          role: "user",
          text: "First message without prior context",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const firstInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(firstInput?.input).not.toContain("<thread_context>");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-empty-droid-fork-second-turn"),
        threadId: ThreadId.makeUnsafe("thread-empty-droid-fork"),
        message: {
          messageId: asMessageId("empty-droid-fork-second-user"),
          role: "user",
          text: "Second message continues the native session",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const secondInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(secondInput?.input).not.toContain("<thread_context>");
    expect(secondInput?.input).not.toContain("First message without prior context");
    expect(secondInput?.input).toContain("Second message continues the native session");
  });

  it("retries a pending Droid fork bootstrap on an existing session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "droid",
          operation: "session/prompt",
          issue: "simulated Droid prompt preflight failure",
        }),
      ),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-retry-droid-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-retry-droid-fork"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Retry Droid fork",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("retry-droid-fork-imported-user"),
            role: "user",
            text: "Retained context for retry",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-retry-droid-fork-failed-turn"),
        threadId: ThreadId.makeUnsafe("thread-retry-droid-fork"),
        message: {
          messageId: asMessageId("retry-droid-fork-failed-user"),
          role: "user",
          text: "Failed attempt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(
      async () =>
        (await readHarnessThread(harness, ThreadId.makeUnsafe("thread-retry-droid-fork")))?.session
          ?.status === "error",
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-retry-droid-fork-success-turn"),
        threadId: ThreadId.makeUnsafe("thread-retry-droid-fork"),
        message: {
          messageId: asMessageId("retry-droid-fork-success-user"),
          role: "user",
          text: "Retry now",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(retryInput?.input).toContain("<thread_context>");
    expect(retryInput?.input).toContain("Retained context for retry");
    expect(retryInput?.input).toContain("Retry now");
  });

  it("retains a Droid transcript bootstrap when the forked prompt later fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-droid-async-bootstrap-failure");
    const firstTurnId = asTurnId("turn-droid-bootstrap-failed");
    const retryTurnId = asTurnId("turn-droid-bootstrap-retry");
    const followUpTurnId = asTurnId("turn-droid-bootstrap-follow-up");
    const harness = await createHarness({
      threadModelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
      },
    });
    const now = new Date().toISOString();
    const importedAt = new Date(Date.parse(now) - 1_000).toISOString();
    harness.sendTurn
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: firstTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: retryTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: followUpTurnId }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-fork"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Droid async bootstrap failure",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("droid-async-bootstrap-imported-user"),
            role: "user",
            text: "Context retained across the failed prompt",
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-first-turn"),
        threadId,
        message: {
          messageId: asMessageId("droid-async-bootstrap-first-user"),
          role: "user",
          text: "First attempt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const firstInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(firstInput?.input).toContain("<thread_context>");

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-droid-async-bootstrap-failed"),
      provider: "droid",
      threadId,
      createdAt: new Date().toISOString(),
      turnId: firstTurnId,
      payload: {
        state: "failed",
        errorMessage: "ACP prompt failed after dispatch",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-retry-turn"),
        threadId,
        message: {
          messageId: asMessageId("droid-async-bootstrap-retry-user"),
          role: "user",
          text: "Retry after async failure",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(retryInput?.input).toContain("<thread_context>");
    expect(retryInput?.input).toContain("Context retained across the failed prompt");
    expect(retryInput?.input).toContain("Retry after async failure");

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-droid-async-bootstrap-retry-completed"),
      provider: "droid",
      threadId,
      createdAt: new Date().toISOString(),
      turnId: retryTurnId,
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-follow-up-turn"),
        threadId,
        message: {
          messageId: asMessageId("droid-async-bootstrap-follow-up-user"),
          role: "user",
          text: "Continue after successful retry",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    const followUpInput = harness.sendTurn.mock.calls[2]?.[0] as { input?: string } | undefined;
    expect(followUpInput?.input).not.toContain("<thread_context>");
    expect(followUpInput?.input).toBe("Continue after successful retry");
  });

  it("rolls back provider conversation state for message edits", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-2"),
      turnId: asTurnId("turn-rollback-2"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-conversation-rollback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-2"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.rollbackConversation.mock.calls.length === 1);
    expect(harness.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("interrupts the active provider turn before rolling back an edited message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-active"),
      turnId: asTurnId("turn-rollback-active"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-edit-rollback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-active-edit"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-conversation-rollback-active"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-active"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.rollbackConversation.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-active-edit"),
    });
    expect(harness.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("stops an active provider runtime and immediately resends an edited latest message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageAttachment = {
      type: "image" as const,
      id: "edit-image-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const skill = {
      name: "docs",
      path: "/tmp/docs-skill",
    };
    const mention = {
      name: "README.md",
      path: "/tmp/project/README.md",
    };

    await harness.stageAttachment(imageAttachment);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-original-turn-start-for-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-edit"),
          role: "user",
          text: "old prompt",
          attachments: [imageAttachment],
          skills: [skill],
          mentions: [mention],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockClear();
    harness.startSession.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-edit-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-active-edit-resend"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-and-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-edit"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopRuntimeSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.stopRuntimeSession.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.interruptTurn.mock.calls.length).toBe(0);
    expect(harness.rollbackConversation.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "edited prompt",
      attachments: [imageAttachment],
      skills: [skill],
      mentions: [mention],
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.messages.map((message) => message.text)).toEqual(["edited prompt"]);
    expect(thread?.messages[0]).toMatchObject({
      attachments: [imageAttachment],
      skills: [skill],
      mentions: [mention],
    });
  });

  it("dispatches managed attachments from their repository object paths", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageAttachment = {
      type: "image" as const,
      id: "att_v2_aa000000000000000000000000000000",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const storagePath = await harness.stageAttachment(imageAttachment);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-managed-object-path-generic-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-managed-object-path"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-managed-object-path"),
          role: "user",
          text: "Inspect this image",
          attachments: [imageAttachment],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const sentAttachment = harness.sendTurn.mock.calls[0]?.[0].attachments?.[0];
    expect(sentAttachment).toMatchObject(imageAttachment);
    expect(
      sentAttachment &&
        resolveProviderAttachmentPath({
          attachmentsDir: path.join(harness.stateDir, "attachments"),
          attachment: sentAttachment,
        }),
    ).toBe(storagePath);

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const titleAttachment = harness.generateThreadTitle.mock.calls[0]?.[0].attachments?.[0];
    expect(
      titleAttachment &&
        resolveProviderAttachmentPath({
          attachmentsDir: path.join(harness.stateDir, "attachments"),
          attachment: titleAttachment,
        }),
    ).toBe(storagePath);
  });

  it("restarts Droid edits and bootstraps only the retained transcript", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "droid", model: "claude-opus-4-8" },
      conversationRollback: "restart-session",
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-droid-retained-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("droid-earlier-user"),
            role: "user",
            text: "Earlier question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("droid-earlier-assistant"),
            role: "assistant",
            text: "Earlier answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-original-edit-turn"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("droid-edit-target"),
          role: "user",
          text: "old prompt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-droid-active-edit-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "droid",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-droid-active-edit"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-droid-edit-and-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("droid-edit-target"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.clearSessionResumeCursor.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.clearSessionResumeCursor.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    const resent = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(resent?.input).toContain("<thread_context>");
    expect(resent?.input).toContain("Earlier question");
    expect(resent?.input).toContain("Earlier answer");
    expect(resent?.input).toContain("edited prompt");
    expect(resent?.input).not.toContain("old prompt");
  });

  it("keeps queued-message edits queued while an active provider turn continues", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running-edit-queued"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-edit-queued"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running-edit-queued"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-queued-before-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queued-before-edit"),
          role: "user",
          text: "queued prompt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();
    harness.stopRuntimeSession.mockClear();
    harness.rollbackConversation.mockClear();
    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-queued-message"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("msg-queued-before-edit"),
        text: "edited queued prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.rollbackConversation).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-edited-queue"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running-edit-queued"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "edited queued prompt",
    });
  });

  it("preserves image attachment files while rolling back an edit resend", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageAttachment = {
      type: "image" as const,
      id: "thread-1-12345678-1234-1234-1234-123456789abc",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const attachmentPath = path.join(
      harness.stateDir,
      "attachments",
      attachmentRelativePath(imageAttachment),
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from([1, 2, 3, 4]));
    await harness.stageAttachment(imageAttachment);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-original-image-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-image-edit"),
          role: "user",
          text: "old image prompt",
          attachments: [imageAttachment],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-image-edit-assistant-complete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-image-edit"),
        turnId: asTurnId("turn-image-edit"),
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-image-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("msg-image-edit"),
        text: "edited image prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(fs.existsSync(attachmentPath)).toBe(true);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: "edited image prompt",
      attachments: [imageAttachment],
    });
  });

  it("restores the previous filesystem checkpoint before resending a completed edit", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.isGitRepository.mockImplementationOnce(() => Effect.succeed(true));

    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-checkpoint-edit"),
      turnId: asTurnId("turn-checkpoint-edit"),
      createdAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-checkpoint-edit-complete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-checkpoint-edit"),
        completedAt: now,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        assistantMessageId: asMessageId("assistant-user-message-checkpoint-edit"),
        checkpointTurnCount: 1,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-checkpoint-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-checkpoint-edit"),
        text: "edited checkpoint prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.restoreCheckpoint).toHaveBeenCalledWith({
      cwd: "/tmp/provider-project",
      checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
      fallbackToHead: true,
    });
  });

  it("clears the edit loading state when provider rollback fails before resend", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/rollback",
          detail: "rollback failed",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-edit-rollback-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-edit-fails"),
            role: "user",
            text: "old prompt",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-assistant-edit-rollback-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-edit-rollback-failure"),
        turnId: asTurnId("turn-edit-rollback-failure"),
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-and-resend-rollback-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-edit-fails"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("rollback failed");
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((items) => Array.from(items)),
      ),
    );
    const editEvent = events.find(
      (event) =>
        event.commandId === "cmd-edit-and-resend-rollback-fails" &&
        event.type === "thread.message-edit-resend-requested",
    );
    expect(editEvent).toBeDefined();
    await waitFor(async () => {
      const delivery = await Effect.runPromise(
        harness.deliveryRepository.getDelivery({
          consumerName: "provider-command-reactor.v1",
          eventSequence: editEvent!.sequence,
        }),
      );
      return Option.isSome(delivery) && delivery.value.state === "uncertain";
    });
  });

  it("clears the edit loading state when edited turn start fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "turn start failed",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-edit-start-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-start-fails"),
            role: "user",
            text: "old prompt",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-assistant-edit-start-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-edit-start-failure"),
        turnId: asTurnId("turn-edit-start-failure"),
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-and-resend-start-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-start-fails"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("turn start failed");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(true);
  });

  it("clears stale provider resume state and completes message edit rollback", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-stale"),
      turnId: asTurnId("turn-rollback-stale"),
      createdAt: now,
    });
    harness.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/rollback",
          detail: "thread/resume failed: no rollout found for thread id 019db5ad",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-conversation-rollback-stale-resume"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-stale"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.clearSessionResumeCursor.mock.calls.length === 1);
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("routes subagent-thread turn starts to the parent session as steers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-subagent-thread-create"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:tool-steer-1"),
        projectId: asProjectId("project-1"),
        title: "Subagent",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-subagent-steer-1"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:tool-steer-1"),
        message: {
          messageId: asMessageId("subagent-steer-message-1"),
          role: "user",
          text: "focus on the tests",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerSubagent.mock.calls.length === 1);
    expect(harness.steerSubagent.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      providerThreadId: "tool-steer-1",
      input: "focus on the tests",
    });
    // The subagent thread must never boot a provider session of its own.
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("dispatches thread.task.background to the provider service", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-background"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-background"),
          role: "user",
          text: "spawn something",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.background",
        commandId: CommandId.makeUnsafe("cmd-task-background-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        toolUseId: "tool-task-bg-1",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => harness.backgroundTask.mock.calls.length === 1);
    expect(harness.backgroundTask.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toolUseId: "tool-task-bg-1",
    });
  });

  it("dispatches thread.task.stop to the provider service", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-task-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-task-stop"),
          role: "user",
          text: "spawn something",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-task-stop-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-stop-1",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => harness.stopTask.mock.calls.length === 1);
    expect(harness.stopTask.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      taskId: "task-stop-1",
    });
  });

  it("appends a failure activity when a task stop is requested without an active session", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-task-stop-no-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-stop-orphan",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.task.stop.failed") ??
        false
      );
    });
    expect(harness.stopTask).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.task.stop.failed",
    );
    expect(failureActivity?.payload).toMatchObject({
      detail: "No active provider session is bound to this thread.",
    });
  });

  it("surfaces terminal interrupt rejections as a thread activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.interruptTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.interruptTurn",
          issue:
            "Cannot interrupt thread 'thread-1' because no exact active provider turn is bound.",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-interrupt-rejection"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-interrupt-rejection"),
          role: "user",
          text: "work on something",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-interrupt-rejected"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed") ??
        false
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.interrupt.failed",
    );
    expect(failureActivity?.payload).toMatchObject({
      detail: expect.stringContaining("no exact active provider turn is bound"),
    });
  });

  it("surfaces provider task stop failures as a thread activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.stopTask.mockImplementationOnce(() => Effect.die(new Error("task stop exploded")));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-task-stop-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-task-stop-failure"),
          role: "user",
          text: "spawn something",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-task-stop-failing"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-stop-failing",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.task.stop.failed") ??
        false
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.task.stop.failed",
    );
    expect(failureActivity?.payload).toMatchObject({
      detail: expect.stringContaining("task stop exploded"),
    });
  });

  it("surfaces provider task background failures as a thread activity", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.backgroundTask.mockImplementationOnce(() =>
      Effect.die(new Error("task background exploded")),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-task-background-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-task-background-failure"),
          role: "user",
          text: "spawn something",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.background",
        commandId: CommandId.makeUnsafe("cmd-task-background-failing"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        toolUseId: "tool-task-bg-failing",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.task.background.failed",
        ) ?? false
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.task.background.failed",
    );
    expect(failureActivity?.payload).toMatchObject({
      detail: expect.stringContaining("task background exploded"),
    });
  });

  it("waits for the message-start checkpoint before sending the provider turn", async () => {
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() =>
      Effect.promise(() => captureGate),
    );
    const harness = await createHarness({
      checkpointStore: {
        isGitRepository: vi.fn<CheckpointStoreShape["isGitRepository"]>(() => Effect.succeed(true)),
        captureCheckpoint,
      },
    });
    const now = new Date().toISOString();

    const dispatch = Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-slow-checkpoint"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-checkpoint"),
          role: "user",
          text: "hello despite slow git",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => captureCheckpoint.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    releaseCapture?.();
    await dispatch;
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(captureCheckpoint.mock.calls.length).toBe(1);
    expect(captureCheckpoint.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
    });
    expect(captureCheckpoint.mock.calls[0]?.[0].checkpointRef).toContain("/message-start/");
  });

  it("waits for the Studio output baseline before sending the provider turn", async () => {
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureBaselineBeforeTurn = vi.fn<StudioOutputReactorShape["captureBaselineBeforeTurn"]>(
      () => Effect.promise(() => captureGate),
    );
    const harness = await createHarness({
      studioOutputReactor: { captureBaselineBeforeTurn },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-slow-studio-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-studio-baseline"),
          role: "user",
          text: "create an output immediately",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => captureBaselineBeforeTurn.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.sendTurn).not.toHaveBeenCalled();

    releaseCapture?.();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(captureBaselineBeforeTurn).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-1"));
  });

  it("publishes a starting session status before the provider session is ready", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    // Gate provider init so the early status is observable while it is pending.
    let releaseStartSession: (() => void) | undefined;
    const startSessionGate = new Promise<void>((resolve) => {
      releaseStartSession = resolve;
    });
    const defaultStartSession = harness.startSession.getMockImplementation();
    if (!defaultStartSession) {
      throw new Error("Harness startSession mock has no implementation.");
    }
    harness.startSession.mockImplementationOnce((threadId: unknown, input: unknown) =>
      Effect.promise(() => startSessionGate).pipe(
        Effect.flatMap(() => defaultStartSession(threadId, input)),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-early-status"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-early-status"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    // The slow-provider window: status is already "starting" while init blocks.
    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "starting");
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    releaseStartSession?.();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const status = (await readHarnessThread(harness))?.session?.status;
      return status !== undefined && status !== "starting";
    });
  });

  it("clears stale Claude resume state and retries the turn with transcript context", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    const staleResumeFailure = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/setModel",
          detail:
            "Claude Code returned an error result: No conversation found with session ID: b469168a-2625-4447-927f-d86d94bb7237",
        }),
      );
    // Both the original send and the native-resume retry fail stale, so the
    // reactor falls back to the transcript bootstrap.
    harness.sendTurn
      .mockImplementationOnce(staleResumeFailure)
      .mockImplementationOnce(staleResumeFailure);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-claude-stale-resume-history"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-claude-history"),
            role: "user",
            text: "Move the changelog navigation to the left.",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("assistant-message-claude-history"),
            role: "assistant",
            text: "I moved the changelog navigation into the left rail.",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-stale-resume"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-stale-resume"),
          role: "user",
          text: "nice but bring it on the left.",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    // Native-resume retry first: stop only the runtime so the persisted cursor survives.
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    const nativeRetrySendInput = harness.sendTurn.mock.calls[1]?.[0] as {
      readonly input?: string;
    };
    expect(nativeRetrySendInput.input).not.toContain("<thread_context>");
    // Second stale failure clears the cursor and bootstraps the transcript.
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.startSession.mock.calls.length).toBe(3);
    const retryStartInput = harness.startSession.mock.calls[2]?.[1];
    expect(retryStartInput).not.toHaveProperty("resumeCursor");

    const retrySendInput = harness.sendTurn.mock.calls[2]?.[0] as { readonly input?: string };
    expect(retrySendInput.input).toContain("<thread_context>");
    expect(retrySendInput.input).toContain("Move the changelog navigation to the left.");
    expect(retrySendInput.input).toContain("<latest_user_message>");
    expect(retrySendInput.input).toContain("nice but bring it on the left.");
  });

  it("retries a stale Claude resume natively before paying the transcript bootstrap", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/setModel",
          detail:
            "Claude Code returned an error result: No conversation found with session ID: b469168a-2625-4447-927f-d86d94bb7237",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-native-resume-retry"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-native-resume-retry"),
          role: "user",
          text: "keep going.",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    // The session restarts once with the persisted cursor intact...
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.startSession.mock.calls.length).toBe(2);
    // ...and the retry succeeds natively: no cursor clear, no bootstrap replay.
    expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
    const retrySendInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
    expect(retrySendInput.input).not.toContain("<thread_context>");
    expect(retrySendInput.input).toContain("keep going.");
  });

  it("skips the native resume retry when background tasks keep the runtime alive", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    harness.hasLiveRuntimeTasks.mockImplementation(() => Effect.succeed(true));
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/setModel",
          detail:
            "Claude Code returned an error result: No conversation found with session ID: b469168a-2625-4447-927f-d86d94bb7237",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-stale-live-tasks"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-stale-live-tasks"),
          role: "user",
          text: "keep going.",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    // Live background tasks own the runtime subprocess: the retry must not
    // stop it, and recovery goes straight to the transcript bootstrap.
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      preserveActiveRuntime: true,
    });
  });

  it("marks the thread session errored when normal turn start fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "turn start failed",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-start-fails"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("turn start failed");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(true);
    expect(harness.cancelPendingStudioOutputBaseline).toHaveBeenCalledWith(
      ThreadId.makeUnsafe("thread-1"),
    );
    await waitFor(async () => {
      const delivery = await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: "provider-command-reactor.v1",
          threadId: "thread-1",
        }),
      );
      return Option.isSome(delivery) && delivery.value.state === "uncertain";
    });
    const deliveryBlocker = await Effect.runPromise(
      harness.deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: "provider-command-reactor.v1",
        threadId: "thread-1",
      }),
    );
    expect(deliveryBlocker.pipe(Option.getOrThrow)).toMatchObject({
      state: "uncertain",
      attemptCount: 1,
    });
  });

  it("uses the runtime mode requested by thread.turn.start when starting the provider session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-full-access"),
          role: "user",
          text: "what permissions do you have",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      runtimeMode: "full-access",
    });
  });

  it("does not pass the Home chat container workspace root through as provider cwd", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-home-project-create"),
        projectId: asProjectId("project-home"),
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-home-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-home"),
        projectId: asProjectId("project-home"),
        title: "Home thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-home-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-home"),
        message: {
          messageId: asMessageId("user-message-home-1"),
          role: "user",
          text: "hello from home chat",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("cwd");
  });

  it("renames a generic first-turn thread title using text generation", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.succeed({
        title: "Polish loading states",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-generic"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-1"),
          role: "user",
          text: "Polish the loading states across the sidebar and composer",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(
      async () => (await readHarnessThread(harness))?.title === "Polish loading states",
    );
  });

  it("uses the configured text generation model for providers without native title generation", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash",
      },
    });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.succeed({
        title: "Provider startup failures",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-antigravity-generated"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Summarize provider startup failures without Codex",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-antigravity-generated-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-antigravity-generated-title-1"),
          role: "user",
          text: "Summarize provider startup failures without Codex",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          model: "Gemini 3.5 Flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Summarize provider startup failures without Codex",
      modelSelection: {
        provider: "codex",
      },
    });
    await waitFor(
      async () => (await readHarnessThread(harness))?.title === "Provider startup failures",
    );
  });

  it("uses a local fallback title when configured text generation fails", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-antigravity"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-antigravity-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-antigravity-title-1"),
          role: "user",
          text: "Summarize provider startup failures without Codex",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          model: "Gemini 3.5 Flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.title ===
        "Summarize provider startup failures without Codex",
    );
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
  });

  it("renames temporary worktree branches and keeps associated worktree metadata in sync", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({
        branch: "app-startup-crash",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-worktree-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-rename"),
          role: "user",
          text: "The app crashes during startup, fix it",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    await waitFor(() => harness.publishBranch.mock.calls.length === 1);

    await waitFor(async () => {
      const thread = await readHarnessThread(harness);
      return (
        thread?.branch === "synara/app-startup-crash" &&
        thread.associatedWorktreeBranch === "synara/app-startup-crash" &&
        thread.associatedWorktreeRef === "synara/app-startup-crash"
      );
    });

    const thread = await readHarnessThread(harness);
    expect(thread).toMatchObject({
      branch: "synara/app-startup-crash",
      worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreeBranch: "synara/app-startup-crash",
      associatedWorktreeRef: "synara/app-startup-crash",
    });
  });

  it("falls back to prompt-based worktree branch names when the provider cannot generate one", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-bootstrap-antigravity"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-worktree-fallback-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-fallback-rename"),
          role: "user",
          text: "Fix provider startup timeouts",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          model: "Gemini 3.5 Flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.renameBranch.mock.calls[0]?.[0]).toMatchObject({
      oldBranch: "synara/cb661f0d",
      newBranch: "synara/fix-provider-startup-timeouts",
    });

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.branch === "synara/fix-provider-startup-timeouts",
    );
  });

  it("renames generic OpenCode first-turn thread titles using text generation", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "opencode",
        model: "openai/gpt-5",
        options: {
          agent: "plan",
          variant: "balanced",
        },
      },
    });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.succeed({
        title: "Plan release work",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-opencode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-opencode-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-opencode-title-1"),
          role: "user",
          text: "Plan the release workflow and deployment checklist",
          attachments: [],
        },
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            agent: "plan",
            variant: "balanced",
          },
        },
        providerOptions: {
          opencode: {
            binaryPath: "/custom/bin/opencode",
            serverUrl: "http://127.0.0.1:4096",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Plan the release workflow and deployment checklist",
      modelSelection: {
        provider: "opencode",
        model: "openai/gpt-5",
        options: {
          agent: "plan",
          variant: "balanced",
        },
      },
      providerOptions: {
        opencode: {
          binaryPath: "/custom/bin/opencode",
          serverUrl: "http://127.0.0.1:4096",
        },
      },
    });
    await waitFor(async () => (await readHarnessThread(harness))?.title === "Plan release work");
  });

  it("queues a follow-up turn while the current turn is still running", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-queue"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-queue-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queue-1"),
          role: "user",
          text: "queue this next",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-queue"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "queue this next",
    });
  });

  it("keeps the next queued turn blocked until the promoted turn settles", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const firstSendGate: {
      release: ((value: { readonly threadId: ThreadId; readonly turnId: TurnId }) => void) | null;
    } = { release: null };

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running-before-promotion"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-double-queue"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running-before-promotion"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockImplementationOnce(() =>
      Effect.tryPromise(
        () =>
          new Promise<{ readonly threadId: ThreadId; readonly turnId: TurnId }>((resolve) => {
            firstSendGate.release = resolve;
          }),
      ),
    );

    for (const [messageId, text] of [
      ["msg-queue-promoted-1", "first queued turn"],
      ["msg-queue-promoted-2", "second queued turn"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-turn-${messageId}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
    }

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-promote-first"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running-before-promotion"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "first queued turn",
    });

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-promoted-1"),
    });
    expect(firstSendGate.release).not.toBeNull();
    firstSendGate.release?.({
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-promoted-1"),
    });
    await harness.drain();

    // A duplicate/late terminal event for the previous turn can arrive after
    // the promoted turn has fully started. It must not release that promoted
    // turn's session reservation or drain the next queued message.
    await harness.emitRuntimeEvent({
      type: "turn.aborted",
      eventId: asEventId("evt-late-turn-aborted-after-promotion-started"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running-before-promotion"),
      payload: {
        reason: "interrupted",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-promoted-first"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-promoted-1"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "second queued turn",
    });
  });

  it("releases a promoted-turn reservation on an id-less terminal event once the session is idle", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running-before-idless-abort"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-before-idless-abort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running-before-idless-abort"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    for (const [messageId, text] of [
      ["msg-before-idless-abort", "promote before id-less abort"],
      ["msg-after-idless-abort", "release after id-less abort"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${messageId}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
    }

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-complete-before-idless-abort"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-running-before-idless-abort"),
      payload: { state: "completed" },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.aborted",
      eventId: asEventId("evt-idless-abort-promoted-turn"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: now,
      payload: { reason: "interrupted" },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "release after id-less abort",
    });
  });

  it("queues a child-thread turn while the shared parent session runs and drains it on settle", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-child-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-child"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "Child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    // The child shares the parent's provider session, which is mid-turn.
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-parent-running"),
    });
    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-child-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-child"),
        message: {
          messageId: asMessageId("msg-child-queued"),
          role: "user",
          text: "child follow-up",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    // A raw child-id session lookup would miss the parent's live turn and
    // dispatch immediately, overlapping the shared provider session.
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-parent-turn-completed"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-parent-running"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-child"),
      input: "child follow-up",
    });
  });

  it("discards queued child turns when the shared parent session stops", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-child-thread-create-before-parent-stop"),
        threadId: ThreadId.makeUnsafe("thread-child-before-parent-stop"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "Queued child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-parent-before-stop"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-parent-session-running-before-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent-before-stop"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-child-turn-queued-before-parent-stop"),
        threadId: ThreadId.makeUnsafe("thread-child-before-parent-stop"),
        message: {
          messageId: asMessageId("msg-child-queued-before-parent-stop"),
          role: "user",
          text: "must be discarded with the stopped session",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-parent-session-stop-with-child-queued"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );
    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-parent-terminal-after-explicit-stop"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-parent-before-stop"),
      payload: { state: "completed" },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("drains sibling child queues after a promoted child turn fails to start", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    for (const childId of ["thread-child-a", "thread-child-b"] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-${childId}-create`),
          threadId: ThreadId.makeUnsafe(childId),
          projectId: asProjectId("project-1"),
          parentThreadId: ThreadId.makeUnsafe("thread-1"),
          title: childId,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-parent-running-siblings"),
    });
    harness.sendTurn.mockClear();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "child start failed",
        }),
      ),
    );

    for (const [threadId, messageId, text] of [
      ["thread-child-a", "msg-child-a", "first child follow-up"],
      ["thread-child-b", "msg-child-b", "second child follow-up"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${messageId}`),
          threadId: ThreadId.makeUnsafe(threadId),
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
    }

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-parent-turn-completed-sibling-drain"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-parent-running-siblings"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-child-b"),
      input: "second child follow-up",
    });
  });

  it("drains a shared child queue after a direct parent turn fails to start", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-direct-failure-child-create"),
        threadId: ThreadId.makeUnsafe("thread-direct-failure-child"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "Queued child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-before-direct-failure"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-direct-failure-session-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-before-direct-failure"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-queue-child-before-direct-failure"),
        threadId: ThreadId.makeUnsafe("thread-direct-failure-child"),
        message: {
          messageId: asMessageId("msg-child-before-direct-failure"),
          role: "user",
          text: "recover this queued child",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    // Make the provider idle without a terminal event. The child follow-up is
    // still queued when the next parent start takes the direct path.
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-direct-failure-session-ready"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "direct parent start failed",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-direct-parent-start-fails-with-child-queued"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-direct-parent-start-fails"),
          role: "user",
          text: "this direct parent turn fails",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "this direct parent turn fails",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-direct-failure-child"),
      input: "recover this queued child",
    });
  });

  it("promotes a queued turn immediately when the provider turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Projection still says the thread is running (stale), but the provider
    // turn has already settled: its terminal event was consumed before this
    // message was queued, so no future drain trigger will ever arrive.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-stale-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-already-settled"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-queue-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queue-stale"),
          role: "user",
          text: "recover me",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    // No turn.completed/turn.aborted is emitted: the recovery drain alone
    // must promote the queued message.
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "recover me",
    });
  });

  it("re-queues a direct turn start that races a live provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // The provider is mid-turn but the projection has no running session yet
    // (e.g. the gap between a steer interrupt and the steered turn's start):
    // the decider dispatches directly instead of queueing.
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-live-race"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-race"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-turn-race"),
          role: "user",
          text: "wait your turn",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-race"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-live-race"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "wait your turn",
    });
  });

  it("steers immediately for codex sessions when Cmd/Ctrl+Enter is used", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-steer-codex"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-steer-codex"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-codex"),
          role: "user",
          text: "pivot now",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "pivot now",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
  });

  it("dispatches a codex steer as a queued turn when the live provider turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Projection lags: it still says running, but the provider runtime has no
    // live turn. The steer must not ride the native codex steer path (which
    // would skip the turn-start checkpoint) — it dispatches as a normal turn.
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-stale-steer-codex"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-settled"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-steer-codex-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-codex-stale"),
          role: "user",
          text: "steer but nothing is running",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "steer but nothing is running",
    });
  });

  it("falls back to interrupt plus priority queue for claude steering", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-steer-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-steer-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-claude"),
          role: "user",
          text: "switch directions",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn.mock.calls.length).toBe(1);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-steer-claude"),
      provider: "claudeAgent",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running"),
      payload: {
        state: "interrupted",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "switch directions",
    });
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fast"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("forwards codex effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-effort"),
          role: "user",
          text: "hello with codex effort",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
          options: {
            reasoningEffort: "high",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
        options: {
          reasoningEffort: "high",
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
        options: {
          reasoningEffort: "high",
        },
      },
    });
  });

  it("restarts an idle Claude session only for spawn-fixed model selection changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-bootstrap"),
          role: "user",
          text: "bootstrap claude session",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
      },
    });
    harness.startSession.mockClear();

    // Context-window changes switch in-session via setModel on the next turn.
    // Restarting would resume via --resume and replay the whole conversation
    // as uncached input tokens.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-claude-1m"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: {
            contextWindow: "1m",
          },
        },
      }),
    );

    // Effort is fixed at subprocess spawn, so an effort change still restarts.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-claude-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: {
            effort: "max",
          },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("restarts a directly started Claude session when spawn-fixed options change", async () => {
    const initialSelection: ModelSelection = {
      provider: "claudeAgent",
      model: "claude-opus-4-7",
    };
    const harness = await createHarness({ threadModelSelection: initialSelection });
    const threadId = ThreadId.makeUnsafe("thread-1");

    // Mirrors native import: ProviderService owns the runtime start directly,
    // while the reactor learns the original selection from thread.created.
    await harness.drain();
    const importedSession = await Effect.runPromise(
      harness.startSession(threadId, {
        threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        modelSelection: initialSelection,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-direct-claude-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: importedSession.updatedAt,
        },
        createdAt: importedSession.updatedAt,
      }),
    );
    harness.startSession.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-direct-claude-effort-update"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { effort: "max" },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { effort: "max" },
      },
    });
  });

  it("keeps the applied Claude spawn profile while metadata changes mid-turn", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-active-selection-change");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-active-selection-bootstrap"),
        threadId,
        message: {
          messageId: asMessageId("user-message-active-selection-bootstrap"),
          role: "user",
          text: "bootstrap",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    harness.startSession.mockClear();

    harness.setRuntimeSessionTurnState({ threadId, status: "running", activeTurnId: turnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-active-selection-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-active-selection-effort"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { effort: "max" },
        },
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-active-selection-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    // The context-only edit is compared with the profile that is actually live,
    // so the pending effort change still forces exactly one replacement.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-active-selection-context"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { effort: "max", contextWindow: "1m" },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { effort: "max", contextWindow: "1m" },
      },
    });
  });

  it("seeds imported Droid selection before handling idle metadata updates", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
        options: { reasoningEffort: "medium" },
      },
    });
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-imported-droid"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "droid",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-droid-same-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
          options: { reasoningEffort: "medium" },
        },
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-droid-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
          options: { reasoningEffort: "high" },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-synthetic" },
      modelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
        options: { reasoningEffort: "high" },
      },
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      interactionMode: "plan",
    });
  });

  it("adopts the requested provider on a first turn before binding a session", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-first"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.modelSelection).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
    });
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "medium",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("restarts the provider session when runtime mode changes on the thread or turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(
      async () => (await readHarnessThread(harness))?.runtimeMode === "approval-required",
    );
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 3);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.startSession.mock.calls[2]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "full-access",
    });
    expect(harness.startSession.mock.calls[2]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = await readHarnessThread(harness);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(
      async () => (await readHarnessThread(harness))?.runtimeMode === "approval-required",
    );
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((items) => Array.from(items)),
      ),
    );
    const runtimeModeEvent = events.find(
      (event) => event.commandId === "cmd-runtime-mode-set-restart-failure",
    );
    expect(runtimeModeEvent).toBeDefined();
    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: runtimeModeEvent!.sequence,
      }),
    );
    expect(delivery.pipe(Option.getOrThrow).state).toBe("uncertain");
  });

  it("restarts without a resume cursor when the runtime mode changes", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-bootstrap"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-no-resume"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("routes subagent interrupts through the parent provider session using the child provider thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Halley [explorer]",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child",
      providerThreadId: "child-provider-1",
    });
  });

  it("routes subagent interrupts even when the child thread has no session of its own", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-sessionless"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-sessionless"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-2"),
        projectId: asProjectId("project-1"),
        title: "Halley [explorer]",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent-sessionless"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-2"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      providerThreadId: "child-provider-2",
    });
  });

  it("infers the parent provider session for synthetic subagent ids that are missing parent metadata", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-fallback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-fallback"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Agent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
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
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent-fallback"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent-fallback"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child",
      providerThreadId: "child-provider-1",
    });
  });

  it("steers attachment-only turns through an inferred synthetic subagent parent", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const attachment = {
      type: "file" as const,
      id: "synthetic-subagent-attachment",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-synthetic-steer-parent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-synthetic-steer-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-synthetic-steer-child"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-steer"),
        projectId: asProjectId("project-1"),
        title: "Synthetic child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    await harness.stageAttachment(attachment, "subagent:thread-1:child-provider-steer");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-synthetic-attachment-steer"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-steer"),
        message: {
          messageId: asMessageId("msg-synthetic-attachment-steer"),
          role: "user",
          text: "",
          attachments: [attachment],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerSubagent.mock.calls.length === 1);
    expect(harness.steerSubagent.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      providerThreadId: "child-provider-steer",
      attachments: [attachment],
    });
    expect(harness.startSession).not.toHaveBeenCalledWith(
      ThreadId.makeUnsafe("subagent:thread-1:child-provider-steer"),
      expect.anything(),
    );
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-request-before-response"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-request-before-response"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
            lifecycleGeneration: "approval-generation-1",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        lifecycleGeneration: "approval-generation-1",
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      lifecycleGeneration: "approval-generation-1",
      decision: "accept",
    });
    const respondingApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-1"),
      }),
    );
    expect(Option.getOrUndefined(respondingApproval)).toMatchObject({
      status: "responding",
      responseCommandId: "cmd-approval-respond",
      decision: "accept",
      resolvedAt: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-duplicate"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        lifecycleGeneration: "approval-generation-1",
        decision: "decline",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-request-before-response"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-request-before-response"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            lifecycleGeneration: "user-input-generation-1",
            questions: [],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        lifecycleGeneration: "user-input-generation-1",
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      lifecycleGeneration: "user-input-generation-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
    const respondingUserInput = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-1"),
      }),
    );
    expect(Option.getOrUndefined(respondingUserInput)).toMatchObject({
      status: "responding",
      responseCommandId: "cmd-user-input-respond",
      decision: null,
      resolvedAt: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-duplicate"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        lifecycleGeneration: "user-input-generation-1",
        answers: { sandbox_mode: "danger-full-access" },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
  });

  it("does not forward approval responses without a durable pending claim", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-early"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-early"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.respondToRequest).not.toHaveBeenCalled();
  });

  it("does not forward user-input responses without a durable pending claim", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-early"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-early"),
        answers: {
          input: "continue",
        },
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
  });

  it("does not forward approval responses when the projected session is stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested-stopped"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: "approval-request-stopped", requestKind: "command" },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-stopped"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) ?? false
      );
    });
    expect(harness.respondToRequest).not.toHaveBeenCalled();
    const retryableApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-stopped"),
      }),
    );
    expect(Option.getOrUndefined(retryableApproval)).toMatchObject({
      status: "retryable",
      responseCommandId: "cmd-approval-respond-stopped",
      decision: "accept",
      resolvedAt: null,
    });
  });

  it("does not forward user-input responses when the projected session is stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested-stopped"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "user-input-request-stopped", questions: [] },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-stopped"),
        answers: {
          input: "continue",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ) ?? false
      );
    });
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
    const retryableUserInput = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-stopped"),
      }),
    );
    expect(Option.getOrUndefined(retryableUserInput)).toMatchObject({
      status: "retryable",
      responseCommandId: "cmd-user-input-respond-stopped",
      decision: null,
      resolvedAt: null,
    });
  });

  it("preserves array and mixed answer shapes through the runtime path", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-multi"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested-multi"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested-multi"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "user-input-request-multi", questions: [] },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-multi"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-multi"),
        answers: {
          single: "TypeScript",
          features: ["CLI scaffolding", "Type checking"],
          rating: "Solid",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-multi",
      answers: {
        single: "TypeScript",
        features: ["CLI scaffolding", "Type checking"],
        rating: "Solid",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) === true,
    );

    const thread = await readHarnessThread(harness);
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      responseCommandId: "cmd-approval-respond-stale",
      settlementStatus: "uncertain",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });
    const uncertainApproval = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "approval",
        requestId: asApprovalRequestId("approval-request-1"),
      }),
    );
    expect(Option.getOrUndefined(uncertainApproval)).toMatchObject({
      status: "uncertain",
      responseCommandId: "cmd-approval-respond-stale",
      decision: "acceptForSession",
      resolvedAt: null,
    });
    const responseEvents = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((events) => Array.from(events)),
      ),
    );
    const responseEvent = responseEvents.find(
      (event) => event.commandId === "cmd-approval-respond-stale",
    );
    expect(responseEvent).toBeDefined();
    const responseDelivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: responseEvent!.sequence,
      }),
    );
    expect(responseDelivery.pipe(Option.getOrThrow).state).toBe("succeeded");

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces stale provider user-input failures without faking user-input resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending user-input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
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
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ) === true,
    );

    const thread = await readHarnessThread(harness);
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      responseCommandId: "cmd-user-input-respond-stale",
      settlementStatus: "uncertain",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });
    const uncertainUserInput = await Effect.runPromise(
      harness.pendingInteractionRepository.getByIdentity({
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionKind: "userInput",
        requestId: asApprovalRequestId("user-input-request-1"),
      }),
    );
    expect(Option.getOrUndefined(uncertainUserInput)).toMatchObject({
      status: "uncertain",
      responseCommandId: "cmd-user-input-respond-stale",
      decision: null,
      resolvedAt: null,
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      if (harness.stopSession.mock.calls.length !== 1) return false;
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.session?.status === "stopped";
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("serializes archive cleanup through the durable provider intent source", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-archive"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("cmd-archive-active-provider-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    await waitFor(async () => {
      if (harness.stopSession.mock.calls.length !== 1) return false;
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.archivedAt !== null && thread?.session?.status === "stopped";
    });

    expect(harness.stopSession).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it("does not restore pending sidechat context after an explicit session stop", async () => {
    const threadId = ThreadId.makeUnsafe("thread-stopped-droid-sidechat");
    const harness = await createHarness({
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "stopped-droid-sidechat" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Stopped Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("stopped-droid-sidechat-imported-user"),
            role: "user",
            text: "Context cleared by stop",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-overlong"),
        threadId,
        message: {
          messageId: asMessageId("stopped-droid-sidechat-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 100),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "error"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-stop"),
        threadId,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        harness.stopSession.mock.calls.length === 1 &&
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "stopped"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-fresh-turn"),
        threadId,
        message: {
          messageId: asMessageId("stopped-droid-sidechat-fresh-user"),
          role: "user",
          text: "Start fresh after stop",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).not.toContain("<sidechat_context>");
    expect(input?.input).not.toContain("<thread_context>");
    expect(input?.input).not.toContain("Context cleared by stop");
    expect(input?.input).toContain("Start fresh after stop");
  });

  it("interrupts active subagent sessions without stopping the parent provider session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-for-child-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-for-stop"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Agent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent-for-stop"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child-stop"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child-stop",
      providerThreadId: "child-provider-1",
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === "subagent:thread-1:child-provider-1",
      );
      return (
        thread?.session?.status === "interrupted" &&
        thread.session.activeTurnId === "turn-child-stop"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find(
      (entry) => entry.id === "subagent:thread-1:child-provider-1",
    );
    expect(thread?.session?.status).toBe("interrupted");
    expect(thread?.session?.activeTurnId).toBe("turn-child-stop");
  });
});
