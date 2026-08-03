import { MessageId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  appendOriginalComposerPromptBlocks,
  appendOriginalTerminalContextBlock,
  appendTerminalContextsToPrompt,
  buildTerminalContextPreviewTitle,
  buildTerminalContextBlock,
  countInlineTerminalContextPlaceholders,
  deriveDisplayedUserMessageState,
  ensureInlineTerminalContextPlaceholders,
  extractTrailingTerminalContexts,
  filterTerminalContextsWithText,
  formatInlineTerminalContextLabel,
  formatTerminalContextLabel,
  hasTerminalContextText,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  IMAGE_ONLY_VISIBLE_PLACEHOLDER,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  isTerminalContextExpired,
  materializeInlineTerminalContextPrompt,
  removeInlineTerminalContextPlaceholder,
  stripInlineTerminalContextPlaceholders,
  syncTerminalContextsByIds,
  terminalContextIdListsEqual,
  type TerminalContextDraft,
} from "./terminalContext";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import { appendPastedTextsToPrompt, createPastedTextDraft } from "./composerPastedText";
import { appendFileCommentsToPrompt } from "./fileComments";
import {
  appendBrowserAnnotationsToPrompt,
  type BrowserAnnotationDraft,
} from "./browserAnnotations";

const BROWSER_ANNOTATION_MESSAGE_ID = MessageId.makeUnsafe("message-browser-annotation");

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

function makeBrowserAnnotation(): BrowserAnnotationDraft {
  return {
    id: "browser-1",
    ordinal: 1,
    tabId: "tab-1",
    source: { url: "https://example.test", pageTitle: "Example" },
    selector: "#submit",
    tagName: "button",
    role: "button",
    name: "Submit",
    text: "Submit",
    fingerprint: "button|submit",
    comment: "",
    capturedAt: "2026-07-23T10:00:00.000Z",
  };
}

