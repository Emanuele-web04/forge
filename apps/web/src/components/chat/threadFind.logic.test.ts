// FILE: threadFind.logic.test.ts
// Purpose: Matching, next/prev wrap, and jump-to-message selection for in-thread find.

import { MessageId, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { appendPastedTextsToPrompt, createPastedTextDraft } from "../../lib/composerPastedText";
import {
  appendTerminalContextsToPrompt,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  collectCaseInsensitiveSubstringRanges,
  collectThreadFindDocuments,
  createThreadFindDocumentTextCache,
  createThreadFindHighlightStore,
  eventTargetsInAppBrowser,
  findThreadMatches,
  resolveThreadFindJump,
  shouldCaptureChatFindShortcut,
  stepThreadFindIndex,
  threadFindMarkdownProps,
  wrapFindQueryInHtml,
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

  it("matches the visible user bubble and ignores stripped transport XML", () => {
    const pastedPrompt = appendPastedTextsToPrompt("Fix the login button", [
      createPastedTextDraft({
        id: "paste-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        text: "secret error in the pasted payload",
      }),
    ]);
    const terminalContext: TerminalContextDraft = {
      id: "context-1",
      threadId: ThreadId.makeUnsafe("thread-1"),
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 12,
      lineEnd: 13,
      text: "git status\nOn branch main",
      createdAt: "2026-03-13T12:00:00.000Z",
    };
    const terminalPrompt = appendTerminalContextsToPrompt("Investigate this", [terminalContext]);
    const entries: TimelineEntry[] = [
      {
        id: "user-pasted",
        kind: "message",
        createdAt: "2026-01-01T00:00:00.000Z",
        message: {
          id: messageId("user-pasted"),
          role: "user",
          text: pastedPrompt,
          createdAt: "2026-01-01T00:00:00.000Z",
          streaming: false,
        },
      },
      {
        id: "user-terminal",
        kind: "message",
        createdAt: "2026-01-01T00:00:01.000Z",
        message: {
          id: messageId("user-terminal"),
          role: "user",
          text: terminalPrompt,
          createdAt: "2026-01-01T00:00:01.000Z",
          streaming: false,
        },
      },
    ];

    const documents = collectThreadFindDocuments(entries);
    expect(documents.map((document) => document.text)).toEqual([
      "Fix the login button",
      "@terminal-1:12-13 Investigate this",
    ]);
    expect(findThreadMatches(documents, "error")).toEqual([]);
    expect(findThreadMatches(documents, "login button")).toEqual([
      {
        messageId: messageId("user-pasted"),
        startOffset: 8,
        endOffset: 20,
      },
    ]);
    expect(findThreadMatches(documents, "@terminal-1:12-13")).toEqual([
      {
        messageId: messageId("user-terminal"),
        startOffset: 0,
        endOffset: 17,
      },
    ]);
  });

  it("reuses projected text for unchanged message objects", () => {
    const stableMessage = {
      id: messageId("assistant-stable"),
      role: "assistant" as const,
      text: "stable text",
      createdAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
    };
    const streamingMessage = {
      id: messageId("assistant-streaming"),
      role: "assistant" as const,
      text: "first token",
      createdAt: "2026-01-01T00:00:01.000Z",
      streaming: true,
    };
    const resolveText = vi.fn((_message: ChatMessage, text: string) => text.toUpperCase());
    const cache = createThreadFindDocumentTextCache(resolveText);
    const entries: TimelineEntry[] = [stableMessage, streamingMessage].map((message) => ({
      id: message.id,
      kind: "message" as const,
      createdAt: message.createdAt,
      message,
    }));

    expect(collectThreadFindDocuments(entries, cache).map((entry) => entry.text)).toEqual([
      "STABLE TEXT",
      "FIRST TOKEN",
    ]);
    expect(collectThreadFindDocuments(entries, cache).map((entry) => entry.text)).toEqual([
      "STABLE TEXT",
      "FIRST TOKEN",
    ]);

    const nextStreamingMessage = { ...streamingMessage, text: "second token" };
    const nextEntries: TimelineEntry[] = [
      entries[0]!,
      {
        id: nextStreamingMessage.id,
        kind: "message",
        createdAt: nextStreamingMessage.createdAt,
        message: nextStreamingMessage,
      },
    ];
    expect(collectThreadFindDocuments(nextEntries, cache).map((entry) => entry.text)).toEqual([
      "STABLE TEXT",
      "SECOND TOKEN",
    ]);
    expect(resolveText).toHaveBeenCalledTimes(3);
  });
});

