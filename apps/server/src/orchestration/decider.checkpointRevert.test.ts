import {
  DEFAULT_PROVIDER_PROFILE_ID,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-checkpoint-revert");

const ACTIVE_TURN_ERROR =
  "Thread 'thread-checkpoint-revert' has an active turn. Interrupt the current turn before reverting checkpoints.";
const REVERT_IN_PROGRESS_ERROR =
  "Thread 'thread-checkpoint-revert' has a checkpoint revert in progress. Wait for it to finish before starting a turn.";

function makeReadModel(input: {
  readonly session?: OrchestrationSession | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-checkpoint-revert"),
        title: "Checkpoint revert",
        modelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: input.latestTurn ?? null,
        handoff: null,
        messages: [],
        session: input.session === undefined ? null : input.session,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function checkpointRevertCommand() {
  return {
    type: "thread.checkpoint.revert" as const,
    commandId: CommandId.makeUnsafe("cmd-checkpoint-revert"),
    threadId: THREAD_ID,
    turnCount: 1,
    scope: "thread" as const,
    createdAt: NOW,
  };
}

function makeSession(
  overrides: Partial<OrchestrationSession> & Pick<OrchestrationSession, "status">,
): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeLatestTurn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.makeUnsafe("turn-latest"),
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : NOW,
    assistantMessageId: null,
  };
}

describe("checkpoint revert decider", () => {
  it("rejects revert once a turn start request is committed, before provider activation", async () => {
    let readModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    });
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-before-revert"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-before-revert"),
            role: "user",
            text: "start work",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: NOW,
        },
        readModel,
      }),
    );

    const events = Array.isArray(decided) ? decided : [decided];
    for (const [index, event] of events.entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, {
          ...event,
          sequence: index + 2,
        }),
      );
    }
    expect(readModel.threads[0]?.session).toMatchObject({
      status: "starting",
      activeTurnId: null,
    });

    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: checkpointRevertCommand(),
          readModel,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.checkpoint.revert",
      detail: ACTIVE_TURN_ERROR,
    });
  });

  it("rejects a new turn after checkpoint revert admission", async () => {
    const initialReadModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    });
    const decidedRevert = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: initialReadModel,
      }),
    );
    const revertEvents = Array.isArray(decidedRevert) ? decidedRevert : [decidedRevert];
    const startedEvent = revertEvents.find((event) => event.type === "thread.activity-appended");
    expect(startedEvent).toBeDefined();
    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...startedEvent!, sequence: 2 }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-during-revert"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.makeUnsafe("message-during-revert"),
              role: "user",
              text: "race the revert",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      detail: REVERT_IN_PROGRESS_ERROR,
    });
  });

  it("keeps a newly admitted revert authoritative over older sequenced lifecycle rows", async () => {
    const baseReadModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    });
    const initialReadModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) => ({
        ...thread,
        activities: [
          {
            id: EventId.makeUnsafe("old-revert-succeeded"),
            tone: "info",
            kind: "checkpoint.revert.succeeded",
            summary: "Old revert completed",
            payload: { turnCount: 0 },
            turnId: null,
            sequence: 5,
            createdAt: "2026-07-18T00:00:00.000Z",
          },
        ],
      })),
    };
    const decidedRevert = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: initialReadModel,
      }),
    );
    const startedEvent = (Array.isArray(decidedRevert) ? decidedRevert : [decidedRevert]).find(
      (event) => event.type === "thread.activity-appended",
    )!;
    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...startedEvent, sequence: 10 }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-after-newer-revert"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.makeUnsafe("message-after-newer-revert"),
              role: "user",
              text: "must remain blocked",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      detail: REVERT_IN_PROGRESS_ERROR,
    });
  });

  it("rejects edit-and-resend after checkpoint revert admission", async () => {
    const initialReadModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    });
    const decidedRevert = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: initialReadModel,
      }),
    );
    const startedEvent = (Array.isArray(decidedRevert) ? decidedRevert : [decidedRevert]).find(
      (event) => event.type === "thread.activity-appended",
    )!;
    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...startedEvent, sequence: 2 }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.message.edit-and-resend",
            commandId: CommandId.makeUnsafe("cmd-edit-during-revert"),
            threadId: THREAD_ID,
            messageId: MessageId.makeUnsafe("message-during-revert"),
            text: "edited",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.message.edit-and-resend",
      detail: REVERT_IN_PROGRESS_ERROR,
    });
  });

  it("rejects conversation rollback after checkpoint revert admission", async () => {
    const initialReadModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    });
    const decidedRevert = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: initialReadModel,
      }),
    );
    const startedEvent = (Array.isArray(decidedRevert) ? decidedRevert : [decidedRevert]).find(
      (event) => event.type === "thread.activity-appended",
    )!;
    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, { ...startedEvent, sequence: 2 }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.conversation.rollback",
            commandId: CommandId.makeUnsafe("cmd-rollback-during-revert"),
            threadId: THREAD_ID,
            messageId: MessageId.makeUnsafe("message-during-revert"),
            numTurns: 1,
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.conversation.rollback",
      detail: REVERT_IN_PROGRESS_ERROR,
    });
  });

  it("marks an admitted idle edit-and-resend as starting before its reactor runs", async () => {
    const initialReadModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: null,
    });
    const seededTurn = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-seed-edit-message"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-to-edit"),
            role: "user",
            text: "original",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: NOW,
        },
        readModel: initialReadModel,
      }),
    );
    const messageEvent = (Array.isArray(seededTurn) ? seededTurn : [seededTurn]).find(
      (event) => event.type === "thread.message-sent",
    )!;
    const turnBoundMessageEvent = messageEvent as Extract<
      OrchestrationEvent,
      { type: "thread.message-sent" }
    >;
    let readModel = await Effect.runPromise(
      projectEvent(initialReadModel, {
        ...turnBoundMessageEvent,
        sequence: 2,
        payload: {
          ...turnBoundMessageEvent.payload,
          turnId: TurnId.makeUnsafe("turn-to-edit"),
        },
      }),
    );
    const decidedEdit = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.message.edit-and-resend",
          commandId: CommandId.makeUnsafe("cmd-admit-idle-edit"),
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("message-to-edit"),
          text: "edited",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: NOW,
        },
        readModel,
      }),
    );
    const editEvents = Array.isArray(decidedEdit) ? decidedEdit : [decidedEdit];
    expect(editEvents.map((event) => event.type)).toEqual([
      "thread.session-set",
      "thread.message-edit-resend-requested",
    ]);
    for (const [index, event] of editEvents.entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: index + 3 }),
      );
    }

    const error = await Effect.runPromise(
      Effect.flip(decideOrchestrationCommand({ command: checkpointRevertCommand(), readModel })),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.checkpoint.revert",
      detail: ACTIVE_TURN_ERROR,
    });
  });

  it("rejects thread deletion until checkpoint revert settlement is committed", async () => {
    const initialReadModel = makeReadModel({
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    });
    const decidedRevert = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: initialReadModel,
      }),
    );
    const revertEvents = Array.isArray(decidedRevert) ? decidedRevert : [decidedRevert];
    const readModel = await Effect.runPromise(
      projectEvent(initialReadModel, {
        ...revertEvents.find((event) => event.type === "thread.activity-appended")!,
        sequence: 2,
      }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: CommandId.makeUnsafe("cmd-delete-during-revert"),
            threadId: THREAD_ID,
          },
          readModel,
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.delete",
      detail: `Thread '${THREAD_ID}' has a checkpoint revert in progress. Wait for it to finish before deleting the thread.`,
    });
  });

  it.each([
    {
      name: "starting",
      session: makeSession({ status: "starting" }),
      latestTurn: null,
    },
    {
      name: "running",
      session: makeSession({
        status: "running",
        activeTurnId: TurnId.makeUnsafe("turn-active"),
      }),
      latestTurn: null,
    },
    {
      name: "interrupted with an active turn",
      session: makeSession({
        status: "interrupted",
        activeTurnId: TurnId.makeUnsafe("turn-interrupting"),
      }),
      latestTurn: null,
    },
    {
      name: "ready with a still-running latest turn",
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("running"),
    },
  ])("rejects revert while the provider session is $name", async ({ session, latestTurn }) => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: checkpointRevertCommand(),
          readModel: makeReadModel({ session, latestTurn }),
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.checkpoint.revert",
      detail: ACTIVE_TURN_ERROR,
    });
  });

  it.each([
    {
      name: "ready and idle",
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    },
    {
      name: "interrupted with no active turn",
      session: makeSession({ status: "interrupted" }),
      latestTurn: makeLatestTurn("interrupted"),
    },
    {
      name: "errored with a stale active turn id",
      session: makeSession({
        status: "error",
        activeTurnId: TurnId.makeUnsafe("turn-failed"),
        lastError: "runtime exploded",
      }),
      latestTurn: makeLatestTurn("error"),
    },
    {
      name: "no session",
      session: null,
      latestTurn: null,
    },
  ])("emits the revert request when the thread is $name", async ({ session, latestTurn }) => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: makeReadModel({ session, latestTurn }),
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[0]).toMatchObject({
      type: "thread.activity-appended",
      payload: {
        threadId: THREAD_ID,
        activity: { kind: "checkpoint.revert.started" },
      },
    });
    const event = events.find((entry) => entry.type === "thread.checkpoint-revert-requested");
    expect(event).toMatchObject({
      type: "thread.checkpoint-revert-requested",
      payload: {
        threadId: THREAD_ID,
        turnCount: 1,
        scope: "thread",
      },
    });
  });
});