describe("terminalContext", () => {
  it("syncs terminal contexts to editor ids while dropping missing ones", () => {
    const first = { id: "first", text: "one" };
    const second = { id: "second", text: "two" };

    expect(syncTerminalContextsByIds([first, second], ["second", "missing"])).toEqual([second]);
  });

  it("compares terminal context ids in order", () => {
    const contexts = [{ id: "first" }, { id: "second" }];

    expect(terminalContextIdListsEqual(contexts, ["first", "second"])).toBe(true);
    expect(terminalContextIdListsEqual(contexts, ["second", "first"])).toBe(false);
    expect(terminalContextIdListsEqual(contexts, ["first"])).toBe(false);
  });

  it("formats terminal labels with line ranges", () => {
    expect(formatTerminalContextLabel(makeContext())).toBe("Terminal 1 lines 12-13");
    expect(
      formatTerminalContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("Terminal 1 line 9");
  });

  it("builds a numbered terminal context block", () => {
    expect(buildTerminalContextBlock([makeContext()])).toBe(
      [
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("appends terminal context blocks after prompt text", () => {
    expect(appendTerminalContextsToPrompt("Investigate this", [makeContext()])).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("preserves the original terminal context block when editing display text", () => {
    const originalPrompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(
      appendOriginalTerminalContextBlock({
        editedPrompt: "Investigate this edited",
        originalPrompt,
      }),
    ).toBe(
      [
        "Investigate this edited",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("preserves all hidden composer blocks when editing display text", () => {
    const assistantSelections = [{ assistantMessageId: "msg-1", text: "selected line" }];
    const contexts = [makeContext()];
    const fileComments = [
      { path: "src/app.ts", startLine: 3, endLine: 5, text: "rename this helper" },
    ];
    const pastedTexts = [
      createPastedTextDraft({
        id: "paste-1",
        createdAt: "2026-06-15T00:00:00.000Z",
        text: ["before", "</pasted_text>", "after"].join("\n"),
      }),
    ];
    const annotations = [makeBrowserAnnotation()];
    const originalPrompt = appendBrowserAnnotationsToPrompt(
      appendPastedTextsToPrompt(
        appendFileCommentsToPrompt(
          appendTerminalContextsToPrompt(
            appendAssistantSelectionsToPrompt("Investigate this", assistantSelections),
            contexts,
          ),
          fileComments,
        ),
        pastedTexts,
      ),
      annotations,
      BROWSER_ANNOTATION_MESSAGE_ID,
    );

    expect(
      appendOriginalComposerPromptBlocks({
        editedPrompt: "Investigate this edited",
        originalPrompt,
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toBe(
      appendBrowserAnnotationsToPrompt(
        appendPastedTextsToPrompt(
          appendFileCommentsToPrompt(
            appendTerminalContextsToPrompt(
              appendAssistantSelectionsToPrompt("Investigate this edited", assistantSelections),
              contexts,
            ),
            fileComments,
          ),
          pastedTexts,
        ),
        annotations,
        BROWSER_ANNOTATION_MESSAGE_ID,
      ),
    );
  });

  it("does not duplicate a copied annotation block bound to another message", () => {
    const copiedPrompt = appendBrowserAnnotationsToPrompt(
      "Keep this transport log",
      [makeBrowserAnnotation()],
      MessageId.makeUnsafe("message-source"),
    );

    expect(
      appendOriginalComposerPromptBlocks({
        editedPrompt: copiedPrompt,
        originalPrompt: copiedPrompt,
        messageId: MessageId.makeUnsafe("message-destination"),
      }),
    ).toBe(copiedPrompt);
    const displayed = deriveDisplayedUserMessageState(copiedPrompt, {
      messageId: MessageId.makeUnsafe("message-destination"),
    });
    expect(displayed.visibleText).toBe(copiedPrompt);
    expect(displayed.browserAnnotations).toEqual([]);
  });

  it("preserves annotation-only context when an empty edit is resent", () => {
    const originalPrompt = appendBrowserAnnotationsToPrompt(
      "",
      [makeBrowserAnnotation()],
      BROWSER_ANNOTATION_MESSAGE_ID,
    );

    expect(
      appendOriginalComposerPromptBlocks({
        editedPrompt: "",
        originalPrompt,
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toBe(originalPrompt);
  });

  it("hides browser annotation transport JSON from transcript and copy text", () => {
    const annotation = makeBrowserAnnotation();
    const state = deriveDisplayedUserMessageState(
      appendBrowserAnnotationsToPrompt(
        "Update this element",
        [annotation],
        BROWSER_ANNOTATION_MESSAGE_ID,
      ),
      { messageId: BROWSER_ANNOTATION_MESSAGE_ID },
    );

    expect(state.visibleText).toBe("Update this element");
    expect(state.copyText).toBe("Update this element");
    expect(state.browserAnnotations).toEqual([annotation]);
  });

  it("replaces inline placeholders with inline terminal labels before appending context blocks", () => {
    expect(
      appendTerminalContextsToPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe(
      [
        "Investigate @terminal-1:12-13 carefully",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("extracts terminal context blocks from message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(extractTrailingTerminalContexts(prompt)).toEqual({
      promptText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("derives displayed user message state from terminal context prompts", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(
      deriveDisplayedUserMessageState(prompt, {
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toEqual({
      visibleText: "Investigate this",
      copyText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
      assistantSelections: [],
      fileComments: [],
      workItemReferences: [],
      pastedTexts: [],
      browserAnnotations: [],
    });
  });

  it("strips assistant selection transport markup from displayed and copied text", () => {
    const prompt = appendAssistantSelectionsToPrompt("Investigate this", [
      {
        assistantMessageId: "msg-1",
        text: "selected line",
      },
    ]);
    expect(
      deriveDisplayedUserMessageState(prompt, {
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toEqual({
      visibleText: "Investigate this",
      copyText: "Investigate this",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
      assistantSelections: [{ assistantMessageId: "msg-1", text: "selected line" }],
      fileComments: [],
      workItemReferences: [],
      pastedTexts: [],
      browserAnnotations: [],
    });
  });

  it("keeps assistant selections and terminal context separate from the copied bubble text", () => {
    const prompt = appendTerminalContextsToPrompt(
      appendAssistantSelectionsToPrompt("Investigate this", [
        {
          assistantMessageId: "msg-1",
          text: "selected line",
        },
      ]),
      [makeContext()],
    );

    expect(
      deriveDisplayedUserMessageState(prompt, {
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toEqual({
      visibleText: "Investigate this",
      copyText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
      assistantSelections: [{ assistantMessageId: "msg-1", text: "selected line" }],
      fileComments: [],
      workItemReferences: [],
      pastedTexts: [],
      browserAnnotations: [],
    });
  });

  it("separates file comments, terminal context, and assistant selections in display state", () => {
    // Mirror the composer send path: assistant selections, then terminal
    // contexts, then file comments (outermost).
    const prompt = appendFileCommentsToPrompt(
      appendTerminalContextsToPrompt(
        appendAssistantSelectionsToPrompt("Investigate this", [
          { assistantMessageId: "msg-1", text: "selected line" },
        ]),
        [makeContext()],
      ),
      [{ path: "src/app.ts", startLine: 3, endLine: 5, text: "rename this helper" }],
    );

    expect(
      deriveDisplayedUserMessageState(prompt, {
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toEqual({
      visibleText: "Investigate this",
      copyText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
      assistantSelections: [{ assistantMessageId: "msg-1", text: "selected line" }],
      fileComments: [{ path: "src/app.ts", startLine: 3, endLine: 5, text: "rename this helper" }],
      workItemReferences: [],
      pastedTexts: [],
      browserAnnotations: [],
    });
  });

  it("preserves prompt text when no trailing terminal context block exists", () => {
    expect(extractTrailingTerminalContexts("No attached context")).toEqual({
      promptText: "No attached context",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    });
  });

  it("hides the image-only bootstrap prompt when requested for transcript display", () => {
    expect(
      deriveDisplayedUserMessageState(IMAGE_ONLY_BOOTSTRAP_PROMPT, {
        hideImageOnlyBootstrapPrompt: true,
        messageId: BROWSER_ANNOTATION_MESSAGE_ID,
      }),
    ).toEqual({
      visibleText: IMAGE_ONLY_VISIBLE_PLACEHOLDER,
      copyText: "",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
      assistantSelections: [],
      fileComments: [],
      workItemReferences: [],
      pastedTexts: [],
      browserAnnotations: [],
    });
  });

  it("returns null preview title when every context is invalid", () => {
    expect(
      buildTerminalContextPreviewTitle([
        makeContext({
          terminalId: "   ",
        }),
        makeContext({
          id: "context-2",
          text: "\n\n",
        }),
      ]),
    ).toBeNull();
  });

  it("tracks inline terminal context placeholders in prompt text", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(countInlineTerminalContextPlaceholders(`a${placeholder}b${placeholder}`)).toBe(2);
    expect(ensureInlineTerminalContextPlaceholders("Investigate this", 2)).toBe(
      `${placeholder}${placeholder}Investigate this`,
    );
    expect(insertInlineTerminalContextPlaceholder("abc", 1)).toEqual({
      prompt: `a ${placeholder} bc`,
      cursor: 4,
      contextIndex: 0,
    });
    expect(removeInlineTerminalContextPlaceholder(`a${placeholder}b${placeholder}c`, 1)).toEqual({
      prompt: `a${placeholder}bc`,
      cursor: 3,
    });
    expect(stripInlineTerminalContextPlaceholders(`a${placeholder}b`)).toBe("ab");
  });

  it("inserts a placeholder after a file mention when given the expanded prompt cursor", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("Inspect @package.json ", 22)).toEqual({
      prompt: `Inspect @package.json ${placeholder} `,
      cursor: 24,
      contextIndex: 0,
    });
  });

  it("adds a trailing space and consumes an existing trailing space at the insertion point", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("yo whats", 3)).toEqual({
      prompt: `yo ${placeholder} whats`,
      cursor: 5,
      contextIndex: 0,
    });
  });

  it("marks contexts without snapshot text as expired and filters them from sendable contexts", () => {
    const liveContext = makeContext();
    const expiredContext = makeContext({
      id: "context-2",
      text: "",
    });

    expect(hasTerminalContextText(liveContext)).toBe(true);
    expect(isTerminalContextExpired(liveContext)).toBe(false);
    expect(hasTerminalContextText(expiredContext)).toBe(false);
    expect(isTerminalContextExpired(expiredContext)).toBe(true);
    expect(filterTerminalContextsWithText([expiredContext, liveContext])).toEqual([liveContext]);
  });

  it("formats and materializes inline terminal labels from placeholder positions", () => {
    expect(formatInlineTerminalContextLabel(makeContext())).toBe("@terminal-1:12-13");
    expect(
      materializeInlineTerminalContextPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe("Investigate @terminal-1:12-13 carefully");
  });
});
