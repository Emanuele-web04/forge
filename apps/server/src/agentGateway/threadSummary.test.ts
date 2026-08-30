import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationMessage } from "@synara/contracts";
import { MessageId, ThreadId, TurnId } from "@synara/contracts";

import { deriveAgentThreadStatus, paginateThreadMessages } from "./threadSummary.ts";

function makeMessage(index: number, text = `message ${index}`): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(`m-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    turnId: null,
    streaming: false,
    source: "native",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  };
}

const session = (status: "running" | "ready" | "error" | "starting" | "stopped") => ({
  threadId: ThreadId.makeUnsafe("t-1"),
  status,
  providerName: null,
  runtimeMode: "approval-required" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-01T00:00:00.000Z",
});

const latestTurn = (state: "running" | "completed" | "interrupted" | "error") => ({
  turnId: TurnId.makeUnsafe("turn-1"),
  state,
  requestedAt: "2026-03-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

describe("deriveAgentThreadStatus", () => {
  it("prioritizes pending approval over a running turn", () => {
    assert.equal(
      deriveAgentThreadStatus({
        session: session("running"),
        latestTurn: latestTurn("running"),
        hasPendingApprovals: true,
      }),
      "waiting-for-approval",
    );
  });

  it("reports pending user input", () => {
    assert.equal(
      deriveAgentThreadStatus({
        session: session("ready"),
        latestTurn: latestTurn("completed"),
        hasPendingUserInput: true,
      }),
      "waiting-for-user-input",
    );
  });

  it("reports working while a turn runs", () => {
    assert.equal(
      deriveAgentThreadStatus({ session: session("running"), latestTurn: latestTurn("running") }),
      "working",
    );
  });

  it("reports error, interrupted, and idle states", () => {
    assert.equal(
      deriveAgentThreadStatus({ session: session("error"), latestTurn: latestTurn("completed") }),
      "error",
    );
    assert.equal(
      deriveAgentThreadStatus({ session: session("ready"), latestTurn: latestTurn("interrupted") }),
      "interrupted",
    );
    assert.equal(
      deriveAgentThreadStatus({ session: session("ready"), latestTurn: latestTurn("completed") }),
      "idle",
    );
    assert.equal(deriveAgentThreadStatus({ session: null, latestTurn: null }), "idle");
  });
});

describe("paginateThreadMessages", () => {
  it("returns the newest messages first call and pages older ones via cursor", () => {
    const messages = Array.from({ length: 45 }, (_, index) => makeMessage(index));
    const firstPage = paginateThreadMessages({ messages, messageLimit: 20 });
    assert.equal(firstPage.totalMessages, 45);
    assert.equal(firstPage.messages.length, 20);
    assert.equal(firstPage.messages[0]?.index, 25);
    assert.equal(firstPage.messages.at(-1)?.index, 44);
    assert.equal(firstPage.nextCursor, "25");

    const secondPage = paginateThreadMessages({
      messages,
      messageLimit: 20,
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.messages[0]?.index, 5);
    assert.equal(secondPage.messages.at(-1)?.index, 24);
    assert.equal(secondPage.nextCursor, "5");

    const lastPage = paginateThreadMessages({
      messages,
      messageLimit: 20,
      cursor: secondPage.nextCursor,
    });
    assert.equal(lastPage.messages.length, 5);
    assert.equal(lastPage.messages[0]?.index, 0);
    assert.isUndefined(lastPage.nextCursor);
  });

  it("truncates long messages and marks them", () => {
    const longText = "x".repeat(5000);
    const page = paginateThreadMessages({
      messages: [makeMessage(0, longText)],
      maxMessageChars: 100,
    });
    assert.equal(page.messages[0]?.truncated, true);
    assert.include(page.messages[0]?.text, "[... truncated 4900 chars]");
    assert.equal(page.effectiveMessageLimit, 20);
    assert.equal(page.effectiveMaxMessageChars, 100);
  });

  it("reports the effective hard cap instead of silently hiding it", () => {
    const page = paginateThreadMessages({
      messages: [makeMessage(0, "x".repeat(25_000))],
      maxMessageChars: 100_000,
    });

    assert.equal(page.effectiveMaxMessageChars, 20_000);
    assert.equal(page.messages[0]?.truncated, true);
  });

  it("recovers a long message exactly from bounded slices", () => {
    const longText = `${"a".repeat(9_999)}😀${"b".repeat(15_006)}`;
    const messages = [makeMessage(0, longText)];
    const summary = paginateThreadMessages({ messages });
    const slices: string[] = [];
    let messageOffsetChars = 0;
    const messageId = summary.messages[0]?.messageId;
    const messageVersion = summary.messages[0]?.messageVersion;

    while (true) {
      const page = paginateThreadMessages({
        messages,
        messageIndex: 0,
        messageOffsetChars,
        messageId,
        messageVersion,
        maxMessageChars: 10_000,
      });
      slices.push(page.messages[0]?.text ?? "");
      assert.equal(page.effectiveMessageLimit, 1);
      assert.equal(page.effectiveMaxMessageChars, 10_000);
      assert.equal(page.messagePage?.index, 0);
      assert.equal(page.messagePage?.offsetChars, messageOffsetChars);
      assert.equal(page.messagePage?.messageId, messageId);
      assert.equal(page.messagePage?.messageVersion, messageVersion);
      const nextOffset = page.messagePage?.nextOffsetChars;
      if (nextOffset === undefined) break;
      messageOffsetChars = nextOffset;
    }

    assert.equal(slices.join(""), longText);
  });

  it("rejects invalid and stale single-message coordinates clearly", () => {
    const messages = [makeMessage(0, "short")];
    const summary = paginateThreadMessages({ messages });
    const messageId = summary.messages[0]?.messageId;
    const messageVersion = summary.messages[0]?.messageVersion;

    assert.throws(
      () => paginateThreadMessages({ messages, messageOffsetChars: 1 }),
      /messageOffsetChars.*requires.*messageIndex/,
    );
    assert.throws(
      () => paginateThreadMessages({ messages, messageIndex: 1 }),
      /messageId.*required.*messageIndex/,
    );
    assert.throws(
      () => paginateThreadMessages({ messages, messageIndex: 0, messageId }),
      /messageVersion.*required.*messageIndex/,
    );
    assert.throws(
      () =>
        paginateThreadMessages({
          messages,
          messageIndex: 1,
          messageId,
          messageVersion,
        }),
      /Message index 1 is no longer available/,
    );
    assert.throws(
      () =>
        paginateThreadMessages({
          messages,
          messageIndex: 0,
          messageOffsetChars: 20_000,
          messageId,
          messageVersion,
        }),
      /Message offset 20000 is no longer valid/,
    );
    assert.throws(
      () => paginateThreadMessages({ messages, cursor: "1", messageIndex: 0 }),
      /cursor.*cannot be combined.*messageIndex/,
    );

    const emojiMessage = makeMessage(0, `${"a".repeat(9_999)}😀tail`);
    const emojiSummary = paginateThreadMessages({ messages: [emojiMessage] }).messages[0]!;
    assert.throws(
      () =>
        paginateThreadMessages({
          messages: [emojiMessage],
          messageIndex: 0,
          messageOffsetChars: 10_000,
          messageId: emojiSummary.messageId,
          messageVersion: emojiSummary.messageVersion,
          maxMessageChars: 10_000,
        }),
      /splits a Unicode character/,
    );

    const firstSummary = paginateThreadMessages({
      messages: [makeMessage(0, "x".repeat(25_000))],
    });
    assert.throws(
      () =>
        paginateThreadMessages({
          messages: [makeMessage(1, "y".repeat(25_000))],
          messageIndex: 0,
          messageOffsetChars: 0,
          messageId: firstSummary.messages[0]?.messageId,
          messageVersion: firstSummary.messages[0]?.messageVersion,
          maxMessageChars: 10_000,
        }),
      /now identifies message "m-1".*expected "m-0"/,
    );

    const streamingMessage = { ...makeMessage(0, "in progress"), streaming: true };
    const streamingSummary = paginateThreadMessages({ messages: [streamingMessage] }).messages[0]!;
    assert.throws(
      () =>
        paginateThreadMessages({
          messages: [streamingMessage],
          messageIndex: 0,
          messageId: streamingSummary.messageId,
          messageVersion: streamingSummary.messageVersion,
        }),
      /still streaming.*Retry after it settles/,
    );

    assert.throws(
      () =>
        paginateThreadMessages({
          messages: [{ ...messages[0]!, text: "changed" }],
          messageIndex: 0,
          messageId,
          messageVersion,
        }),
      /changed since version/,
    );
  });

  it("ignores garbage cursors", () => {
    const messages = Array.from({ length: 3 }, (_, index) => makeMessage(index));
    const page = paginateThreadMessages({ messages, cursor: "banana" });
    assert.equal(page.messages.length, 3);
  });

  it("surfaces dispatch origin on messages that carry it", () => {
    const message = { ...makeMessage(0), dispatchOrigin: "agent" as const };
    const page = paginateThreadMessages({ messages: [message] });
    assert.equal(page.messages[0]?.dispatchOrigin, "agent");
  });
});
