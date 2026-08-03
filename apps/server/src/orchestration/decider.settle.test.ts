// FILE: decider.settle.test.ts
// Purpose: Covers the thread settle/unsettle toggle: the decider stamps
//          settledAt from the isSettled intent and the projector applies it.

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

async function createThreadReadModel(now: string) {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-create"),
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
      eventId: EventId.makeUnsafe("evt-thread-create"),
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
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
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

async function decideSettle(
  readModel: Awaited<ReturnType<typeof createThreadReadModel>>,
  input: {
    commandId: string;
    isSettled: boolean;
  },
) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: THREAD_ID,
        isSettled: input.isSettled,
      },
      readModel,
    }),
  );
  return Array.isArray(result) ? result[0] : result;
}

describe("decider thread settle toggle", () => {
  it("stamps settledAt from the isSettled intent and clears it on unsettle", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const settleEvent = await decideSettle(readModel, {
      commandId: "cmd-settle",
      isSettled: true,
    });
    expect(settleEvent?.type).toBe("thread.meta-updated");
    if (!settleEvent || settleEvent.type !== "thread.meta-updated") return;
    expect(typeof settleEvent.payload.settledAt).toBe("string");
    expect(settleEvent.payload.settledAt).toBe(settleEvent.occurredAt);

    const settledReadModel = await Effect.runPromise(
      projectEvent(readModel, {
        ...settleEvent,
        sequence: 3,
      } as OrchestrationEvent),
    );
    expect(settledReadModel.threads[0]?.settledAt).toBe(settleEvent.occurredAt);

    const unsettleEvent = await decideSettle(settledReadModel, {
      commandId: "cmd-unsettle",
      isSettled: false,
    });
    expect(unsettleEvent?.type).toBe("thread.meta-updated");
    if (!unsettleEvent || unsettleEvent.type !== "thread.meta-updated") return;
    expect(unsettleEvent.payload.settledAt).toBeNull();

    const unsettledReadModel = await Effect.runPromise(
      projectEvent(settledReadModel, {
        ...unsettleEvent,
        sequence: 4,
      } as OrchestrationEvent),
    );
    expect(unsettledReadModel.threads[0]?.settledAt).toBeNull();
  });

  it("leaves settledAt untouched when the command omits isSettled", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-rename"),
          threadId: THREAD_ID,
          title: "Renamed thread",
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (!event || event.type !== "thread.meta-updated") return;
    expect("settledAt" in event.payload).toBe(false);
  });
});
