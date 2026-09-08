import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationThread, OrchestrationThreadActivity } from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../persistence/Layers/ProjectionPendingInteractions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionPendingInteractionRepository } from "../persistence/Services/ProjectionPendingInteractions.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { reconcileRestartStuckTurns } from "./startupTurnReconciliation.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const LIFECYCLE_GENERATION = "generation-before-crash";

const structuredQuestions = [
  {
    id: "next_step",
    header: "Next",
    question: "How should the turn continue?",
    options: [{ label: "Cancel", description: "Stop the stale request." }],
  },
];

const pendingInteractionStatus = (thread: OrchestrationThread | undefined, requestId: string) =>
  thread?.pendingInteractions?.find((row) => row.requestId === requestId)?.status;

const failureActivitiesFor = (thread: OrchestrationThread | undefined, requestId: string) =>
  thread?.activities.filter(
    (activity) =>
      (activity.kind === "provider.user-input.respond.failed" ||
        activity.kind === "provider.approval.respond.failed") &&
      (activity.payload as { readonly requestId?: unknown } | null)?.requestId === requestId,
  ) ?? [];

describe("boot-time pending interaction reconciliation", () => {
  let runtime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness() {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synara-startup-pending-"));
    tempDirs.push(workspaceRoot);
    fs.mkdirSync(path.join(workspaceRoot, ".git"));

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    const managed = ManagedRuntime.make(layer);
    runtime = managed as unknown as ManagedRuntime.ManagedRuntime<never, never>;

    const engine = await managed.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await managed.runPromise(Effect.service(ProjectionSnapshotQuery));
    const pendingInteractions = await managed.runPromise(
      Effect.service(ProjectionPendingInteractionRepository),
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot,
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    // The previous process died hard: no runtime, no in-flight turn, and a
    // session projection that already looks perfectly idle.
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    const appendActivity = (input: {
      readonly id: string;
      readonly kind: string;
      readonly payload: OrchestrationThreadActivity["payload"];
    }) =>
      Effect.runPromise(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`cmd-${input.id}`),
          threadId: THREAD_ID,
          activity: {
            id: EventId.makeUnsafe(`activity-${input.id}`),
            tone: "info",
            kind: input.kind,
            summary: input.kind,
            payload: input.payload,
            turnId: null,
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      );

    const readThread = async (): Promise<OrchestrationThread | undefined> =>
      Option.getOrUndefined(await managed.runPromise(snapshotQuery.getThreadDetailById(THREAD_ID)));

    const readPendingCounts = () =>
      managed.runPromise(pendingInteractions.getPendingCountsByThreadId({ threadId: THREAD_ID }));

    // Thread detail hides `confirmed` rows, so answered interactions are read
    // straight from the settlement authority.
    const readRowStatus = async (
      requestId: string,
      interactionKind: "approval" | "userInput" = "userInput",
    ) =>
      Option.getOrUndefined(
        await managed.runPromise(
          pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId: ApprovalRequestId.makeUnsafe(requestId),
          }),
        ),
      )?.status;

    /** Drives the row to the status a failed answer against a dead runtime leaves behind. */
    const markRetryable = async (
      requestId: string,
      interactionKind: "approval" | "userInput" = "userInput",
    ) => {
      const row = Option.getOrThrow(
        await managed.runPromise(
          pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId: ApprovalRequestId.makeUnsafe(requestId),
          }),
        ),
      );
      await managed.runPromise(pendingInteractions.upsert({ ...row, status: "retryable" }));
    };

    const runBootReconciliation = () => managed.runPromise(reconcileRestartStuckTurns);

    return {
      engine,
      pendingInteractions,
      appendActivity,
      readThread,
      readPendingCounts,
      readRowStatus,
      markRetryable,
      runBootReconciliation,
      managed,
    };
  }

  it("settles interactions left unresolved by a previous process and clears their projections", async () => {
    const harness = await createHarness();

    // Two rows a hard-killed process leaves behind. Neither is visible to the
    // timeline-derived pending-request scan: the user-input request carries no
    // structured questions, and the approval already recorded a (non-stale)
    // failure from an answer attempt that hit the dead runtime.
    await harness.appendActivity({
      id: "user-input-requested-orphaned",
      kind: "user-input.requested",
      payload: {
        requestId: "req-orphaned-user-input",
        lifecycleGeneration: LIFECYCLE_GENERATION,
      },
    });
    await harness.appendActivity({
      id: "approval-requested-orphaned",
      kind: "approval.requested",
      payload: {
        requestId: "req-orphaned-approval",
        requestKind: "command",
        lifecycleGeneration: LIFECYCLE_GENERATION,
      },
    });
    await harness.appendActivity({
      id: "approval-respond-failed-orphaned",
      kind: "provider.approval.respond.failed",
      payload: {
        requestId: "req-orphaned-approval",
        detail:
          "Cannot respond to request 'req-orphaned-approval' because the provider runtime is not active",
      },
    });
    await harness.markRetryable("req-orphaned-approval", "approval");

    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 1,
      pendingUserInputCount: 1,
    });

    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    expect(pendingInteractionStatus(thread, "req-orphaned-user-input")).toBe("uncertain");
    expect(pendingInteractionStatus(thread, "req-orphaned-approval")).toBe("uncertain");
    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
    });

    const userInputFailures = failureActivitiesFor(thread, "req-orphaned-user-input");
    expect(userInputFailures).toHaveLength(1);
    expect(userInputFailures[0]?.kind).toBe("provider.user-input.respond.failed");
    expect(userInputFailures[0]?.payload).toMatchObject({
      detail: expect.stringContaining("Stale pending user-input request: req-orphaned-user-input"),
    });
    const approvalFailures = failureActivitiesFor(thread, "req-orphaned-approval").filter(
      (activity) =>
        typeof (activity.payload as { readonly detail?: unknown } | null)?.detail === "string" &&
        ((activity.payload as { readonly detail: string }).detail.startsWith("Stale pending") ??
          false),
    );
    expect(approvalFailures).toHaveLength(1);
  });

  it("emits exactly one settlement when a request is both timeline-open and durably unresolved", async () => {
    const harness = await createHarness();

    await harness.appendActivity({
      id: "user-input-requested-structured",
      kind: "user-input.requested",
      payload: {
        requestId: "req-structured",
        lifecycleGeneration: LIFECYCLE_GENERATION,
        questions: structuredQuestions,
      },
    });

    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    expect(pendingInteractionStatus(thread, "req-structured")).toBe("uncertain");
    expect(failureActivitiesFor(thread, "req-structured")).toHaveLength(1);
  });

  it("leaves resolved interactions untouched", async () => {
    const harness = await createHarness();

    await harness.appendActivity({
      id: "user-input-requested-answered",
      kind: "user-input.requested",
      payload: {
        requestId: "req-answered",
        lifecycleGeneration: LIFECYCLE_GENERATION,
        questions: structuredQuestions,
      },
    });
    await harness.appendActivity({
      id: "user-input-resolved-answered",
      kind: "user-input.resolved",
      payload: {
        requestId: "req-answered",
        lifecycleGeneration: LIFECYCLE_GENERATION,
        answers: {},
      },
    });
    expect(await harness.readRowStatus("req-answered")).toBe("confirmed");

    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    expect(await harness.readRowStatus("req-answered")).toBe("confirmed");
    expect(failureActivitiesFor(thread, "req-answered")).toHaveLength(0);
    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
    });
  });

  it("keeps interactions created after boot answerable", async () => {
    const harness = await createHarness();

    await harness.appendActivity({
      id: "user-input-requested-orphaned",
      kind: "user-input.requested",
      payload: { requestId: "req-orphaned", lifecycleGeneration: LIFECYCLE_GENERATION },
    });
    await harness.runBootReconciliation();

    // A session started in this process asks its own question afterwards.
    await harness.appendActivity({
      id: "user-input-requested-post-boot",
      kind: "user-input.requested",
      payload: {
        requestId: "req-post-boot",
        lifecycleGeneration: "generation-after-boot",
        questions: structuredQuestions,
      },
    });

    const thread = await harness.readThread();
    expect(pendingInteractionStatus(thread, "req-orphaned")).toBe("uncertain");
    expect(pendingInteractionStatus(thread, "req-post-boot")).toBe("pending");
    expect(failureActivitiesFor(thread, "req-post-boot")).toHaveLength(0);
    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 0,
      pendingUserInputCount: 1,
    });

    // Still answerable: the settlement pass did not claim or fence the new row.
    const claimed = await harness.managed.runPromise(
      harness.pendingInteractions.claimResponse({
        threadId: THREAD_ID,
        interactionKind: "userInput",
        requestId: ApprovalRequestId.makeUnsafe("req-post-boot"),
        lifecycleGeneration: "generation-after-boot",
        responseCommandId: CommandId.makeUnsafe("cmd-post-boot-response"),
        decision: null,
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(claimed).toBe(true);
  });
});
