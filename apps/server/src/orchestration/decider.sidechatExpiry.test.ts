import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const SOURCE_THREAD_ID = ThreadId.makeUnsafe("thread-source");
const SIDECHAT_THREAD_ID = ThreadId.makeUnsafe("thread-sidechat");
const LAST_ACTIVITY_AT = "2026-08-30T10:00:00.000Z";
const EXPIRED_AT = "2026-08-30T11:00:00.000Z";

function makeReadModel(input: {
  expiredAt?: string | null;
  running?: boolean;
}): OrchestrationReadModel {
  const running = input.running ?? false;
  return {
    snapshotSequence: 1,
    updatedAt: LAST_ACTIVITY_AT,
    spaces: [],
    projects: [],
    threads: [
      {
        id: SIDECHAT_THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-sidechat"),
        title: "Side investigation",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        sidechatSourceThreadId: SOURCE_THREAD_ID,
        sidechatLastActivityAt: LAST_ACTIVITY_AT,
        sidechatExpiredAt: input.expiredAt ?? null,
        createdAt: LAST_ACTIVITY_AT,
        updatedAt: LAST_ACTIVITY_AT,
        latestTurn: running
          ? {
              turnId: TurnId.makeUnsafe("turn-running"),
              state: "running",
              requestedAt: LAST_ACTIVITY_AT,
              startedAt: LAST_ACTIVITY_AT,
              completedAt: null,
              assistantMessageId: null,
            }
          : null,
        handoff: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

describe("side chat expiry decider", () => {
  it("emits an expiry event when activity is unchanged and no turn is running", async () => {
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: makeReadModel({}),
        command: {
          type: "thread.sidechat.expire",
          commandId: CommandId.makeUnsafe("cmd-expire-sidechat"),
          threadId: SIDECHAT_THREAD_ID,
          expectedLastActivityAt: LAST_ACTIVITY_AT,
          expiredAt: EXPIRED_AT,
        },
      }),
    );

    expect(event).toMatchObject({
      type: "thread.sidechat-expired",
      payload: {
        threadId: SIDECHAT_THREAD_ID,
        expectedLastActivityAt: LAST_ACTIVITY_AT,
        expiredAt: EXPIRED_AT,
      },
    });
  });

  it("defers expiry while a turn is running", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel({ running: true }),
          command: {
            type: "thread.sidechat.expire",
            commandId: CommandId.makeUnsafe("cmd-expire-running-sidechat"),
            threadId: SIDECHAT_THREAD_ID,
            expectedLastActivityAt: LAST_ACTIVITY_AT,
            expiredAt: EXPIRED_AT,
          },
        }),
      ),
    ).rejects.toThrow("still has a running turn");
  });

  it("rejects new turns after expiry", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel({ expiredAt: EXPIRED_AT }),
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-expired-sidechat"),
            threadId: SIDECHAT_THREAD_ID,
            message: {
              messageId: MessageId.makeUnsafe("message-expired-sidechat"),
              role: "user",
              text: "Continue",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: EXPIRED_AT,
          },
        }),
      ),
    ).rejects.toThrow("expired after 1 hour of inactivity");
  });
});
