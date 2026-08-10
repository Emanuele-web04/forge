import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_PROVIDER_PROFILE_ID,
  EventId,
  MessageId,
  ProviderProfileId,
  ThreadId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { fingerprintOrchestrationCommand } from "./commandFingerprint";

function turnCommand(overrides: Partial<OrchestrationCommand> = {}): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("command-a"),
    threadId: ThreadId.makeUnsafe("thread-a"),
    message: {
      messageId: MessageId.makeUnsafe("message-a"),
      role: "user",
      text: "hello",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  } as OrchestrationCommand;
}

describe("fingerprintOrchestrationCommand", () => {
  it("ignores the idempotency key but changes when authoritative intent changes", () => {
    const first = fingerprintOrchestrationCommand(turnCommand());
    const sameIntent = fingerprintOrchestrationCommand(
      turnCommand({ commandId: CommandId.makeUnsafe("command-b") }),
    );
    const changedIntent = fingerprintOrchestrationCommand(
      turnCommand({ createdAt: "2026-07-14T00:00:01.000Z" }),
    );

    expect(sameIntent).toEqual(first);
    expect(changedIntent.value).not.toBe(first.value);
  });

  it("ignores generated assistant-selection ids and untrusted upload metadata", () => {
    const withAttachments = (assistantId: string, uploadName: string) =>
      turnCommand({
        message: {
          messageId: MessageId.makeUnsafe("message-a"),
          role: "user",
          text: "hello",
          attachments: [
            {
              type: "assistant-selection",
              id: assistantId,
              assistantMessageId: MessageId.makeUnsafe("assistant-a"),
              text: "selection",
            },
            {
              type: "image",
              id: "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              name: uploadName,
              mimeType: "image/png",
              sizeBytes: uploadName.length,
            },
          ],
        },
      });

    expect(fingerprintOrchestrationCommand(withAttachments("generated-a", "one.png"))).toEqual(
      fingerprintOrchestrationCommand(withAttachments("generated-b", "spoofed.png")),
    );
  });

  it("preserves v1 fingerprints for legacy default-profile retries", () => {
    const legacyCompatible = fingerprintOrchestrationCommand(
      turnCommand({
        modelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5.6-sol",
        },
      }),
    );
    const workProfile = fingerprintOrchestrationCommand(
      turnCommand({
        modelSelection: {
          provider: "codex",
          profileId: ProviderProfileId.makeUnsafe("work"),
          model: "gpt-5.6-sol",
        },
      }),
    );

    expect(legacyCompatible.value).toBe(
      "f5e81d743fcb1a2a90a68d6b3d52ba8bc2fc7c17b47b250607a6f0f7d9521bda",
    );
    expect(workProfile.value).not.toBe(legacyCompatible.value);
  });

  it("keeps arbitrary activity profileId payloads fingerprint-significant", () => {
    const activityCommand = (payload: Record<string, unknown>): OrchestrationCommand => ({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe("command-activity-profile"),
      threadId: ThreadId.makeUnsafe("thread-a"),
      activity: {
        id: EventId.makeUnsafe("activity-profile"),
        tone: "info",
        kind: "profile.observed",
        summary: "Profile observed",
        payload,
        turnId: null,
        createdAt: "2026-07-14T00:00:00.000Z",
      },
      createdAt: "2026-07-14T00:00:00.000Z",
    });

    expect(fingerprintOrchestrationCommand(activityCommand({ profileId: "default" })).value).not.toBe(
      fingerprintOrchestrationCommand(activityCommand({})).value,
    );
  });
});
