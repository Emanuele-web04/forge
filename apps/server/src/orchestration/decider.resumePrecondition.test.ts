import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const RECORDED_AT = "2026-07-18T23:00:00.000Z";
const BEFORE_RECORD = "2026-07-18T22:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-resume");
const RECORDED_TURN_ID = TurnId.makeUnsafe("turn-recorded");

function makeReadModel(input: {
  readonly session?: OrchestrationSession | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly archivedAt?: string;
  readonly runtimeMode?: OrchestrationReadModel["threads"][number]["runtimeMode"];
  readonly interactionMode?: OrchestrationReadModel["threads"][number]["interactionMode"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-resume"),
        title: "Resume",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: input.runtimeMode ?? "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: input.latestTurn ?? null,
        handoff: null,
        messages: [],
        session: input.session ?? null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
      },
    ],
  };
}

function makeLatestTurn(
  state: OrchestrationLatestTurn["state"],
  id: TurnId = RECORDED_TURN_ID,
  completedAt: string = NOW,
): OrchestrationLatestTurn {
  return {
    turnId: id,
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : completedAt,
    assistantMessageId: null,
  };
}

function resumeTurnStart(recordedTurnId: TurnId | null = RECORDED_TURN_ID): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("cmd-resume"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.makeUnsafe("message-resume"),
      role: "user",
      text: "Continue where you left off.",
      attachments: [],
    },
    dispatchMode: "queue",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    resumePrecondition: { recordedTurnId, recordedAt: RECORDED_AT },
    createdAt: NOW,
  };
}

const decide = (readModel: OrchestrationReadModel, recordedTurnId?: TurnId | null) =>
  decideOrchestrationCommand({ command: resumeTurnStart(recordedTurnId), readModel });

const expectAccepted = async (
  readModel: OrchestrationReadModel,
  recordedTurnId?: TurnId | null,
) => {
  const decided = await Effect.runPromise(decide(readModel, recordedTurnId));
  const events = Array.isArray(decided) ? decided : [decided];
  expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
};

const expectRejected = async (
  readModel: OrchestrationReadModel,
  detail: string,
  recordedTurnId?: TurnId | null,
) => {
  const error = await Effect.runPromise(Effect.flip(decide(readModel, recordedTurnId)));
  expect(error).toMatchObject({
    _tag: "OrchestrationCommandInvariantError",
    commandType: "thread.turn.start",
    detail,
  });
};

describe("decider thread.turn.start resumePrecondition", () => {
  it("accepts the continuation while the recorded turn ended by interruption", async () => {
    await expectAccepted(makeReadModel({ latestTurn: makeLatestTurn("interrupted") }));
  });

  it("accepts a chat that was still connecting when recorded", async () => {
    await expectAccepted(makeReadModel({ latestTurn: null }), null);
    await expectAccepted(
      makeReadModel({
        latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-older"), BEFORE_RECORD),
      }),
      null,
    );
  });

  it("rejects when a newer turn completed on its own since the record", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-newer")) }),
      "Thread 'thread-resume' finished on its own; there is nothing to resume.",
    );
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-newer")) }),
      "Thread 'thread-resume' finished on its own; there is nothing to resume.",
      null,
    );
  });

  it("rejects when the recorded turn completed on its own", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("completed") }),
      "Thread 'thread-resume' finished on its own; there is nothing to resume.",
    );
  });

  it("rejects when a turn is in flight", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("running") }),
      "Thread 'thread-resume' already has a turn in flight.",
    );
  });

  it("rejects when the thread was archived", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("interrupted"), archivedAt: NOW }),
      "Thread 'thread-resume' was archived after it was remembered for resume.",
    );
  });

  it("uses permission and interaction modes changed before the serialized resume dispatch", async () => {
    const decided = await Effect.runPromise(
      decide(
        makeReadModel({
          latestTurn: makeLatestTurn("interrupted"),
          runtimeMode: "approval-required",
          interactionMode: "plan",
        }),
      ),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const requested = events.find((event) => event.type === "thread.turn-start-requested");

    expect(requested).toMatchObject({
      type: "thread.turn-start-requested",
      payload: {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });
  });
});
