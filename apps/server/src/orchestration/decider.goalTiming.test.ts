// FILE: decider.goalTiming.test.ts
// Purpose: Covers goal pursuit timing: the decider stamps goalStartedAt when a
//          goal first becomes active, freezes/rebases it across pause/resume,
//          and clears both timestamps when the goal is cleared.

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
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

async function decideGoalUpdate(
  readModel: OrchestrationReadModel,
  input: {
    commandId: string;
    goal?: string;
    goalPaused?: boolean;
    goalAchieved?: boolean;
  },
) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: THREAD_ID,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.goalPaused !== undefined ? { goalPaused: input.goalPaused } : {}),
        ...(input.goalAchieved !== undefined ? { goalAchieved: input.goalAchieved } : {}),
      },
      readModel,
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  expect(event?.type).toBe("thread.meta-updated");
  if (!event || event.type !== "thread.meta-updated") {
    throw new Error("Expected a thread.meta-updated event.");
  }
  return event;
}

async function applyEvent(
  readModel: OrchestrationReadModel,
  event: OrchestrationEvent,
  sequence: number,
) {
  return Effect.runPromise(projectEvent(readModel, { ...event, sequence } as OrchestrationEvent));
}

describe("decider thread goal timing", () => {
  it("stamps goalStartedAt when a goal first becomes active and keeps it on edits", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);

    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Ship the feature",
    });
    expect(setEvent.payload.goalStartedAt).toBe(setEvent.occurredAt);
    expect(setEvent.payload.goalPausedAt).toBeNull();

    readModel = await applyEvent(readModel, setEvent, 3);
    expect(readModel.threads[0]?.goalStartedAt).toBe(setEvent.occurredAt);

    const editEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-edit",
      goal: "Ship the feature and tests",
    });
    expect("goalStartedAt" in editEvent.payload).toBe(false);
    expect("goalPausedAt" in editEvent.payload).toBe(false);

    readModel = await applyEvent(readModel, editEvent, 4);
    expect(readModel.threads[0]?.goal).toBe("Ship the feature and tests");
    expect(readModel.threads[0]?.goalStartedAt).toBe(setEvent.occurredAt);
  });

  it("clears both timestamps when the goal is cleared", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, { commandId: "cmd-goal-set", goal: "Objective" }),
      3,
    );

    const clearEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-clear",
      goal: "",
    });
    expect(clearEvent.payload.goalStartedAt).toBeNull();
    expect(clearEvent.payload.goalPausedAt).toBeNull();

    readModel = await applyEvent(readModel, clearEvent, 4);
    expect(readModel.threads[0]?.goalStartedAt).toBeNull();
    expect(readModel.threads[0]?.goalPausedAt).toBeNull();
  });

  it("pauses once and rebases goalStartedAt on resume so paused time never counts", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Objective",
    });
    readModel = await applyEvent(readModel, setEvent, 3);

    const pauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-pause",
      goalPaused: true,
    });
    expect(pauseEvent.payload.goalPausedAt).toBe(pauseEvent.occurredAt);
    expect("goalStartedAt" in pauseEvent.payload).toBe(false);
    readModel = await applyEvent(readModel, pauseEvent, 4);

    const repauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-repause",
      goalPaused: true,
    });
    expect("goalPausedAt" in repauseEvent.payload).toBe(false);

    const resumeEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-resume",
      goalPaused: false,
    });
    expect(resumeEvent.payload.goalPausedAt).toBeNull();
    const rebasedStartedAt = resumeEvent.payload.goalStartedAt;
    expect(typeof rebasedStartedAt).toBe("string");
    if (typeof rebasedStartedAt !== "string") return;
    // Elapsed-at-pause must equal elapsed-at-resume: resume shifts the start
    // forward by exactly the paused span.
    const elapsedAtPause = Date.parse(pauseEvent.occurredAt) - Date.parse(setEvent.occurredAt);
    const elapsedAtResume = Date.parse(resumeEvent.occurredAt) - Date.parse(rebasedStartedAt);
    expect(elapsedAtResume).toBe(elapsedAtPause);

    readModel = await applyEvent(readModel, resumeEvent, 5);
    expect(readModel.threads[0]?.goalPausedAt).toBeNull();
    expect(readModel.threads[0]?.goalStartedAt).toBe(rebasedStartedAt);
  });

  it("ignores pause intents when the thread has no active goal", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const event = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-pause-empty",
      goalPaused: true,
    });
    expect("goalPausedAt" in event.payload).toBe(false);
    expect("goalStartedAt" in event.payload).toBe(false);
  });

  it("resumes with a valid clock even when a legacy goal has no recorded start", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    // Legacy shape: goal set before timing existed — paused but with no start stamp.
    readModel = await applyEvent(
      readModel,
      {
        eventId: EventId.makeUnsafe("evt-legacy-goal"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-legacy-goal"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-legacy-goal"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          goal: "Legacy objective",
          goalPausedAt: now,
          updatedAt: now,
        },
        sequence: 3,
      } as OrchestrationEvent,
      3,
    );

    const resumeEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-legacy-resume",
      goalPaused: false,
    });
    expect(resumeEvent.payload.goalPausedAt).toBeNull();
    expect(resumeEvent.payload.goalStartedAt).toBe(resumeEvent.occurredAt);
  });

  it("records an achievement with the running elapsed time and clears the goal", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Ship the feature",
    });
    readModel = await applyEvent(readModel, setEvent, 3);

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve",
      goalAchieved: true,
    });
    expect(achieveEvent.payload.goal).toBe("");
    expect(achieveEvent.payload.goalStartedAt).toBeNull();
    expect(achieveEvent.payload.goalPausedAt).toBeNull();
    const achievements = achieveEvent.payload.goalAchievements;
    expect(achievements).toHaveLength(1);
    expect(achievements?.[0]).toEqual({
      goal: "Ship the feature",
      achievedAt: achieveEvent.occurredAt,
      elapsedMs: Date.parse(achieveEvent.occurredAt) - Date.parse(setEvent.occurredAt),
      turnId: null,
    });

    readModel = await applyEvent(readModel, achieveEvent, 4);
    expect(readModel.threads[0]?.goal).toBe("");
    expect(readModel.threads[0]?.goalAchievements).toHaveLength(1);
  });

  it("freezes the achievement's elapsed time at the pause stamp for paused goals", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Objective",
    });
    readModel = await applyEvent(readModel, setEvent, 3);
    const pauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-pause",
      goalPaused: true,
    });
    readModel = await applyEvent(readModel, pauseEvent, 4);

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve",
      goalAchieved: true,
    });
    expect(achieveEvent.payload.goalAchievements?.[0]?.elapsedMs).toBe(
      Date.parse(pauseEvent.occurredAt) - Date.parse(setEvent.occurredAt),
    );
  });

  it("records a null elapsed time for legacy goals without a start stamp", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    readModel = await applyEvent(
      readModel,
      {
        eventId: EventId.makeUnsafe("evt-legacy-goal"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-legacy-goal"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-legacy-goal"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          goal: "Legacy objective",
          updatedAt: now,
        },
        sequence: 3,
      } as OrchestrationEvent,
      3,
    );

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-legacy-achieve",
      goalAchieved: true,
    });
    expect(achieveEvent.payload.goalAchievements?.[0]?.elapsedMs).toBeNull();
    expect(achieveEvent.payload.goalAchievements?.[0]?.goal).toBe("Legacy objective");
  });

  it("ignores achieved intents when the thread has no active goal", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const event = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve-empty",
      goalAchieved: true,
    });
    expect("goal" in event.payload).toBe(false);
    expect("goalAchievements" in event.payload).toBe(false);
  });

  it("caps the achievement history at the newest 20 entries", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const priorAchievements = Array.from({ length: 20 }, (_, index) => ({
      goal: `Objective ${index}`,
      achievedAt: now,
      elapsedMs: null,
      turnId: null,
    }));
    readModel = await applyEvent(
      readModel,
      {
        eventId: EventId.makeUnsafe("evt-goal-history"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-goal-history"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-goal-history"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          goal: "Objective 20",
          goalStartedAt: now,
          goalAchievements: priorAchievements,
          updatedAt: now,
        },
        sequence: 3,
      } as OrchestrationEvent,
      3,
    );

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve-cap",
      goalAchieved: true,
    });
    const achievements = achieveEvent.payload.goalAchievements;
    expect(achievements).toHaveLength(20);
    expect(achievements?.[0]?.goal).toBe("Objective 1");
    expect(achievements?.[19]?.goal).toBe("Objective 20");
  });

  it("pauses an active goal atomically before interrupting its turn", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set-before-interrupt",
      goal: "Finish the implementation",
    });
    readModel = await applyEvent(readModel, setEvent, 3);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-interrupt-active-goal"),
          threadId: THREAD_ID,
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.turn-interrupt-requested",
    ]);
    const pauseEvent = result[0];
    expect(pauseEvent?.type).toBe("thread.meta-updated");
    if (pauseEvent?.type !== "thread.meta-updated") return;
    expect(pauseEvent.payload.goalPausedAt).toBe(pauseEvent.occurredAt);
  });
});
