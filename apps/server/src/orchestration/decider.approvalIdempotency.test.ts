import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import type { OrchestrationReadModel } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

const PROJECT_ID = ProjectId.makeUnsafe("project-approvals");
const THREAD_ID = ThreadId.makeUnsafe("thread-approvals");
const REQUEST_ID = ApprovalRequestId.makeUnsafe("req-1");

async function createThreadReadModel(now: string): Promise<OrchestrationReadModel> {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Approval thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function appendApprovalResponse(
  readModel: OrchestrationReadModel,
  input: {
    readonly sequence: number;
    readonly requestId: ApprovalRequestId;
    readonly occurredAt: string;
  },
): Promise<OrchestrationReadModel> {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            pendingInteractions: [
              {
                interactionKind: "approval",
                requestId: input.requestId,
                threadId: THREAD_ID,
                turnId: null,
                lifecycleGeneration: null,
                status: "responding",
                decision: "accept",
                responseCommandId: CommandId.makeUnsafe(`cmd-approval-response-${input.sequence}`),
                responseRequestedAt: input.occurredAt,
                createdAt: input.occurredAt,
                resolvedAt: null,
              },
            ],
          }
        : thread,
    ),
  };
}

async function appendApprovalRespondFailure(
  readModel: OrchestrationReadModel,
  input: {
    readonly sequence: number;
    readonly requestId: ApprovalRequestId;
    readonly occurredAt: string;
    readonly settlementStatus: "retryable" | "uncertain";
  },
): Promise<OrchestrationReadModel> {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            pendingInteractions: thread.pendingInteractions?.map((interaction) =>
              interaction.requestId === input.requestId
                ? { ...interaction, status: input.settlementStatus }
                : interaction,
            ),
          }
        : thread,
    ),
  };
}

describe("decider approval idempotency", () => {
  it("emits thread.approval-response-requested for a first response", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          decision: "accept",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.approval-response-requested");
  });

  it("rejects a duplicate response for an already answered request", async () => {
    const now = new Date().toISOString();
    const withThread = await createThreadReadModel(now);
    const readModel = await appendApprovalResponse(withThread, {
      sequence: 3,
      requestId: REQUEST_ID,
      occurredAt: now,
    });

    const failure = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond-duplicate"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          decision: "decline",
          createdAt: now,
        },
        readModel,
      }).pipe(Effect.flip),
    );

    expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    expect(failure.detail).toContain("req-1");
  });

  it("still accepts responses for other approval requests on the same thread", async () => {
    const now = new Date().toISOString();
    const withThread = await createThreadReadModel(now);
    const readModel = await appendApprovalResponse(withThread, {
      sequence: 3,
      requestId: REQUEST_ID,
      occurredAt: now,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond-other"),
          threadId: THREAD_ID,
          requestId: ApprovalRequestId.makeUnsafe("req-2"),
          decision: "accept",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.approval-response-requested");
  });

  it("accepts a retry after a retryable provider delivery failure", async () => {
    const now = new Date().toISOString();
    const withThread = await createThreadReadModel(now);
    const withResponse = await appendApprovalResponse(withThread, {
      sequence: 3,
      requestId: REQUEST_ID,
      occurredAt: now,
    });
    const readModel = await appendApprovalRespondFailure(withResponse, {
      sequence: 4,
      requestId: REQUEST_ID,
      occurredAt: now,
      settlementStatus: "retryable",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond-retry"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          decision: "accept",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.approval-response-requested");
  });

  it("keeps rejecting retries after an uncertain provider delivery failure", async () => {
    const now = new Date().toISOString();
    const withThread = await createThreadReadModel(now);
    const withResponse = await appendApprovalResponse(withThread, {
      sequence: 3,
      requestId: REQUEST_ID,
      occurredAt: now,
    });
    const readModel = await appendApprovalRespondFailure(withResponse, {
      sequence: 4,
      requestId: REQUEST_ID,
      occurredAt: now,
      settlementStatus: "uncertain",
    });

    const failure = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond-after-uncertain"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          decision: "accept",
          createdAt: now,
        },
        readModel,
      }).pipe(Effect.flip),
    );

    expect(failure._tag).toBe("OrchestrationCommandInvariantError");
  });

  it("accepts the same request id for a new lifecycle generation", async () => {
    const now = new Date().toISOString();
    const withThread = await createThreadReadModel(now);
    const withResponse = await appendApprovalResponse(withThread, {
      sequence: 3,
      requestId: REQUEST_ID,
      occurredAt: now,
    });
    const readModel = {
      ...withResponse,
      threads: withResponse.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              pendingInteractions: thread.pendingInteractions?.map((interaction) => ({
                ...interaction,
                lifecycleGeneration: "generation-1",
              })),
            }
          : thread,
      ),
    };

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-approval-respond-new-generation"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          lifecycleGeneration: "generation-2",
          decision: "accept",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.approval-response-requested");
  });
});
