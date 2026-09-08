// FILE: decider.computerControl.test.ts
// Purpose: Covers the computer-control opt-in surviving the decider: the flag rides
//          turn-start, queued-dispatch, and edit-resend payloads when the command sets
//          it, and stays absent from those payloads when the command omits it.

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-computer-control");
const PROJECT_ID = ProjectId.makeUnsafe("project-computer-control");
const MESSAGE_ID = MessageId.makeUnsafe("message-computer-control");
const TURN_ID = TurnId.makeUnsafe("turn-computer-control");

function tailUserMessage(): OrchestrationMessage {
  return {
    id: MESSAGE_ID,
    role: "user",
    text: "launch the calculator",
    turnId: TURN_ID,
    streaming: false,
    source: "native",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeReadModel(
  input: {
    readonly session?: OrchestrationSession | null;
    readonly messages?: ReadonlyArray<OrchestrationMessage>;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Computer control",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        parentThreadId: null,
        messages: input.messages ?? [],
        session: input.session ?? null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function runningSession(): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    status: "running",
    activeTurnId: TURN_ID,
    lastError: null,
    updatedAt: NOW,
  };
}

type DecidedEvent = { readonly type: string; readonly payload: Record<string, unknown> };

async function decide(
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  readModel: OrchestrationReadModel,
): Promise<ReadonlyArray<DecidedEvent>> {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const events: ReadonlyArray<unknown> = Array.isArray(decided) ? decided : [decided];
  return events as ReadonlyArray<DecidedEvent>;
}

function payloadOf(events: ReadonlyArray<DecidedEvent>, type: string): Record<string, unknown> {
  const event = events.find((candidate) => candidate.type === type);
  expect(event, `expected a ${type} event`).toBeDefined();
  return event!.payload;
}

function turnStartCommand(enableComputerControl?: boolean) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.makeUnsafe("cmd-turn-start-computer-control"),
    threadId: THREAD_ID,
    message: {
      messageId: MESSAGE_ID,
      role: "user" as const,
      text: "launch the calculator",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access" as const,
    createdAt: NOW,
    ...(enableComputerControl !== undefined ? { enableComputerControl } : {}),
  };
}

function dispatchQueuedCommand(enableComputerControl?: boolean) {
  return {
    type: "thread.turn.dispatch-queued" as const,
    commandId: CommandId.makeUnsafe("cmd-dispatch-queued-computer-control"),
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access" as const,
    createdAt: NOW,
    ...(enableComputerControl !== undefined ? { enableComputerControl } : {}),
  };
}

function editAndResendCommand(enableComputerControl?: boolean) {
  return {
    type: "thread.message.edit-and-resend" as const,
    commandId: CommandId.makeUnsafe("cmd-edit-resend-computer-control"),
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    text: "launch the calculator instead",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access" as const,
    createdAt: NOW,
    ...(enableComputerControl !== undefined ? { enableComputerControl } : {}),
  };
}

describe("decider computer-control pass-through", () => {
  it("carries the flag onto a turn-start request", async () => {
    const events = await decide(turnStartCommand(true), makeReadModel());
    expect(payloadOf(events, "thread.turn-start-requested").enableComputerControl).toBe(true);
  });

  it("carries the flag onto a queued turn", async () => {
    const events = await decide(
      { ...turnStartCommand(true), dispatchMode: "queue" as const },
      makeReadModel({ session: runningSession() }),
    );
    expect(payloadOf(events, "thread.turn-queued").enableComputerControl).toBe(true);
  });

  it("carries an explicit false onto a turn-start request", async () => {
    const events = await decide(turnStartCommand(false), makeReadModel());
    expect(payloadOf(events, "thread.turn-start-requested").enableComputerControl).toBe(false);
  });

  it("omits the flag from a turn-start request when the command omits it", async () => {
    const events = await decide(turnStartCommand(), makeReadModel());
    expect(payloadOf(events, "thread.turn-start-requested")).not.toHaveProperty(
      "enableComputerControl",
    );
  });

  it("carries the flag when a queued turn is dispatched", async () => {
    const events = await decide(dispatchQueuedCommand(true), makeReadModel());
    expect(payloadOf(events, "thread.turn-start-requested").enableComputerControl).toBe(true);
  });

  it("omits the flag when a queued dispatch omits it", async () => {
    const events = await decide(dispatchQueuedCommand(), makeReadModel());
    expect(payloadOf(events, "thread.turn-start-requested")).not.toHaveProperty(
      "enableComputerControl",
    );
  });

  it("carries the flag onto an edit-and-resend request", async () => {
    const events = await decide(
      editAndResendCommand(true),
      makeReadModel({ messages: [tailUserMessage()] }),
    );
    expect(payloadOf(events, "thread.message-edit-resend-requested").enableComputerControl).toBe(
      true,
    );
  });

  it("omits the flag when an edit-and-resend omits it", async () => {
    const events = await decide(
      editAndResendCommand(),
      makeReadModel({ messages: [tailUserMessage()] }),
    );
    expect(payloadOf(events, "thread.message-edit-resend-requested")).not.toHaveProperty(
      "enableComputerControl",
    );
  });
});