describe("wrapFindQueryInHtml", () => {
  it("wraps matches inside highlighted code without breaking tags", () => {
    const html = '<pre class="shiki"><code><span class="line">Error: failed</span></code></pre>';
    const wrapped = wrapFindQueryInHtml(html, "error", 10);
    expect(wrapped).toContain('data-chat-find-match="true"');
    expect(wrapped).toContain('data-chat-find-start="10"');
    expect(wrapped).toContain(">Error</span>");
    expect(wrapped).toContain('class="shiki"');
    expect(wrapped).toContain("failed");
  });

  it("matches the previous splice output across tags, entities, and adjacent hits", () => {
    const html = '<pre><code><span class="line">Error &amp; error</span> errorerror</code></pre>';
    const wrapped = wrapFindQueryInHtml(html, "error", 7, {
      startOffset: 15,
      endOffset: 20,
    });

    expect(wrapped).toBe(
      '<pre><code><span class="line"><span class="chat-find-match" data-chat-find-match="true" data-chat-find-start="7">Error</span> &amp; <span class="chat-find-match chat-find-match-active" data-chat-find-match="active" data-chat-find-start="15">error</span></span> <span class="chat-find-match" data-chat-find-match="true" data-chat-find-start="21">error</span><span class="chat-find-match" data-chat-find-match="true" data-chat-find-start="26">error</span></code></pre>',
    );
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

describe("shouldCaptureChatFindShortcut", () => {
  it("opens find on the empty landing chat surface", () => {
    expect(
      shouldCaptureChatFindShortcut({
        shouldRenderChatPaneContent: true,
        terminalWorkspaceTerminalTabActive: false,
        inAppBrowserFocused: false,
      }),
    ).toBe(true);
  });

  it("does not steal Ctrl+F from a focused terminal tab or in-app browser", () => {
    expect(
      shouldCaptureChatFindShortcut({
        shouldRenderChatPaneContent: true,
        terminalWorkspaceTerminalTabActive: true,
        inAppBrowserFocused: false,
      }),
    ).toBe(false);
    expect(
      shouldCaptureChatFindShortcut({
        shouldRenderChatPaneContent: true,
        terminalWorkspaceTerminalTabActive: false,
        inAppBrowserFocused: true,
      }),
    ).toBe(false);
    expect(
      shouldCaptureChatFindShortcut({
        shouldRenderChatPaneContent: false,
        terminalWorkspaceTerminalTabActive: false,
        inAppBrowserFocused: false,
      }),
    ).toBe(false);
  });
});

describe("eventTargetsInAppBrowser", () => {
  it("treats missing or non-element targets as outside the in-app browser", () => {
    expect(eventTargetsInAppBrowser(null)).toBe(false);
  });
});

describe("createThreadFindHighlightStore", () => {
  it("notifies subscribers when the highlight snapshot changes", () => {
    const store = createThreadFindHighlightStore();
    const seen: Array<string | null> = [];
    const unsubscribe = store.subscribe(() => {
      seen.push(store.get()?.query ?? null);
    });

    store.set({ query: "error", activeMatch: null });
    store.set({ query: "error", activeMatch: null });
    store.set(null);
    unsubscribe();
    store.set({ query: "later", activeMatch: null });

    expect(seen).toEqual(["error", "error", null]);
    expect(store.get()).toEqual({ query: "later", activeMatch: null });
  });

  it("publishes an immutable snapshot when the active match changes", () => {
    const store = createThreadFindHighlightStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ query: "error", activeMatch: null });
    const previousSnapshot = store.get();
    listener.mockClear();

    const activeMatch = {
      messageId: messageId("assistant-1"),
      startOffset: 12,
      endOffset: 17,
    };
    store.setActiveMatch(activeMatch);

    expect(listener).toHaveBeenCalledOnce();
    expect(store.get()).not.toBe(previousSnapshot);
    expect(previousSnapshot?.activeMatch).toBeNull();
    expect(store.get()?.activeMatch).toEqual(activeMatch);

    listener.mockClear();
    store.setActiveMatch(activeMatch);
    expect(listener).not.toHaveBeenCalled();
  });
});
