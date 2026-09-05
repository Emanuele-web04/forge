import {
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
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../../orchestration/Layers/ProjectionPipeline.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../../orchestration/Services/ProjectionPipeline.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const testLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "099-projection-threads-cursor" }),
  ),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(NodeServices.layer),
);

const makeAppendAndProject =
  (
    eventStore: OrchestrationEventStoreShape,
    projectionPipeline: OrchestrationProjectionPipelineShape,
  ) =>
  (event: Parameters<OrchestrationEventStoreShape["append"]>[0]) =>
    eventStore
      .append(event)
      .pipe(Effect.flatMap((saved) => projectionPipeline.projectEvent(saved)));

it.layer(Layer.fresh(testLayer))("099_InvalidateProjectionThreadsCursor", (it) => {
  it.effect(
    "deletes the projection.threads cursor so startup bootstrap heals regressed updatedAt",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const eventStore = yield* OrchestrationEventStore;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;

        // Run all migrations before this one, simulating an installation that
        // already has migration 98 applied and a projection.threads cursor at
        // the journal head.
        yield* runMigrations({ toMigrationInclusive: 98 });

        const threadId = ThreadId.makeUnsafe("thread-099");
        const projectId = ProjectId.makeUnsafe("project-099");
        const turnId = TurnId.makeUnsafe("turn-099");
        const messageId = MessageId.makeUnsafe("message-099");
        const createdAt = "2026-09-01T00:00:00.000Z";
        const requestedAt = "2026-09-01T00:00:01.000Z";
        const startedAt = "2026-09-01T00:00:02.000Z";
        const completedAt = "2026-09-01T00:00:03.000Z";

        const appendAndProject = makeAppendAndProject(eventStore, projectionPipeline);
        let sequence = 0;
        const nextEventId = () => EventId.makeUnsafe(`evt-099-${++sequence}`);

        yield* appendAndProject({
          type: "project.created",
          eventId: nextEventId(),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe("cmd-099-project"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-099-project"),
          metadata: {},
          payload: {
            projectId,
            title: "Project 099",
            workspaceRoot: "/tmp/project-099",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: nextEventId(),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe("cmd-099-thread"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-099-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: "Thread 099",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            workingDirectory: null,
            associatedWorktreePath: null,
            associatedWorktreeBranch: null,
            associatedWorktreeRef: null,
            createBranchFlowCompleted: false,
            isPinned: false,
            parentThreadId: null,
            creationSource: null,
            sourceThreadId: null,
            sourceTurnId: null,
            gatewayOperationId: null,
            gatewayOperationIndex: null,
            subagentAgentId: null,
            subagentNickname: null,
            subagentRole: null,
            forkSourceThreadId: null,
            sidechatSourceThreadId: null,
            sidechatLastActivityAt: null,
            sidechatExpiredAt: null,
            lastKnownPr: null,
            handoff: null,
            createdAt,
            updatedAt: createdAt,
          },
        });

        yield* appendAndProject({
          type: "thread.turn-start-requested",
          eventId: nextEventId(),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: requestedAt,
          commandId: CommandId.makeUnsafe("cmd-099-turn-start"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-099-turn-start"),
          metadata: {},
          payload: {
            threadId,
            messageId,
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            interactionMode: "default",
            dispatchMode: "queue",
            dispatchOrigin: "user",
            createdAt: requestedAt,
          },
        });

        const session = (
          status: "running" | "ready",
          activeTurnId: TurnId | null,
          updatedAt: string,
        ) => ({
          threadId,
          status,
          providerName: "codex",
          runtimeMode: "full-access" as const,
          activeTurnId,
          lastError: null,
          updatedAt,
        });

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: nextEventId(),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: CommandId.makeUnsafe("cmd-099-session-start"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-099-session-start"),
          metadata: {},
          payload: {
            threadId,
            session: session("running", turnId, startedAt),
          },
        });

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: nextEventId(),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: completedAt,
          commandId: CommandId.makeUnsafe("cmd-099-session-end"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-099-session-end"),
          metadata: {},
          payload: {
            threadId,
            session: session("ready", null, completedAt),
          },
        });

        // The current projector sets updated_at to completion; regress it to the
        // turn-start time to simulate a database upgraded from the buggy version.
        const [before] = yield* sql<{ readonly updatedAt: string }>`
          SELECT updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.equal(before!.updatedAt, completedAt);

        yield* sql`
          UPDATE projection_threads
          SET updated_at = ${requestedAt}
          WHERE thread_id = ${threadId}
        `;

        const [cursorBefore] = yield* sql<{ readonly lastAppliedSequence: number }>`
          SELECT last_applied_sequence AS "lastAppliedSequence"
          FROM projection_state
          WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        `;
        assert.strictEqual(cursorBefore!.lastAppliedSequence, 5);

        // Apply migration 99. This must delete the projection.threads cursor so
        // the next bootstrap will replay with the updated event filter.
        yield* runMigrations({ toMigrationInclusive: 99 });

        const [cursorAfter] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM projection_state
          WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        `;
        assert.strictEqual(cursorAfter!.count, 0);

        // Rerunning the migration with the cursor already absent must stay safe.
        yield* runMigrations({ toMigrationInclusive: 99 });

        const [cursorRerun] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM projection_state
          WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
        `;
        assert.strictEqual(cursorRerun!.count, 0);

        // First startup after upgrade: the bootstrap replay heals the stale row.
        yield* projectionPipeline.bootstrap;

        const [after] = yield* sql<{ readonly updatedAt: string }>`
          SELECT updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.equal(after!.updatedAt, completedAt);
      }),
  );
});
