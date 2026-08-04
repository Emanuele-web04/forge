import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import { runManagedAttachmentCleanupBatch } from "../../managedAttachmentCleanup.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const makeObservedEventStoreLayer = (readCursors: Array<number>) =>
  Layer.effect(
    OrchestrationEventStore,
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      return {
        ...eventStore,
        readFromSequence(sequenceExclusive, limit, throughSequenceInclusive) {
          readCursors.push(sequenceExclusive);
          return eventStore.readFromSequence(sequenceExclusive, limit, throughSequenceInclusive);
        },
      } satisfies OrchestrationEventStoreShape;
    }),
  ).pipe(Layer.provide(OrchestrationEventStoreLive));

const makeAppendAndProject =
  (
    eventStore: OrchestrationEventStoreShape,
    projectionPipeline: OrchestrationProjectionPipelineShape,
  ) =>
  (event: Parameters<OrchestrationEventStoreShape["append"]>[0]) =>
    eventStore
      .append(event)
      .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("synara-projection-pipeline-test-");

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );

  it.effect("persists turn-start thread settings into projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-02-26T13:00:00.000Z";
      const turnRequestedAt = "2026-02-26T13:00:05.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-turn-settings-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-turn-settings"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-turn-settings-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-turn-settings-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-turn-settings"),
          title: "Project",
          workspaceRoot: "/tmp/project-turn-settings",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-turn-settings-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-turn-settings"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-turn-settings-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-turn-settings-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-turn-settings"),
          projectId: ProjectId.makeUnsafe("project-turn-settings"),
          title: "Thread",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5.1",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-turn-settings-start"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-turn-settings"),
        occurredAt: turnRequestedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-settings-start"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-turn-settings-start"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-turn-settings"),
          messageId: MessageId.makeUnsafe("message-turn-settings"),
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5.5",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: turnRequestedAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly modelSelectionJson: string;
        readonly runtimeMode: string;
        readonly interactionMode: string;
        readonly updatedAt: string;
      }>`
        SELECT
          model_selection_json AS "modelSelectionJson",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-turn-settings'
      `;

      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]!.modelSelectionJson), {
        provider: "pi",
        model: "openai/gpt-5.5",
      });
      assert.equal(rows[0]!.runtimeMode, "approval-required");
      assert.equal(rows[0]!.interactionMode, "default");
      assert.equal(rows[0]!.updatedAt, turnRequestedAt);

      const sessionRows = yield* sql<{
        readonly status: string;
        readonly providerName: string | null;
        readonly runtimeMode: string;
        readonly activeTurnId: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          status,
          provider_name AS "providerName",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-turn-settings'
      `;
      assert.deepEqual(sessionRows, [
        {
          status: "starting",
          providerName: "pi",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: turnRequestedAt,
        },
      ]);

      const turnCompletedAt = "2026-02-26T13:00:10.000Z";
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-turn-settings-ready"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-turn-settings"),
        occurredAt: turnCompletedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-settings-ready"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-turn-settings-ready"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-turn-settings"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-turn-settings"),
            status: "ready",
            providerName: "pi",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: turnCompletedAt,
          },
        },
      });

      yield* sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = 'thread-turn-settings'
      `;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions},
          ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        )
      `;
      yield* projectionPipeline.bootstrap;

      const rebuiltSessionRows = yield* sql<{
        readonly status: string;
        readonly updatedAt: string;
      }>`
        SELECT status, updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-turn-settings'
      `;
      assert.deepEqual(rebuiltSessionRows, [
        {
          status: "ready",
          updatedAt: turnCompletedAt,
        },
      ]);

      const crossProviderRequestedAt = "2026-02-26T13:00:15.000Z";
      const crossProviderEvent = yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-turn-settings-cross-provider"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-turn-settings"),
        occurredAt: crossProviderRequestedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-settings-cross-provider"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-turn-settings-cross-provider"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-turn-settings"),
          messageId: MessageId.makeUnsafe("message-turn-settings-cross-provider"),
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: crossProviderRequestedAt,
        },
      });
      yield* projectionPipeline.projectEvent(crossProviderEvent);

      const providerRows = yield* sql<{
        readonly modelSelectionJson: string;
        readonly providerName: string | null;
      }>`
        SELECT
          threads.model_selection_json AS "modelSelectionJson",
          sessions.provider_name AS "providerName"
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.thread_id = 'thread-turn-settings'
      `;
      assert.deepEqual(JSON.parse(providerRows[0]!.modelSelectionJson), {
        provider: "pi",
        model: "openai/gpt-5.5",
      });
      assert.equal(providerRows[0]!.providerName, "pi");

      // Automation-dispatched turns run with the automation's modes but must not
      // repaint the thread's persisted runtime/interaction modes.
      const automationRequestedAt = "2026-02-26T13:00:20.000Z";
      const automationEvent = yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-turn-settings-automation"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-turn-settings"),
        occurredAt: automationRequestedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-settings-automation"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-turn-settings-automation"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-turn-settings"),
          messageId: MessageId.makeUnsafe("message-turn-settings-automation"),
          dispatchOrigin: "automation",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          createdAt: automationRequestedAt,
        },
      });
      yield* projectionPipeline.projectEvent(automationEvent);

      const automationRows = yield* sql<{
        readonly runtimeMode: string;
        readonly interactionMode: string;
      }>`
        SELECT
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode"
        FROM projection_threads
        WHERE thread_id = 'thread-turn-settings'
      `;
      assert.equal(automationRows[0]!.runtimeMode, "full-access");
      assert.equal(automationRows[0]!.interactionMode, "default");
    }),
  );

  it.effect("keeps a retained runtime-error turn terminal across projection rebuilds", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
      const threadId = ThreadId.makeUnsafe("thread-retained-error-turn");
      const turnId = TurnId.makeUnsafe("turn-retained-error-turn");
      const createdAt = "2026-07-21T00:00:00.000Z";
      const requestedAt = "2026-07-21T00:00:01.000Z";
      const startedAt = "2026-07-21T00:00:02.000Z";
      const failedAt = "2026-07-21T00:00:03.000Z";

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-retained-error-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-retained-error"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-retained-error"),
          title: "Retained error project",
          workspaceRoot: "/tmp/project-retained-error",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-retained-error-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-retained-error"),
          title: "Retained error thread",
          modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* appendAndProject({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-retained-error-start"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: requestedAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-start"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-start"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-retained-error"),
          modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: "queue",
          createdAt: requestedAt,
        },
      });
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-retained-error-running"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: startedAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-running"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-running"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: startedAt,
          },
        },
      });
      yield* appendAndProject({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-retained-error-terminal"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: failedAt,
        commandId: CommandId.makeUnsafe("cmd-retained-error-terminal"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-retained-error-terminal"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: "provider failed",
            updatedAt: failedAt,
          },
        },
      });

      const readTerminalRows = () =>
        Effect.all({
          sessions: sql<{
            readonly status: string;
            readonly activeTurnId: string | null;
          }>`
            SELECT status, active_turn_id AS "activeTurnId"
            FROM projection_thread_sessions
            WHERE thread_id = ${threadId}
          `,
          turns: sql<{
            readonly state: string;
            readonly completedAt: string | null;
          }>`
            SELECT state, completed_at AS "completedAt"
            FROM projection_turns
            WHERE thread_id = ${threadId} AND turn_id = ${turnId}
          `,
        });

      const liveRows = yield* readTerminalRows();
      assert.deepEqual(liveRows, {
        sessions: [{ status: "error", activeTurnId: turnId }],
        turns: [{ state: "error", completedAt: failedAt }],
      });

      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions},
          ${ORCHESTRATION_PROJECTOR_NAMES.threadTurns}
        )
      `;
      yield* projectionPipeline.bootstrap;

      assert.deepEqual(yield* readTerminalRows(), liveRows);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-message-identity-scope-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("keeps reused provider message ids thread-scoped through replay", () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const messageId = MessageId.makeUnsafe("shared-provider-message-id");
        const firstThreadId = ThreadId.makeUnsafe("thread-shared-provider-message-a");
        const secondThreadId = ThreadId.makeUnsafe("thread-shared-provider-message-b");

        const appendMessage = (input: {
          readonly eventId: string;
          readonly commandId: string;
          readonly threadId: ThreadId;
          readonly text: string;
          readonly streaming: boolean;
          readonly attachmentId?: string;
          readonly occurredAt: string;
        }) =>
          eventStore.append({
            type: "thread.message-sent",
            eventId: EventId.makeUnsafe(input.eventId),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            occurredAt: input.occurredAt,
            commandId: CommandId.makeUnsafe(input.commandId),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(input.commandId),
            metadata: {},
            payload: {
              threadId: input.threadId,
              messageId,
              role: "assistant" as const,
              text: input.text,
              ...(input.attachmentId
                ? {
                    attachments: [
                      {
                        type: "file" as const,
                        id: input.attachmentId,
                        name: `${input.attachmentId}.txt`,
                        mimeType: "text/plain",
                        sizeBytes: 1,
                      },
                    ],
                  }
                : {}),
              turnId: null,
              streaming: input.streaming,
              createdAt: input.occurredAt,
              updatedAt: input.occurredAt,
            },
          });

        yield* appendMessage({
          eventId: "evt-shared-provider-message-a-1",
          commandId: "cmd-shared-provider-message-a-1",
          threadId: firstThreadId,
          text: "first",
          streaming: false,
          attachmentId: "attachment-shared-provider-a",
          occurredAt: "2026-07-14T11:00:00.000Z",
        });
        yield* appendMessage({
          eventId: "evt-shared-provider-message-b-1",
          commandId: "cmd-shared-provider-message-b-1",
          threadId: secondThreadId,
          text: "second",
          streaming: false,
          attachmentId: "attachment-shared-provider-b",
          occurredAt: "2026-07-14T11:00:01.000Z",
        });
        yield* appendMessage({
          eventId: "evt-shared-provider-message-a-2",
          commandId: "cmd-shared-provider-message-a-2",
          threadId: firstThreadId,
          text: " thread",
          streaming: true,
          occurredAt: "2026-07-14T11:00:02.000Z",
        });

        const readRows = () =>
          sql<{ readonly threadId: string; readonly text: string; readonly attachments: string }>`
          SELECT
            thread_id AS "threadId",
            text,
            attachments_json AS attachments
          FROM projection_thread_messages
          WHERE message_id = ${messageId}
          ORDER BY thread_id ASC
        `;
        const expectedRows = [
          {
            threadId: firstThreadId,
            text: "first thread",
            attachments: JSON.stringify([
              {
                type: "file",
                id: "attachment-shared-provider-a",
                name: "attachment-shared-provider-a.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ]),
          },
          {
            threadId: secondThreadId,
            text: "second",
            attachments: JSON.stringify([
              {
                type: "file",
                id: "attachment-shared-provider-b",
                name: "attachment-shared-provider-b.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ]),
          },
        ];

        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRows(), expectedRows);

        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRows(), expectedRows);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-approval-identity-scope-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("keeps reused provider request ids thread-scoped through replay", () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const requestId = ApprovalRequestId.makeUnsafe("shared-provider-request-id");
        const firstThreadId = ThreadId.makeUnsafe("thread-shared-provider-request-a");
        const secondThreadId = ThreadId.makeUnsafe("thread-shared-provider-request-b");

        const appendRequest = (input: {
          readonly eventId: string;
          readonly commandId: string;
          readonly activityId: string;
          readonly threadId: ThreadId;
          readonly occurredAt: string;
        }) =>
          eventStore.append({
            type: "thread.activity-appended",
            eventId: EventId.makeUnsafe(input.eventId),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            occurredAt: input.occurredAt,
            commandId: CommandId.makeUnsafe(input.commandId),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(input.commandId),
            metadata: {},
            payload: {
              threadId: input.threadId,
              activity: {
                id: EventId.makeUnsafe(input.activityId),
                tone: "approval" as const,
                kind: "approval.requested" as const,
                summary: "Approval requested",
                payload: { requestId, requestKind: "command" },
                turnId: null,
                createdAt: input.occurredAt,
              },
            },
          });

        yield* appendRequest({
          eventId: "evt-shared-provider-request-a",
          commandId: "cmd-shared-provider-request-a",
          activityId: "activity-shared-provider-request-a",
          threadId: firstThreadId,
          occurredAt: "2026-07-14T12:30:00.000Z",
        });
        yield* appendRequest({
          eventId: "evt-shared-provider-request-b",
          commandId: "cmd-shared-provider-request-b",
          activityId: "activity-shared-provider-request-b",
          threadId: secondThreadId,
          occurredAt: "2026-07-14T12:30:01.000Z",
        });
        yield* eventStore.append({
          type: "thread.approval-response-requested",
          eventId: EventId.makeUnsafe("evt-shared-provider-request-a-response"),
          aggregateKind: "thread",
          aggregateId: firstThreadId,
          occurredAt: "2026-07-14T12:30:02.000Z",
          commandId: CommandId.makeUnsafe("cmd-shared-provider-request-a-response"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-shared-provider-request-a-response"),
          metadata: {},
          payload: {
            threadId: firstThreadId,
            requestId,
            decision: "accept",
            createdAt: "2026-07-14T12:30:02.000Z",
          },
        });

        const readRows = () =>
          sql<{
            readonly threadId: string;
            readonly status: string;
            readonly decision: string | null;
          }>`
          SELECT thread_id AS "threadId", status, decision
          FROM projection_pending_interactions
          WHERE interaction_kind = 'approval' AND request_id = ${requestId}
          ORDER BY thread_id ASC
        `;
        const expectedRows = [
          { threadId: firstThreadId, status: "responding", decision: "accept" },
          { threadId: secondThreadId, status: "pending", decision: null },
        ];

        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRows(), expectedRows);

        yield* sql`DELETE FROM projection_pending_interactions`;
        yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.pendingInteractions}
      `;
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRows(), expectedRows);
      }),
    );

    it.effect("does not let an older provider generation settle a reused request id", () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("thread-reused-request-generation");
        const requestId = ApprovalRequestId.makeUnsafe("reused-provider-request");

        const appendRequest = (generation: string, suffix: string, occurredAt: string) =>
          eventStore.append({
            type: "thread.activity-appended",
            eventId: EventId.makeUnsafe(`evt-request-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: CommandId.makeUnsafe(`cmd-request-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(`cmd-request-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              activity: {
                id: EventId.makeUnsafe(`activity-request-${suffix}`),
                tone: "approval" as const,
                kind: "approval.requested" as const,
                summary: "Approval requested",
                payload: { requestId, requestKind: "command", lifecycleGeneration: generation },
                turnId: null,
                createdAt: occurredAt,
              },
            },
          });
        const appendResponse = (generation: string, suffix: string, occurredAt: string) =>
          eventStore.append({
            type: "thread.approval-response-requested",
            eventId: EventId.makeUnsafe(`evt-response-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: CommandId.makeUnsafe(`cmd-response-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(`cmd-response-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              requestId,
              lifecycleGeneration: generation,
              decision: "accept" as const,
              createdAt: occurredAt,
            },
          });
        const readRow = () =>
          sql<{
            readonly lifecycleGeneration: string | null;
            readonly status: string;
            readonly decision: string | null;
          }>`
          SELECT
            lifecycle_generation AS "lifecycleGeneration",
            status,
            decision
          FROM projection_pending_interactions
          WHERE thread_id = ${threadId}
            AND interaction_kind = 'approval'
            AND request_id = ${requestId}
        `;

        yield* appendRequest("generation-a", "a", "2026-07-14T13:00:00.000Z");
        yield* projectionPipeline.bootstrap;
        yield* appendRequest("generation-b", "b", "2026-07-14T13:00:01.000Z");
        yield* appendResponse("generation-a", "stale-a", "2026-07-14T13:00:02.000Z");
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRow(), [
          { lifecycleGeneration: "generation-b", status: "pending", decision: null },
        ]);

        yield* appendResponse("generation-b", "current-b", "2026-07-14T13:00:03.000Z");
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRow(), [
          { lifecycleGeneration: "generation-b", status: "responding", decision: "accept" },
        ]);

        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.makeUnsafe("evt-response-confirmed-b"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-07-14T13:00:04.000Z",
          commandId: CommandId.makeUnsafe("cmd-response-confirmed-b"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-response-confirmed-b"),
          metadata: { requestId },
          payload: {
            threadId,
            activity: {
              id: EventId.makeUnsafe("activity-response-confirmed-b"),
              tone: "approval",
              kind: "approval.resolved",
              summary: "Approval resolved",
              payload: {
                requestId,
                lifecycleGeneration: "generation-b",
                decision: "accept",
              },
              turnId: null,
              createdAt: "2026-07-14T13:00:04.000Z",
            },
          },
        });
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readRow(), [
          { lifecycleGeneration: "generation-b", status: "confirmed", decision: "accept" },
        ]);
      }),
    );
  },
);

it.effect("fast-forwards lagging hot projector cursors before restart replay", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const readCursors: Array<number> = [];
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(makeObservedEventStoreLayer(readCursors)),
      Layer.provideMerge(persistenceLayer),
    );
    const projectId = ProjectId.makeUnsafe("project-bootstrap-fast-forward");
    const threadId = ThreadId.makeUnsafe("thread-bootstrap-fast-forward");
    const createdAt = "2026-07-09T10:00:00.000Z";

    const latestSequence = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-bootstrap-fast-forward-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-bootstrap-fast-forward-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-bootstrap-fast-forward-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Bootstrap fast-forward project",
          workspaceRoot: "/tmp/project-bootstrap-fast-forward",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-bootstrap-fast-forward-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-bootstrap-fast-forward-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-bootstrap-fast-forward-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Bootstrap fast-forward thread",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-5-20250929",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.bootstrap;

      let latestSequence = 0;
      for (let index = 0; index < 20; index += 1) {
        const occurredAt = `2026-07-09T10:00:${String(index + 1).padStart(2, "0")}.000Z`;
        const savedEvent = yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.makeUnsafe(`evt-bootstrap-fast-forward-activity-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.makeUnsafe(`cmd-bootstrap-fast-forward-activity-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-bootstrap-fast-forward-activity-${index}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.makeUnsafe(`activity-bootstrap-fast-forward-${index}`),
              tone: "info",
              kind: "context-window.updated",
              summary: "Context window updated",
              payload: { usedTokens: index + 1, maxTokens: 200_000 },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
        latestSequence = savedEvent.sequence;
        yield* projectionPipeline.projectEvent(savedEvent);
      }
      return latestSequence;
    }).pipe(Effect.provide(firstProjectionLayer));

    const projectorStates = yield* Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* projectionPipeline.bootstrap;
      return yield* sql<{ readonly projector: string; readonly lastAppliedSequence: number }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector <> ${ORCHESTRATION_PROJECTOR_NAMES.hot}
        ORDER BY projector ASC
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.equal(readCursors.length, projectorStates.length);
    assert.deepEqual([...new Set(readCursors)], [latestSequence]);
    for (const row of projectorStates) {
      assert.equal(row.lastAppliedSequence, latestSequence);
    }
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "synara-projection-pipeline-fast-forward-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("drains 2,501 file-backed events to a captured high-water fence", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const eventStoreLayer = OrchestrationEventStoreLive.pipe(Layer.provideMerge(persistenceLayer));
    const projectId = ProjectId.makeUnsafe("project-bootstrap-paged");
    const occurredAt = "2026-07-14T01:00:00.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-bootstrap-paged-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt,
        commandId: CommandId.makeUnsafe("cmd-bootstrap-paged-created"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-bootstrap-paged-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project 0",
          workspaceRoot: "/tmp/project-bootstrap-paged",
          defaultModelSelection: null,
          scripts: [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
      yield* sql`
        WITH RECURSIVE digits(n) AS (
          SELECT 0
          UNION ALL
          SELECT n + 1 FROM digits WHERE n < 49
        ), numbered(n) AS (
          SELECT (high.n * 50) + low.n + 1
          FROM digits AS high
          CROSS JOIN digits AS low
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'evt-bootstrap-paged-' || n,
          'project',
          ${projectId},
          n,
          'project.meta-updated',
          ${occurredAt},
          'cmd-bootstrap-paged-' || n,
          NULL,
          'cmd-bootstrap-paged-' || n,
          'user',
          json_object(
            'projectId', ${projectId},
            'title', 'Project ' || n,
            'updatedAt', ${occurredAt}
          ),
          '{}'
        FROM numbered
      `;
    }).pipe(Effect.provide(eventStoreLayer));

    let appendedAfterFence = false;
    const appendAfterFenceLayer = Layer.effect(
      OrchestrationEventStore,
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        return {
          ...eventStore,
          readFromSequence(sequenceExclusive, limit, throughSequenceInclusive) {
            return Stream.unwrap(
              Effect.gen(function* () {
                if (!appendedAfterFence) {
                  appendedAfterFence = true;
                  yield* eventStore.append({
                    type: "project.meta-updated",
                    eventId: EventId.makeUnsafe("evt-bootstrap-paged-after-fence"),
                    aggregateKind: "project",
                    aggregateId: projectId,
                    occurredAt,
                    commandId: CommandId.makeUnsafe("cmd-bootstrap-paged-after-fence"),
                    causationEventId: null,
                    correlationId: CorrelationId.makeUnsafe("cmd-bootstrap-paged-after-fence"),
                    metadata: {},
                    payload: {
                      projectId,
                      title: "Project after fence",
                      updatedAt: occurredAt,
                    },
                  });
                }
                return eventStore.readFromSequence(
                  sequenceExclusive,
                  limit,
                  throughSequenceInclusive,
                );
              }),
            );
          },
        } satisfies OrchestrationEventStoreShape;
      }),
    ).pipe(Layer.provide(OrchestrationEventStoreLive));
    const projectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(appendAfterFenceLayer),
      Layer.provideMerge(persistenceLayer),
    );

    const result = yield* Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* projectionPipeline.bootstrap;
      const projects = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_projects WHERE project_id = ${projectId}
      `;
      const cursors = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence" FROM projection_state
      `;
      const eventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
      `;
      return { projects, cursors, eventCount: eventCount[0]?.count ?? 0 };
    }).pipe(Effect.provide(projectionLayer));

    assert.deepEqual(result.projects, [{ title: "Project 2500" }]);
    assert.equal(result.eventCount, 2_502);
    assert.equal(result.cursors.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
    for (const cursor of result.cursors) {
      assert.equal(cursor.lastAppliedSequence, 2_501);
    }
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "synara-projection-pipeline-paged-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-attachments"),
            messageId: MessageId.makeUnsafe("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-pipeline-approvals-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("refreshes stored thread approval summary after approval-response-requested", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-approvals");
      const threadId = ThreadId.makeUnsafe("thread-approvals");
      const requestId = ApprovalRequestId.makeUnsafe("approval-request-1");
      const createdAt = "2026-03-05T09:00:00.000Z";
      const requestedAt = "2026-03-05T09:00:01.000Z";
      const resolvedAt = "2026-03-05T09:00:02.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-approvals-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-approvals-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-approvals-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Approvals Project",
          workspaceRoot: "/tmp/project-approvals",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-approvals-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-approvals-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-approvals-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Approvals Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("evt-approvals-requested"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: requestedAt,
        commandId: CommandId.makeUnsafe("cmd-approvals-requested"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-approvals-requested"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId,
              requestKind: "command",
            },
            turnId: null,
            createdAt: requestedAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterRequest = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT
          pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rowsAfterRequest, [{ pendingApprovalCount: 1 }]);

      yield* eventStore.append({
        type: "thread.approval-response-requested",
        eventId: EventId.makeUnsafe("evt-approvals-resolved"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: resolvedAt,
        commandId: CommandId.makeUnsafe("cmd-approvals-resolved"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-approvals-resolved"),
        metadata: {},
        payload: {
          threadId,
          requestId,
          decision: "accept",
          createdAt: resolvedAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterResolve = yield* sql<{
        readonly pendingApprovalCount: number;
        readonly updatedAt: string;
      }>`
        SELECT
          pending_approval_count AS "pendingApprovalCount",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rowsAfterResolve, [
        {
          pendingApprovalCount: 0,
          updatedAt: resolvedAt,
        },
      ]);
    }),
  );

  it.effect("does not refresh stored thread shell summary for streaming assistant deltas", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-streaming-shell");
      const threadId = ThreadId.makeUnsafe("thread-streaming-shell");
      const createdAt = "2026-03-05T10:00:00.000Z";
      const deltaAt = "2026-03-05T10:00:05.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-streaming-shell-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-streaming-shell-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-streaming-shell-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Streaming Shell Project",
          workspaceRoot: "/tmp/project-streaming-shell",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-streaming-shell-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-streaming-shell-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-streaming-shell-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Streaming Shell Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-streaming-shell-assistant-delta"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: deltaAt,
        commandId: CommandId.makeUnsafe("cmd-streaming-shell-assistant-delta"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-streaming-shell-assistant-delta"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-streaming-shell-assistant"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: true,
          createdAt: deltaAt,
          updatedAt: deltaAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly latestUserMessageAt: string | null;
        readonly updatedAt: string;
      }>`
          SELECT
            latest_user_message_at AS "latestUserMessageAt",
            updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
      assert.deepEqual(rows, [
        {
          latestUserMessageAt: null,
          updatedAt: createdAt,
        },
      ]);
    }),
  );

  it.effect("refreshes stored thread user-input summary after user-input-response-requested", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-user-inputs");
      const threadId = ThreadId.makeUnsafe("thread-user-inputs");
      const requestId = ApprovalRequestId.makeUnsafe("user-input-request-1");
      const createdAt = "2026-03-05T11:00:00.000Z";
      const requestedAt = "2026-03-05T11:00:01.000Z";
      const respondedAt = "2026-03-05T11:00:02.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-user-input-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-project"),
        metadata: {},
        payload: {
          projectId,
          title: "User Input Project",
          workspaceRoot: "/tmp/project-user-input",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-user-input-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "User Input Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("evt-user-input-requested"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: requestedAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-requested"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Need more info",
            payload: {
              requestId,
              questions: [
                {
                  id: "q1",
                  header: "Choice",
                  question: "Pick one",
                  options: [
                    {
                      label: "Yes",
                      description: "Use the provided answer",
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: requestedAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterRequest = yield* sql<{
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
      }>`
          SELECT
            pending_approval_count AS "pendingApprovalCount",
            pending_user_input_count AS "pendingUserInputCount"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
      assert.deepEqual(rowsAfterRequest, [{ pendingApprovalCount: 0, pendingUserInputCount: 1 }]);

      // Simulate rows written by older projectors that treated user-input requests as approvals.
      yield* sql`
            INSERT INTO projection_pending_interactions (
              interaction_kind,
              request_id,
              thread_id,
              turn_id,
              status,
              decision,
              created_at,
              resolved_at
            )
            VALUES (
              'approval',
              ${requestId},
              ${threadId},
              ${null},
              'pending',
              ${null},
              ${requestedAt},
              ${null}
            )
          `;

      yield* eventStore.append({
        type: "thread.user-input-response-requested",
        eventId: EventId.makeUnsafe("evt-user-input-responded"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: respondedAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-responded"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-responded"),
        metadata: {},
        payload: {
          threadId,
          requestId,
          answers: {
            q1: "yes",
          },
          createdAt: respondedAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterRespond = yield* sql<{
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
        readonly updatedAt: string;
      }>`
          SELECT
            pending_approval_count AS "pendingApprovalCount",
            pending_user_input_count AS "pendingUserInputCount",
            updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
      assert.deepEqual(rowsAfterRespond, [
        {
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          updatedAt: respondedAt,
        },
      ]);

      const interactionRowsAfterRespond = yield* sql<{
        readonly interactionKind: string;
        readonly status: string;
        readonly responseCommandId: string | null;
      }>`
        SELECT
          interaction_kind AS "interactionKind",
          status,
          response_command_id AS "responseCommandId"
        FROM projection_pending_interactions
        WHERE thread_id = ${threadId} AND request_id = ${requestId}
        ORDER BY interaction_kind
      `;
      assert.deepEqual(interactionRowsAfterRespond, [
        { interactionKind: "approval", status: "pending", responseCommandId: null },
        {
          interactionKind: "userInput",
          status: "responding",
          responseCommandId: "cmd-user-input-responded",
        },
      ]);

      const failedAt = "2026-03-05T11:00:03.000Z";
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("evt-user-input-response-failed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: failedAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-response-failed"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-response-failed"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-user-input-response-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "User input response failed",
            payload: {
              requestId,
              responseCommandId: "cmd-user-input-responded",
              settlementStatus: "retryable",
              detail: "No active provider session is bound to this thread.",
            },
            turnId: null,
            createdAt: failedAt,
          },
        },
      });
      yield* projectionPipeline.bootstrap;

      const retryableRows = yield* sql<{
        readonly status: string;
        readonly pendingUserInputCount: number;
      }>`
        SELECT
          interactions.status,
          threads.pending_user_input_count AS "pendingUserInputCount"
        FROM projection_pending_interactions AS interactions
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = interactions.thread_id
        WHERE interactions.thread_id = ${threadId}
          AND interactions.interaction_kind = 'userInput'
          AND interactions.request_id = ${requestId}
      `;
      assert.deepEqual(retryableRows, [{ status: "retryable", pendingUserInputCount: 1 }]);

      const retryAt = "2026-03-05T11:00:04.000Z";
      yield* eventStore.append({
        type: "thread.user-input-response-requested",
        eventId: EventId.makeUnsafe("evt-user-input-retried"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: retryAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-retried"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-retried"),
        metadata: {},
        payload: {
          threadId,
          requestId,
          answers: { q1: "yes" },
          createdAt: retryAt,
        },
      });
      yield* projectionPipeline.bootstrap;

      const confirmedAt = "2026-03-05T11:00:05.000Z";
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("evt-user-input-confirmed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: confirmedAt,
        commandId: CommandId.makeUnsafe("cmd-user-input-confirmed"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-user-input-confirmed"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-user-input-confirmed"),
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input answered",
            payload: { requestId, answers: { q1: "yes" } },
            turnId: null,
            createdAt: confirmedAt,
          },
        },
      });
      yield* projectionPipeline.bootstrap;

      const confirmedRows = yield* sql<{
        readonly status: string;
        readonly responseCommandId: string | null;
        readonly resolvedAt: string;
      }>`
        SELECT
          status,
          response_command_id AS "responseCommandId",
          resolved_at AS "resolvedAt"
        FROM projection_pending_interactions
        WHERE thread_id = ${threadId}
          AND interaction_kind = 'userInput'
          AND request_id = ${requestId}
      `;
      assert.deepEqual(confirmedRows, [
        {
          status: "confirmed",
          responseCommandId: "cmd-user-input-retried",
          resolvedAt: confirmedAt,
        },
      ]);
    }),
  );

  it.effect("settles pending interactions from reconciliation stale-request failures", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-stale-reconcile");
      const threadId = ThreadId.makeUnsafe("thread-stale-reconcile");
      const requestId = ApprovalRequestId.makeUnsafe("user-input-request-stale");
      const createdAt = "2026-03-06T09:00:00.000Z";
      const requestedAt = "2026-03-06T09:00:01.000Z";
      const reconciledAt = "2026-03-06T09:00:02.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-stale-reconcile-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-stale-reconcile-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stale-reconcile-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Stale Reconcile Project",
          workspaceRoot: "/tmp/project-stale-reconcile",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-stale-reconcile-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-stale-reconcile-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stale-reconcile-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Stale Reconcile Thread",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-5",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("evt-stale-reconcile-requested"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: requestedAt,
        commandId: CommandId.makeUnsafe("cmd-stale-reconcile-requested"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stale-reconcile-requested"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-stale-reconcile-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Need more info",
            payload: {
              requestId,
              lifecycleGeneration: "generation-old",
              questions: [],
            },
            turnId: null,
            createdAt: requestedAt,
          },
        },
      });

      // Restart/session reconciliation reports the request as stale without a
      // responseCommandId: nothing ever claimed the row, but the provider
      // callback that could consume it is gone. The row must not stay pending.
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("evt-stale-reconcile-failed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: reconciledAt,
        commandId: CommandId.makeUnsafe("cmd-stale-reconcile-failed"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stale-reconcile-failed"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-stale-reconcile-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            payload: {
              requestId,
              detail: `Stale pending user-input request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`,
            },
            turnId: null,
            createdAt: reconciledAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly status: string;
        readonly pendingUserInputCount: number;
      }>`
        SELECT
          interactions.status,
          threads.pending_user_input_count AS "pendingUserInputCount"
        FROM projection_pending_interactions AS interactions
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = interactions.thread_id
        WHERE interactions.thread_id = ${threadId}
          AND interactions.interaction_kind = 'userInput'
          AND interactions.request_id = ${requestId}
      `;
      assert.deepEqual(settledRows, [{ status: "uncertain", pendingUserInputCount: 0 }]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-attachments-safe-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("preserves mixed image attachment metadata as-is", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-attachments-safe"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-attachments-safe"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-attachments-safe"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-attachments-safe"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-attachments-safe"),
          messageId: MessageId.makeUnsafe("message-attachments-safe"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              id: "thread-attachments-safe-att-1",
              name: "untrusted.exe",
              mimeType: "image/x-unknown",
              sizeBytes: 5,
            },
            {
              type: "image",
              id: "thread-attachments-safe-att-2",
              name: "not-image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-attachments-safe-att-1",
          name: "untrusted.exe",
          mimeType: "image/x-unknown",
          sizeBytes: 5,
        },
        {
          type: "image",
          id: "thread-attachments-safe-att-2",
          name: "not-image.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 1_000).toISOString();

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1_000).toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.makeUnsafe("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-rollback"),
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-rollback"),
            messageId: MessageId.makeUnsafe("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );

  it.effect("streams assistant deltas into one byte-identical message row", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
      const projectId = ProjectId.makeUnsafe("project-stream-append");
      const threadId = ThreadId.makeUnsafe("thread-stream-append");
      const messageId = MessageId.makeUnsafe("message-stream-append");
      const turnId = TurnId.makeUnsafe("turn-stream-append");
      const otherTurnId = TurnId.makeUnsafe("turn-stream-append-other");
      const createdAt = "2026-04-01T10:00:00.000Z";
      const iso = (offsetSeconds: number) =>
        new Date(Date.parse(createdAt) + offsetSeconds * 1_000).toISOString();

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-stream-append-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-stream-append-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-append-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Stream Append Project",
          workspaceRoot: "/tmp/project-stream-append",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-stream-append-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-stream-append-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-append-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Stream Append Thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      // Deltas deliberately include multi-byte characters, empty chunks and
      // trailing whitespace: the appended text must match a plain JS join.
      const deltas = Array.from({ length: 64 }, (_, index) =>
        index % 8 === 3 ? "" : `δ${index}-${"x".repeat(index % 5)}${index % 4 === 0 ? "\n" : " "}`,
      );

      for (const [index, delta] of deltas.entries()) {
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe(`evt-stream-append-delta-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: iso(index + 1),
          commandId: CommandId.makeUnsafe(`cmd-stream-append-delta-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-stream-append-delta-${index}`),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "assistant",
            text: delta,
            // The first delta creates the row without a turn; the next one binds
            // it, and a later conflicting turn must not steal the binding.
            turnId: index === 0 ? null : index === 40 ? otherTurnId : turnId,
            streaming: true,
            ...(index === 1 ? { dispatchOrigin: "agent" as const } : {}),
            createdAt: iso(index + 1),
            updatedAt: iso(index + 1),
          },
        });
      }

      const streamedRows = yield* sql<{
        readonly text: string;
        readonly turnId: string | null;
        readonly dispatchOrigin: string | null;
        readonly isStreaming: unknown;
        readonly sequence: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          text,
          turn_id AS "turnId",
          dispatch_origin AS "dispatchOrigin",
          is_streaming AS "isStreaming",
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      const streamed = streamedRows[0];
      assert.lengthOf(streamedRows, 1);
      assert.equal(streamed?.text, deltas.join(""));
      assert.equal(streamed?.turnId, turnId);
      assert.equal(streamed?.dispatchOrigin, "agent");
      assert.isTrue(Boolean(streamed?.isStreaming));
      assert.equal(streamed?.createdAt, iso(1));
      assert.equal(streamed?.updatedAt, iso(deltas.length));

      const firstDeltaSequence = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE event_id = 'evt-stream-append-delta-0'
      `;
      assert.equal(streamed?.sequence, firstDeltaSequence[0]?.sequence);

      // Every phase cursor must stay exactly at the last projected event: the
      // client snapshot sequence is their minimum, and a lagging cursor makes
      // clients replay deltas they already applied.
      const lastDeltaSequence = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE event_id = ${`evt-stream-append-delta-${deltas.length - 1}`}
      `;
      const shellCursor = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries}
      `;
      assert.equal(shellCursor[0]?.lastAppliedSequence, lastDeltaSequence[0]?.sequence);

      // Non-streaming writes replace the accumulated text instead of appending.
      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-stream-append-final"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: iso(500),
        commandId: CommandId.makeUnsafe("cmd-stream-append-final"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-append-final"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "assistant",
          text: "replaced final text",
          turnId,
          streaming: false,
          createdAt: iso(500),
          updatedAt: iso(500),
        },
      });

      // An empty non-streaming write keeps the stored text.
      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-stream-append-complete"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: iso(501),
        commandId: CommandId.makeUnsafe("cmd-stream-append-complete"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-append-complete"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: iso(501),
          updatedAt: iso(501),
        },
      });

      const settledRows = yield* sql<{
        readonly text: string;
        readonly isStreaming: unknown;
        readonly sequence: number;
        readonly createdAt: string;
      }>`
        SELECT text, is_streaming AS "isStreaming", sequence, created_at AS "createdAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal(settledRows[0]?.text, "replaced final text");
      assert.isFalse(Boolean(settledRows[0]?.isStreaming));
      assert.equal(settledRows[0]?.sequence, firstDeltaSequence[0]?.sequence);
      assert.equal(settledRows[0]?.createdAt, iso(1));
    }),
  );

  it.effect("keeps streaming appends and message rebuilds consistent after a rollback", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
      const projectId = ProjectId.makeUnsafe("project-stream-restart");
      const threadId = ThreadId.makeUnsafe("thread-stream-restart");
      const messageId = MessageId.makeUnsafe("message-stream-restart");
      const createdAt = "2026-04-02T10:00:00.000Z";

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-stream-restart-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-stream-restart-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-restart-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Stream Restart Project",
          workspaceRoot: "/tmp/project-stream-restart",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-stream-restart-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-stream-restart-thread"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-stream-restart-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Stream Restart Thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      for (const [index, delta] of ["first ", "second ", "third"].entries()) {
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe(`evt-stream-restart-delta-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe(`cmd-stream-restart-delta-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-stream-restart-delta-${index}`),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "assistant",
            text: delta,
            turnId: null,
            streaming: true,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      // Replaying the journal from scratch must land on the same text: the
      // append path is only correct if it is driven by the event log alone.
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_state`;
      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.lengthOf(rows, 1);
      assert.equal(rows[0]?.text, "first second third");
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("prunes legacy and managed attachments through their existing authorities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const managedAttachments = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const removeFileAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000004";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";
      const keepManagedAttachmentId = "att_v2_33333333333333333333333333333333";
      const removeManagedAttachmentId = "att_v2_44444444444444444444444444444444";
      const keepManagedRelativePath = `objects/33/${keepManagedAttachmentId}.txt`;
      const removeManagedRelativePath = `objects/44/${removeManagedAttachmentId}.txt`;

      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

      for (const [attachmentId, relativePath, commandId, messageId] of [
        [
          keepManagedAttachmentId,
          keepManagedRelativePath,
          "command-managed-coexist-keep",
          "message-keep",
        ],
        [
          removeManagedAttachmentId,
          removeManagedRelativePath,
          "command-managed-coexist-remove",
          "message-remove",
        ],
      ] as const) {
        assert.strictEqual(
          (yield* managedAttachments.reserve({
            attachmentId,
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-managed-coexist",
            kind: "file",
            originalName: `${attachmentId}.txt`,
            mimeType: "text/plain",
            reservedBytes: 5,
            relativePath,
            now,
          })).status,
          "reserved",
        );
        assert.strictEqual(
          (yield* managedAttachments.finalizeStaged({
            attachmentId,
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-managed-coexist",
            sizeBytes: 5,
            sha256: "b".repeat(64),
            stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            now,
          })).status,
          "staged",
        );
        assert.strictEqual(
          (yield* managedAttachments.claimForAcceptedTurn({
            attachmentIds: [attachmentId],
            ownerThreadId: threadId,
            ownerKind: "principal",
            ownerId: "principal-managed-coexist",
            commandId,
            messageId,
            now,
          })).status,
          "claimed",
        );
      }

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/historical/checkpoints/thread-revert-files/turn/1",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: keepManagedAttachmentId,
              name: "managed-keep.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/historical/checkpoints/thread-revert-files/turn/2",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: removeFileAttachmentId,
              name: "remove.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: removeManagedAttachmentId,
              name: "managed-remove.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      const removeFilePath = path.join(attachmentsDir, `${removeFileAttachmentId}.txt`);
      const keepManagedPath = path.join(attachmentsDir, keepManagedRelativePath);
      const removeManagedPath = path.join(attachmentsDir, removeManagedRelativePath);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(keepManagedPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(removeManagedPath), { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      yield* fileSystem.writeFileString(removeFilePath, "remove-file");
      yield* fileSystem.writeFileString(keepManagedPath, "keep!");
      yield* fileSystem.writeFileString(removeManagedPath, "drop!");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(removeFilePath));
      assert.isTrue(yield* exists(otherThreadPath));
      assert.isTrue(yield* exists(keepManagedPath));
      assert.isTrue(yield* exists(removeManagedPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isFalse(yield* exists(removeFilePath));
      assert.isTrue(yield* exists(otherThreadPath));
      assert.isTrue(yield* exists(keepManagedPath));
      assert.isTrue(yield* exists(removeManagedPath));

      const statesBeforeCleanup = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE attachment_id IN (${keepManagedAttachmentId}, ${removeManagedAttachmentId})
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(statesBeforeCleanup, [
        { attachmentId: keepManagedAttachmentId, state: "claimed" },
        { attachmentId: removeManagedAttachmentId, state: "deleting" },
      ]);

      yield* runManagedAttachmentCleanupBatch;

      assert.isTrue(yield* exists(keepManagedPath));
      assert.isFalse(yield* exists(removeManagedPath));
      const statesAfterCleanup = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE attachment_id IN (${keepManagedAttachmentId}, ${removeManagedAttachmentId})
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(statesAfterCleanup, [
        { attachmentId: keepManagedAttachmentId, state: "claimed" },
        { attachmentId: removeManagedAttachmentId, state: "deleted" },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-attachments-revert-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes thread attachment directory when thread is deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("Thread Delete.Files");
      const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
      const otherThreadAttachmentId =
        "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-delete-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-delete-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-delete-files"),
          title: "Project Delete Files",
          workspaceRoot: "/tmp/project-delete-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-delete-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-delete-files"),
          title: "Thread Delete Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-delete-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-delete-files"),
          role: "user",
          text: "Delete",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "delete.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
      const otherThreadAttachmentPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
      yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
      assert.isTrue(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));

      yield* appendAndProject({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("evt-delete-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-4"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: now,
        },
      });

      assert.isFalse(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-attachments-delete-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const now = new Date().toISOString();
      const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
      const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
      const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
      yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
      yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

      yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("evt-unsafe-thread-delete"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe(".."),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-unsafe-thread-delete"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-unsafe-thread-delete"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe(".."),
          deletedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(attachmentsRootDir));
      assert.isTrue(yield* exists(attachmentsSentinelPath));
      assert.isTrue(yield* exists(stateDirSentinelPath));
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Thread A",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.makeUnsafe("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            turnId: TurnId.makeUnsafe("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            messageId: MessageId.makeUnsafe("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.makeUnsafe("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.makeUnsafe("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            turnId: TurnId.makeUnsafe("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe(
              "refs/historical/checkpoints/thread-conflict/turn/1",
            ),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.makeUnsafe("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
        ]);
      }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/historical/checkpoints/thread-revert/turn/1",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnId: TurnId.makeUnsafe("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/historical/checkpoints/thread-revert/turn/2",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.makeUnsafe("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.makeUnsafe("thread-restart");
    const turnId = TurnId.makeUnsafe("turn-restart");
    const messageId = MessageId.makeUnsafe("message-restart");
    const sourcePlanThreadId = ThreadId.makeUnsafe("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.makeUnsafe("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.makeUnsafe("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly requestedAt: string;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        requestedAt: turnStartedAt,
        startedAt: sessionSetAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "synara-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "synara-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-live-project"),
        projectId: ProjectId.makeUnsafe("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);

      const snapshotProjectorRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector IN (
          'projection.projects',
          'projection.threads',
          'projection.thread-messages',
          'projection.thread-proposed-plans',
          'projection.thread-activities',
          'projection.thread-sessions',
          'projection.checkpoints'
        )
        ORDER BY projector ASC
      `;
      assert.deepEqual(snapshotProjectorRows, [
        { projector: "projection.checkpoints", lastAppliedSequence: 1 },
        { projector: "projection.projects", lastAppliedSequence: 1 },
        { projector: "projection.thread-activities", lastAppliedSequence: 1 },
        { projector: "projection.thread-messages", lastAppliedSequence: 1 },
        { projector: "projection.thread-proposed-plans", lastAppliedSequence: 1 },
        { projector: "projection.thread-sessions", lastAppliedSequence: 1 },
        { projector: "projection.threads", lastAppliedSequence: 1 },
      ]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-create"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-update"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        isPinned: true,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
        readonly isPinned: number;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection",
          is_pinned AS "isPinned"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"provider":"codex","model":"gpt-5"}',
          isPinned: 1,
        },
      ]);
    }),
  );

  it.effect("routes telemetry activities only through their owning hot projector", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-07-09T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("project-routed-telemetry");
      const threadId = ThreadId.makeUnsafe("thread-routed-telemetry");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-routed-project"),
        projectId,
        title: "Routed telemetry",
        workspaceRoot: "/tmp/project-routed-telemetry",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-routed-thread"),
        threadId,
        projectId,
        title: "Routed telemetry",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      yield* sql`CREATE TABLE projection_state_write_log (projector TEXT NOT NULL)`;
      yield* sql`
        CREATE TRIGGER log_projection_state_insert
        AFTER INSERT ON projection_state
        BEGIN
          INSERT INTO projection_state_write_log (projector) VALUES (NEW.projector);
        END
      `;
      yield* sql`
        CREATE TRIGGER log_projection_state_update
        AFTER UPDATE ON projection_state
        BEGIN
          INSERT INTO projection_state_write_log (projector) VALUES (NEW.projector);
        END
      `;

      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-routed-context-window"),
        threadId,
        activity: {
          id: EventId.makeUnsafe("activity-routed-context-window"),
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: { usedTokens: 42, maxTokens: 200_000 },
          turnId: null,
          createdAt,
        },
        createdAt,
      });

      const writes = yield* sql<{ readonly projector: string }>`
        SELECT projector
        FROM projection_state_write_log
        ORDER BY projector ASC
      `;
      assert.deepEqual(writes, [
        { projector: "projection.hot" },
        { projector: "projection.thread-activities" },
        { projector: "projection.thread-shell-summaries" },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("synara-projection-pipeline-turn-finish-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("keeps assistant message completions from settling a running turn early", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-turn-finish");
      const turnId = TurnId.makeUnsafe("turn-turn-finish");
      const startedAt = "2026-02-27T09:00:00.000Z";
      const assistantCompletedAt = "2026-02-27T09:00:02.000Z";
      const turnFinishedAt = "2026-02-27T09:00:05.000Z";

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-turn-finish-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: startedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-1"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-turn-finish"),
          runtimeMode: "full-access",
          createdAt: startedAt,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-turn-finish-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: startedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: startedAt,
          },
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-turn-finish-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: assistantCompletedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("assistant-turn-finish"),
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: assistantCompletedAt,
          updatedAt: assistantCompletedAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterAssistantComplete = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
        readonly assistantMessageId: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `;
      assert.deepEqual(rowsAfterAssistantComplete, [
        {
          state: "running",
          completedAt: null,
          assistantMessageId: "assistant-turn-finish",
        },
      ]);

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-turn-finish-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnFinishedAt,
        commandId: CommandId.makeUnsafe("cmd-turn-finish-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-turn-finish-4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: turnFinishedAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const rowsAfterSessionReady = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `;
      assert.deepEqual(rowsAfterSessionReady, [
        {
          state: "completed",
          completedAt: turnFinishedAt,
        },
      ]);
    }),
  );

  it.effect("matches in-memory turn settlement for terminal session statuses", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const scenarios = [
        {
          key: "ready-cleared",
          status: "ready",
          retainsActiveTurn: false,
          expectedState: "completed",
          expectedCompleted: true,
        },
        {
          key: "interrupted-cleared",
          status: "interrupted",
          retainsActiveTurn: false,
          expectedState: "interrupted",
          expectedCompleted: true,
        },
        {
          key: "stopped-cleared",
          status: "stopped",
          retainsActiveTurn: false,
          expectedState: "interrupted",
          expectedCompleted: true,
        },
        {
          key: "error-retained",
          status: "error",
          retainsActiveTurn: true,
          expectedState: "error",
          expectedCompleted: true,
        },
        {
          key: "interrupted-retained",
          status: "interrupted",
          retainsActiveTurn: true,
          expectedState: "running",
          expectedCompleted: false,
        },
        {
          key: "stopped-retained",
          status: "stopped",
          retainsActiveTurn: true,
          expectedState: "running",
          expectedCompleted: false,
        },
      ] as const;

      for (const [index, scenario] of scenarios.entries()) {
        const threadId = ThreadId.makeUnsafe(`thread-session-settlement-${scenario.key}`);
        const turnId = TurnId.makeUnsafe(`turn-session-settlement-${scenario.key}`);
        const startedAt = `2026-02-27T12:00:${String(index * 2).padStart(2, "0")}.000Z`;
        const settledAt = `2026-02-27T12:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.makeUnsafe(`evt-session-settlement-${scenario.key}-running`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.makeUnsafe(`cmd-session-settlement-${scenario.key}-running`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-session-settlement-${scenario.key}-running`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: startedAt,
            },
          },
        });

        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.makeUnsafe(`evt-session-settlement-${scenario.key}-terminal`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: settledAt,
          commandId: CommandId.makeUnsafe(`cmd-session-settlement-${scenario.key}-terminal`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(
            `cmd-session-settlement-${scenario.key}-terminal`,
          ),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: scenario.status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: scenario.retainsActiveTurn ? turnId : null,
              lastError: scenario.status === "error" ? "provider crashed" : null,
              updatedAt: settledAt,
            },
          },
        });
      }

      yield* projectionPipeline.bootstrap;

      for (const [index, scenario] of scenarios.entries()) {
        const threadId = ThreadId.makeUnsafe(`thread-session-settlement-${scenario.key}`);
        const turnId = TurnId.makeUnsafe(`turn-session-settlement-${scenario.key}`);
        const settledAt = `2026-02-27T12:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;
        const rows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
        `;

        assert.deepEqual(rows, [
          {
            state: scenario.expectedState,
            completedAt: scenario.expectedCompleted ? settledAt : null,
          },
        ]);
      }
    }),
  );

  it.effect("projects steer dispatch mode onto the triggering user message", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-steer-chip");
      const messageId = MessageId.makeUnsafe("message-steer-chip");
      const createdAt = "2026-02-27T11:00:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-steer-chip-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-steer-chip-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-steer-chip-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "hello",
          dispatchMode: "steer",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly dispatchMode: string | null }>`
        SELECT dispatch_mode AS "dispatchMode"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;

      assert.deepEqual(rows, [{ dispatchMode: "steer" }]);
    }),
  );

  it.effect("projects the automation dispatch origin onto the triggering user message", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-automation-chip");
      const messageId = MessageId.makeUnsafe("message-automation-chip");
      const createdAt = "2026-02-27T11:05:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-automation-chip-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-automation-chip-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-automation-chip-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "run the nightly review",
          dispatchOrigin: "automation",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly dispatchOrigin: string | null }>`
        SELECT dispatch_origin AS "dispatchOrigin"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;

      assert.deepEqual(rows, [{ dispatchOrigin: "automation" }]);
    }),
  );

  it.effect("projects the agent dispatch origin onto the triggering user message", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-agent-chip");
      const messageId = MessageId.makeUnsafe("message-agent-chip");
      const createdAt = "2026-02-27T11:06:00.000Z";

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-agent-chip-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-agent-chip-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-agent-chip-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "status check from the coordinating agent",
          dispatchOrigin: "agent",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly dispatchOrigin: string | null }>`
        SELECT dispatch_origin AS "dispatchOrigin"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;

      assert.deepEqual(rows, [{ dispatchOrigin: "agent" }]);
    }),
  );

  it.effect("preserves exact managed attachment references during projection rebuild", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const managedAttachments = yield* ManagedAttachmentRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-managed-rebuild");
      const retainedAttachmentId = "att_v2_11111111111111111111111111111111";
      const prunedAttachmentId = "att_v2_22222222222222222222222222222222";
      const retainedLegacyId = "thread-managed-rebuild-11111111-1111-4111-8111-111111111111";
      const prunedLegacyId = "thread-managed-rebuild-22222222-2222-4222-8222-222222222222";
      const retainedMessageId = MessageId.makeUnsafe("message-managed-retained");
      const prunedMessageId = MessageId.makeUnsafe("message-managed-pruned");
      const createdAt = "2020-07-14T14:00:00.000Z";

      for (const [attachmentId, messageId, commandId] of [
        [retainedAttachmentId, retainedMessageId, "command-managed-retained"],
        [prunedAttachmentId, prunedMessageId, "command-managed-pruned"],
      ] as const) {
        const reserved = yield* managedAttachments.reserve({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-managed-rebuild",
          kind: "file",
          originalName: `${attachmentId}.txt`,
          mimeType: "text/plain",
          reservedBytes: 4,
          relativePath: `objects/${attachmentId.slice(7, 9)}/${attachmentId}.txt`,
          now: createdAt,
        });
        assert.strictEqual(reserved.status, "reserved");
        const staged = yield* managedAttachments.finalizeStaged({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-managed-rebuild",
          sizeBytes: 4,
          sha256: "a".repeat(64),
          stagingExpiresAt: "2020-07-14T15:00:00.000Z",
          now: "2020-07-14T14:00:01.000Z",
        });
        assert.strictEqual(staged.status, "staged");
        const claimed = yield* managedAttachments.claimForAcceptedTurn({
          attachmentIds: [attachmentId],
          ownerThreadId: threadId,
          ownerKind: "principal",
          ownerId: "principal-managed-rebuild",
          commandId,
          messageId,
          now: "2020-07-14T14:00:02.000Z",
        });
        assert.strictEqual(claimed.status, "claimed");
      }

      for (const [eventId, commandId, messageId, attachmentId, text, occurredAt] of [
        [
          "evt-managed-rebuild-retained",
          "cmd-managed-rebuild-retained",
          retainedMessageId,
          retainedAttachmentId,
          "retained",
          "2020-07-14T14:00:03.000Z",
        ],
        [
          "evt-managed-rebuild-pruned",
          "cmd-managed-rebuild-pruned",
          prunedMessageId,
          prunedAttachmentId,
          "pruned",
          "2020-07-14T14:00:04.000Z",
        ],
      ] as const) {
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.makeUnsafe(commandId),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(commandId),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "user",
            text,
            attachments: [
              {
                type: "file",
                id: attachmentId,
                name: `${text}.txt`,
                mimeType: "text/plain",
                sizeBytes: 4,
              },
              {
                type: "file",
                id: text === "retained" ? retainedLegacyId : prunedLegacyId,
                name: `${text}-legacy.txt`,
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
      }

      yield* eventStore.append({
        type: "thread.conversation-rolled-back",
        eventId: EventId.makeUnsafe("evt-managed-rebuild-rollback"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2020-07-14T14:00:05.000Z",
        commandId: CommandId.makeUnsafe("cmd-managed-rebuild-rollback"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-managed-rebuild-rollback"),
        metadata: {},
        payload: {
          threadId,
          messageId: prunedMessageId,
          numTurns: 1,
          removedTurnIds: [],
        },
      });

      const retainedManagedPath = path.join(
        attachmentsDir,
        `objects/11/${retainedAttachmentId}.txt`,
      );
      const prunedManagedPath = path.join(attachmentsDir, `objects/22/${prunedAttachmentId}.txt`);
      const retainedLegacyPath = path.join(attachmentsDir, `${retainedLegacyId}.txt`);
      const prunedLegacyPath = path.join(attachmentsDir, `${prunedLegacyId}.txt`);
      for (const filePath of [
        retainedManagedPath,
        prunedManagedPath,
        retainedLegacyPath,
        prunedLegacyPath,
      ]) {
        yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fileSystem.writeFileString(filePath, "data");
      }

      const highWaterSequence = yield* eventStore.getHighWaterSequence();
      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(retainedLegacyPath));
      assert.isFalse(yield* exists(prunedLegacyPath));
      assert.isTrue(yield* exists(retainedManagedPath));
      assert.isTrue(yield* exists(prunedManagedPath));

      const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(messages, [{ messageId: retainedMessageId }]);

      const blobs = yield* sql<{ readonly attachmentId: string; readonly state: string }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE owner_thread_id = ${threadId}
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(blobs, [
        { attachmentId: retainedAttachmentId, state: "claimed" },
        { attachmentId: prunedAttachmentId, state: "deleting" },
      ]);

      const cleanupJobs = yield* sql<{
        readonly attachmentId: string;
        readonly reason: string;
      }>`
        SELECT attachment_id AS "attachmentId", reason
        FROM managed_attachment_cleanup_jobs
        WHERE attachment_id IN (${retainedAttachmentId}, ${prunedAttachmentId})
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(cleanupJobs, [
        { attachmentId: prunedAttachmentId, reason: "projection-pruned" },
      ]);

      const projectorState = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;
      assert.deepStrictEqual(projectorState, [{ lastAppliedSequence: highWaterSequence }]);

      yield* runManagedAttachmentCleanupBatch;
      assert.isTrue(yield* exists(retainedLegacyPath));
      assert.isTrue(yield* exists(retainedManagedPath));
      assert.isFalse(yield* exists(prunedManagedPath));
      const completedBlobs = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        WHERE owner_thread_id = ${threadId}
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(completedBlobs, [
        { attachmentId: retainedAttachmentId, state: "claimed" },
        { attachmentId: prunedAttachmentId, state: "deleted" },
      ]);
    }),
  );
});
