import { describe, expect, it } from "vitest";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
  stripComposerTriggerText,
} from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("detectComposerTrigger", () => {
  it("detects @mention trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "mention",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects slash model query after /model", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects a slash command mid-line after an existing chip token", () => {
    // Claude skills render as `/skill` chips, so a second command typed after one
    // must still open the picker even though the line no longer starts with `/`.
    const text = "/refactor-code /ui";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "ui",
      rangeStart: "/refactor-code ".length,
      rangeEnd: text.length,
    });
  });

  it("anchors a mid-line /model trigger to the slash token, not the line start", () => {
    const text = "/refactor-code /model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "",
      rangeStart: "/refactor-code ".length,
      rangeEnd: text.length,
    });
  });

  it("does not treat an in-word slash like and/or as a slash command", () => {
    const text = "decide and/or";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("does not treat a path token like src/foo as a slash command", () => {
    const text = "open src/foo.ts";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("does not treat a slash token containing a second slash as a slash command", () => {
    // The slash sits after whitespace (so a token is detected), but command names
    // are `[a-z-]+` — a query like "and/or" can never match one, so no empty picker.
    const text = "decide /and/or";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("closes the slash picker once the command is followed by a space and more words", () => {
    const text = "intro /fast and then";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects a skill trigger while typing a $skill token", () => {
    const text = "Use $che";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "skill",
      query: "che",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it("detects @mention trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "mention",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @mention trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "mention",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("mention");
    expect(trigger?.query).toBe("");
  });

  it('detects an unclosed quoted @"..." mention so paths with spaces stay editable', () => {
    const text = 'Look at @"/Users/John Smith/Docs';
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "mention",
      query: "/Users/John Smith/Docs",
      rangeStart: "Look at ".length,
      rangeEnd: text.length,
    });
  });

  it("keeps the trigger active while cursor is inside an unclosed quoted mention mid-word", () => {
    const text = 'Look at @"/Users/John Smith/Do and more';
    const cursor = 'Look at @"/Users/John Smith/Do'.length;
    const trigger = detectComposerTrigger(text, cursor);

    expect(trigger).toEqual({
      kind: "mention",
      query: "/Users/John Smith/Do",
      rangeStart: "Look at ".length,
      rangeEnd: cursor,
    });
  });

  it("keeps escaped quotes, backslashes, and @ signs inside an active quoted path", () => {
    const text = String.raw`Look at @"C:\\A \"B\"/@scope`;
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "mention",
      query: String.raw`C:\A "B"/@scope`,
      rangeStart: "Look at ".length,
      rangeEnd: text.length,
    });
  });

  it('does not treat a closed @"..." mention as still active', () => {
    const text = 'Look at @"/Users/John Smith/Docs" and more';
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("prefers a later unquoted mention over an earlier closed quoted mention", () => {
    const text = 'Look at @"/Users/John Smith/Docs" @sr';
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "mention",
      query: "sr",
      rangeStart: text.length - 3,
      rangeEnd: text.length,
    });
  });

  it("anchors the trigger to the last @ so adjacent mentions do not clobber each other", () => {
    // User typed @bar directly after the @foo chip without a separating space.
    const text = "@foo@bar";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "mention",
      query: "bar",
      rangeStart: "@foo".length,
      rangeEnd: text.length,
    });
  });

  it("still opens the picker with an empty query when a lone @ follows an existing chip", () => {
    const text = "@foo@";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "mention",
      query: "",
      rangeStart: "@foo".length,
      rangeEnd: text.length,
    });
  });

  it("does not treat an email like user@host as a mention trigger", () => {
    const text = "email me at user@host.com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("stripComposerTriggerText", () => {
  it("removes the active slash trigger text without touching the rest of the prompt", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(stripComposerTriggerText(text, trigger)).toBe("");
  });

  it("preserves earlier composer content when removing a trailing slash trigger", () => {
    const text = "Need context first\n/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(stripComposerTriggerText(text, trigger)).toBe("Need context first\n");
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });

  it("maps collapsed /automation command chip cursor to expanded text cursor", () => {
    const text = "/automation fra 15 secondi scrivi qui";

    expect(expandCollapsedComposerCursor(text, 1)).toBe("/automation".length);
    expect(expandCollapsedComposerCursor(text, 2)).toBe("/automation ".length);
  });

  it("counts quoted mention tokens at their raw length", () => {
    const text = `@"Casual greeting" what's this?`;

    expect(expandCollapsedComposerCursor(text, 1)).toBe(`@"Casual greeting"`.length);
    expect(expandCollapsedComposerCursor(text, 2)).toBe(`@"Casual greeting" `.length);
  });

  it("closes the mention trigger after selecting a quoted mention", () => {
    const text = `@"Casual greeting" `;
    const expandedCursor = expandCollapsedComposerCursor(text, 2);

    expect(expandedCursor).toBe(text.length);
    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps replacement cursors aligned when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then ".length + 2);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("round-trips cursors across quoted mention tokens", () => {
    const text = `@"Casual greeting" what's this?`;

    expect(collapseExpandedComposerCursor(text, `@"Casual greeting"`.length)).toBe(1);
    expect(collapseExpandedComposerCursor(text, `@"Casual greeting" `.length)).toBe(2);
    expect(
      expandCollapsedComposerCursor(text, collapseExpandedComposerCursor(text, text.length)),
    ).toBe(text.length);
  });

  it("maps expanded /automation command text cursor back to the chip cursor", () => {
    const text = "/automation fra 15 secondi scrivi qui";

    expect(collapseExpandedComposerCursor(text, "/automation".length)).toBe(1);
    expect(collapseExpandedComposerCursor(text, "/automation ".length)).toBe(2);
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when mentions are present", () => {
    const text = "open @AGENTS.md then ";

    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("isCollapsedCursorAdjacentToInlineToken", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "right")).toBe(false);
  });

  it("keeps raw skill triggers non-adjacent while typing", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("hello $che", "hello $che".length, "left")).toBe(
      false,
    );
    expect(isCollapsedCursorAdjacentToInlineToken("hello /che", "hello /che".length, "right")).toBe(
      false,
    );
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart - 1, "right")).toBe(false);
  });

  it("treats terminal pills as inline tokens for adjacency checks", () => {
    const text = `open ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} next`;
    const tokenStart = "open ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });

  it("treats /automation as an inline token once it has trailing text", () => {
    const text = "/automation fra 15 secondi";

    expect(isCollapsedCursorAdjacentToInlineToken(text, 1, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, 0, "right")).toBe(true);
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("parses standalone /debug command", () => {
    expect(parseStandaloneComposerSlashCommand("/debug")).toBe("debug");
  });

  it("parses standalone /fast command", () => {
    expect(parseStandaloneComposerSlashCommand("/fast")).toBe("fast");
  });

  it("parses standalone /feedback command", () => {
    expect(parseStandaloneComposerSlashCommand("/feedback")).toBe("feedback");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
  });
});
