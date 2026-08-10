import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_PROVIDER_PROFILE_ID,
  MessageId,
  ProjectId,
  ProviderProfileId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-10T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-provider-target");

function makeReadModel(input?: {
  readonly modelSelection?: ModelSelection;
  readonly established?: boolean;
  readonly hasMessage?: boolean;
  readonly hasSession?: boolean;
  readonly creationSource?: "provider_native";
}): OrchestrationReadModel {
  const established = input?.established ?? false;
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-provider-target"),
        title: "Provider target",
        modelSelection: input?.modelSelection ?? {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5.6-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: established
          ? {
              turnId: TurnId.makeUnsafe("turn-provider-target"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            }
          : null,
        ...(input?.creationSource !== undefined
          ? { creationSource: input.creationSource }
          : {}),
        handoff: null,
        messages: input?.hasMessage
          ? [
              {
                id: MessageId.makeUnsafe("message-provider-target"),
                role: "user",
                text: "Existing work",
                turnId: null,
                streaming: false,
                source: "native",
                createdAt: NOW,
                updatedAt: NOW,
              },
            ]
          : [],
        session: input?.hasSession
          ? {
              threadId: THREAD_ID,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            }
          : null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function updateModelSelection(modelSelection: ModelSelection) {
  return decideOrchestrationCommand({
    command: {
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe("cmd-update-provider-target"),
      threadId: THREAD_ID,
      modelSelection,
    },
    readModel: makeReadModel(),
  });
}

describe("thread provider target invariants", () => {
  it("allows an empty thread to adopt its first provider profile", async () => {
    const result = await Effect.runPromise(
      updateModelSelection({
        provider: "codex",
        profileId: ProviderProfileId.makeUnsafe("work"),
        model: "gpt-5.6-codex",
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (event?.type !== "thread.meta-updated") return;
    expect(event.payload.modelSelection).toMatchObject({
      provider: "codex",
      profileId: "work",
    });
  });

  it("rejects changing provider profiles after the first turn", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-replace-provider-target"),
            threadId: THREAD_ID,
            modelSelection: {
              provider: "codex",
              profileId: ProviderProfileId.makeUnsafe("work"),
              model: "gpt-5.6-codex",
            },
          },
          readModel: makeReadModel({ established: true }),
        }),
      ),
    ).rejects.toThrow(
      "Create a new thread or explicit handoff to use 'codex/work'.",
    );
  });

  it("rejects target changes once a message has been recorded", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-replace-message-target"),
            threadId: THREAD_ID,
            modelSelection: {
              provider: "codex",
              profileId: ProviderProfileId.makeUnsafe("work"),
              model: "gpt-5.6-codex",
            },
          },
          readModel: makeReadModel({ hasMessage: true }),
        }),
      ),
    ).rejects.toThrow("already has work on provider target 'codex/default'");
  });

  it("rejects target changes once a provider session has been recorded", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-replace-session-target"),
            threadId: THREAD_ID,
            modelSelection: {
              provider: "codex",
              profileId: ProviderProfileId.makeUnsafe("work"),
              model: "gpt-5.6-codex",
            },
          },
          readModel: makeReadModel({ hasSession: true }),
        }),
      ),
    ).rejects.toThrow("already has work on provider target 'codex/default'");
  });

  it("allows the first turn on an empty thread to adopt its provider profile", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-first-turn-provider-target"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-first-turn-provider-target"),
            role: "user",
            text: "First work",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            profileId: ProviderProfileId.makeUnsafe("work"),
            model: "gpt-5.6-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });

  it("rejects a turn through another provider profile before recording its message", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-retarget-turn-start"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.makeUnsafe("message-retarget-turn-start"),
              role: "user",
              text: "Wrong account",
              attachments: [],
            },
            modelSelection: {
              provider: "codex",
              profileId: ProviderProfileId.makeUnsafe("work"),
              model: "gpt-5.6-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel: makeReadModel({ hasMessage: true }),
        }),
      ),
    ).rejects.toThrow("already has work on provider target 'codex/default'");
  });

  it("rejects retargeting an empty provider-native thread", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-replace-provider-native-target"),
            threadId: THREAD_ID,
            modelSelection: {
              provider: "codex",
              profileId: ProviderProfileId.makeUnsafe("work"),
              model: "gpt-5.6-codex",
            },
          },
          readModel: makeReadModel({ creationSource: "provider_native" }),
        }),
      ),
    ).rejects.toThrow("already has work on provider target 'codex/default'");
  });

  it("rejects edit-and-resend through another provider profile before rollback", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.message.edit-and-resend",
            commandId: CommandId.makeUnsafe("cmd-retarget-edit-resend"),
            threadId: THREAD_ID,
            messageId: MessageId.makeUnsafe("message-provider-target"),
            text: "Edited work",
            modelSelection: {
              provider: "codex",
              profileId: ProviderProfileId.makeUnsafe("work"),
              model: "gpt-5.6-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel: makeReadModel({ hasMessage: true }),
        }),
      ),
    ).rejects.toThrow("already has work on provider target 'codex/default'");
  });

  it("allows model edits that keep an established provider target", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-update-model"),
          threadId: THREAD_ID,
          modelSelection: {
            provider: "codex",
            profileId: DEFAULT_PROVIDER_PROFILE_ID,
            model: "gpt-5.5-codex",
          },
        },
        readModel: makeReadModel({ established: true }),
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (event?.type !== "thread.meta-updated") return;
    expect(event.payload.modelSelection).toMatchObject({
      provider: "codex",
      profileId: "default",
      model: "gpt-5.5-codex",
    });
  });
});
