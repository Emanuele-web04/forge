// FILE: threadFind.logic.test.ts
// Purpose: Matching, next/prev wrap, and jump-to-message selection for in-thread find.

import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../session-logic";
import {
  collectCaseInsensitiveSubstringRanges,
  collectThreadFindDocuments,
  findThreadMatches,
  resolveThreadFindJump,
  stepThreadFindIndex,
  threadFindMarkdownProps,
  type ThreadFindDocument,
} from "./threadFind.logic";

function messageId(value: string): MessageId {
  return MessageId.makeUnsafe(value);
}

function document(id: string, text: string, segmentIndex?: number): ThreadFindDocument {
  return {
    messageId: messageId(id),
    text,
    ...(segmentIndex === undefined ? {} : { segmentIndex }),
  };
}

describe("collectCaseInsensitiveSubstringRanges", () => {
  it("finds non-overlapping case-insensitive substrings", () => {
    expect(collectCaseInsensitiveSubstringRanges("Error: failed with error", "ERROR")).toEqual([
      { startOffset: 0, endOffset: 5 },
      { startOffset: 19, endOffset: 24 },
    ]);
  });

  it("does not overlap successive matches", () => {
    expect(collectCaseInsensitiveSubstringRanges("aaa", "aa")).toEqual([
      { startOffset: 0, endOffset: 2 },
    ]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(collectCaseInsensitiveSubstringRanges("hello", "   ")).toEqual([]);
    expect(collectCaseInsensitiveSubstringRanges("hello", "")).toEqual([]);
  });
});

describe("collectThreadFindDocuments", () => {
  it("projects message and message-segment rows in transcript order", () => {
    const assistantId = messageId("assistant-1");
    const entries: TimelineEntry[] = [
      {
        id: "user-1",
        kind: "message",
        createdAt: "2026-01-01T00:00:00.000Z",
        message: {
          id: messageId("user-1"),
          role: "user",
          text: "please find the error",
          createdAt: "2026-01-01T00:00:00.000Z",
          streaming: false,
        },
      },
      {
        id: "assistant-1#seg:0",
        kind: "message-segment",
        createdAt: "2026-01-01T00:00:01.000Z",
        sequence: 1,
        segmentIndex: 0,
        message: {
          id: assistantId,
          role: "assistant",
          text: "first slice later slice",
          textSegments: [
            {
              text: "first slice",
              startedAt: "2026-01-01T00:00:01.000Z",
              endedAt: "2026-01-01T00:00:01.500Z",
              sequence: 1,
            },
            {
              text: "later slice",
              startedAt: "2026-01-01T00:00:02.000Z",
              endedAt: "2026-01-01T00:00:02.500Z",
              sequence: 2,
            },
          ],
          createdAt: "2026-01-01T00:00:01.000Z",
          streaming: false,
        },
      },
      {
        id: "assistant-1#seg:1",
        kind: "message-segment",
        createdAt: "2026-01-01T00:00:02.000Z",
        sequence: 2,
        segmentIndex: 1,
        message: {
          id: assistantId,
          role: "assistant",
          text: "first slice later slice",
          textSegments: [
            {
              text: "first slice",
              startedAt: "2026-01-01T00:00:01.000Z",
              endedAt: "2026-01-01T00:00:01.500Z",
              sequence: 1,
            },
            {
              text: "later slice",
              startedAt: "2026-01-01T00:00:02.000Z",
              endedAt: "2026-01-01T00:00:02.500Z",
              sequence: 2,
            },
          ],
          createdAt: "2026-01-01T00:00:01.000Z",
          streaming: false,
        },
      },
    ];

    expect(collectThreadFindDocuments(entries)).toEqual([
      { messageId: messageId("user-1"), text: "please find the error" },
      { messageId: assistantId, text: "first slice", segmentIndex: 0 },
      { messageId: assistantId, text: "later slice", segmentIndex: 1 },
    ]);
  });
});

describe("findThreadMatches", () => {
  it("returns every occurrence across projected messages in order", () => {
    const matches = findThreadMatches(
      [
        document("user-1", "Look at src/app.ts please"),
        document("assistant-1", "Opened src/app.ts and src/app.ts again"),
      ],
      "SRC/APP.TS",
    );

    expect(matches).toEqual([
      {
        messageId: messageId("user-1"),
        startOffset: 8,
        endOffset: 18,
      },
      {
        messageId: messageId("assistant-1"),
        startOffset: 7,
        endOffset: 17,
      },
      {
        messageId: messageId("assistant-1"),
        startOffset: 22,
        endOffset: 32,
      },
    ]);
  });
});

describe("stepThreadFindIndex", () => {
  it("wraps next and previous around the match list", () => {
    expect(stepThreadFindIndex(3, 0, "next")).toBe(1);
    expect(stepThreadFindIndex(3, 2, "next")).toBe(0);
    expect(stepThreadFindIndex(3, 0, "previous")).toBe(2);
    expect(stepThreadFindIndex(3, 1, "previous")).toBe(0);
  });

  it("starts at the first or last match when the current index is unset", () => {
    expect(stepThreadFindIndex(4, -1, "next")).toBe(0);
    expect(stepThreadFindIndex(4, -1, "previous")).toBe(3);
    expect(stepThreadFindIndex(0, 0, "next")).toBe(-1);
  });
});

describe("resolveThreadFindJump", () => {
  it("selects the message (and segment) the timeline should scroll to", () => {
    const matches = findThreadMatches(
      [document("m1", "alpha error"), document("m2", "nope"), document("m3", "error two", 1)],
      "error",
    );

    expect(resolveThreadFindJump(matches, 0)).toEqual({
      messageId: messageId("m1"),
      startOffset: 6,
      endOffset: 11,
    });
    expect(resolveThreadFindJump(matches, 1)).toEqual({
      messageId: messageId("m3"),
      startOffset: 0,
      endOffset: 5,
      segmentIndex: 1,
    });
    expect(resolveThreadFindJump(matches, 2)).toBeNull();
  });
});

describe("threadFindMarkdownProps", () => {
  it("marks only the active match's row for the stronger highlight", () => {
    const activeMatch = {
      messageId: messageId("m3"),
      startOffset: 0,
      endOffset: 5,
      segmentIndex: 1,
    };
    const highlight = { query: "error", activeMatch };

    expect(threadFindMarkdownProps(highlight, messageId("m3"), 1)).toEqual({
      findQuery: "error",
      findActiveRange: { startOffset: 0, endOffset: 5 },
    });
    expect(threadFindMarkdownProps(highlight, messageId("m3"), 0)).toEqual({
      findQuery: "error",
      findActiveRange: null,
    });
    expect(threadFindMarkdownProps(null, messageId("m3"), 1)).toEqual({});
  });
});
