import {
  ApprovalRequestId,
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
  lastActivityAt?: string;
  running?: boolean;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}): OrchestrationReadModel {
  const running = input.running ?? false;
  const lastActivityAt = input.lastActivityAt ?? LAST_ACTIVITY_AT;
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
        sidechatLastActivityAt: lastActivityAt,
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
        hasPendingApprovals: input.hasPendingApprovals ?? false,
        hasPendingUserInput: input.hasPendingUserInput ?? false,
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

  it.each([
    { interaction: "approval", readModel: makeReadModel({ hasPendingApprovals: true }) },
    { interaction: "user input", readModel: makeReadModel({ hasPendingUserInput: true }) },
  ])("defers expiry while $interaction is pending", async ({ readModel }) => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.sidechat.expire",
            commandId: CommandId.makeUnsafe("cmd-expire-pending-sidechat"),
            threadId: SIDECHAT_THREAD_ID,
            expectedLastActivityAt: LAST_ACTIVITY_AT,
            expiredAt: EXPIRED_AT,
          },
        }),
      ),
    ).rejects.toThrow("still has a pending interaction");
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

  it("rejects goal continuations after expiry", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel({ expiredAt: EXPIRED_AT }),
          command: {
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe("cmd-goal-expired-sidechat"),
            threadId: SIDECHAT_THREAD_ID,
            goalStartedAt: LAST_ACTIVITY_AT,
            trigger: "startup-recovery",
            createdAt: EXPIRED_AT,
          },
        }),
      ),
    ).rejects.toThrow("expired after 1 hour of inactivity");
  });

  it("rejects approval responses after expiry", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel({ expiredAt: EXPIRED_AT }),
          command: {
            type: "thread.approval.respond",
            commandId: CommandId.makeUnsafe("cmd-approval-expired-sidechat"),
            threadId: SIDECHAT_THREAD_ID,
            requestId: ApprovalRequestId.makeUnsafe("request-expired-sidechat"),
            decision: "accept",
            createdAt: EXPIRED_AT,
          },
        }),
      ),
    ).rejects.toThrow("expired after 1 hour of inactivity");
  });

  it("rejects user-input responses after expiry", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: makeReadModel({ expiredAt: EXPIRED_AT }),
          command: {
            type: "thread.user-input.respond",
            commandId: CommandId.makeUnsafe("cmd-user-input-expired-sidechat"),
            threadId: SIDECHAT_THREAD_ID,
            requestId: ApprovalRequestId.makeUnsafe("request-expired-sidechat"),
            answers: { Decision: "Continue" },
            createdAt: EXPIRED_AT,
          },
        }),
      ),
    ).rejects.toThrow("expired after 1 hour of inactivity");
  });

  it("compares expiry activity timestamps by instant", async () => {
    const equivalentOffsetTimestamp = "2026-08-30T12:00:00+02:00";
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: makeReadModel({ lastActivityAt: equivalentOffsetTimestamp }),
        command: {
          type: "thread.sidechat.expire",
          commandId: CommandId.makeUnsafe("cmd-expire-offset-sidechat"),
          threadId: SIDECHAT_THREAD_ID,
          expectedLastActivityAt: LAST_ACTIVITY_AT,
          expiredAt: EXPIRED_AT,
        },
      }),
    );

    expect(event).toMatchObject({
      type: "thread.sidechat-expired",
      payload: { expectedLastActivityAt: LAST_ACTIVITY_AT },
    });
  });

  it("records the latest activity by instant and canonicalizes it", async () => {
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: makeReadModel({ lastActivityAt: "2026-08-30T12:00:00+02:00" }),
        command: {
          type: "thread.sidechat.activity.record",
          commandId: CommandId.makeUnsafe("cmd-record-offset-sidechat"),
          threadId: SIDECHAT_THREAD_ID,
          activityAt: "2026-08-30T10:30:00.000Z",
        },
      }),
    );

    expect(event).toMatchObject({
      type: "thread.sidechat-activity-recorded",
      payload: { lastActivityAt: "2026-08-30T10:30:00.000Z" },
    });
  });
});
