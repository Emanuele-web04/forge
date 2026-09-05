import { describe, expect, it } from "vitest";

import {
  buildPromptThreadTitleFallback,
  buildThreadTitleConversationContext,
  GENERIC_CHAT_THREAD_TITLE,
  isGenericChatThreadTitle,
  isUsableGeneratedThreadTitle,
  sanitizeGeneratedThreadTitle,
  THREAD_TITLE_CONTEXT_MAX_CHARS,
} from "./chatThreads";

describe("chatThreads", () => {
  it("builds a short fallback title without forcing case", () => {
    expect(buildPromptThreadTitleFallback("FIX the BROKEN auth redirect in production now")).toBe(
      "FIX the BROKEN auth redirect in",
    );
  });

  it("falls back to the generic thread title when there is no usable text", () => {
    expect(buildPromptThreadTitleFallback("   \n\t  ")).toBe(GENERIC_CHAT_THREAD_TITLE);
  });

  it("sanitizes generated titles without lowercasing acronyms", () => {
    expect(sanitizeGeneratedThreadTitle('"Folder picker UI ASAP."')).toBe("Folder picker UI ASAP");
  });

  it("uses the first usable title line after reasoning wrappers", () => {
    const raw = [
      "<think>compare several options</think>",
      "```",
      '"Fix OAuth callback race."',
      "```",
    ].join("\n");
    expect(sanitizeGeneratedThreadTitle(raw)).toBe("Fix OAuth callback race");
  });

  it("rejects empty and generic generated titles", () => {
    expect(isUsableGeneratedThreadTitle("New thread")).toBe(false);
    expect(isUsableGeneratedThreadTitle("Conversation")).toBe(false);
    expect(isUsableGeneratedThreadTitle("Thread")).toBe(false);
    expect(isUsableGeneratedThreadTitle("OAuth callback race")).toBe(true);
  });

  it("builds bounded recent conversation context and skips streaming output", () => {
    const messages = [
      { role: "user" as const, text: "old objective" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: "assistant" as const,
        text: `old response ${index}`,
      })),
      { role: "user" as const, text: `current objective ${"x".repeat(9_000)}` },
      { role: "assistant" as const, text: "partial answer", streaming: true },
      { role: "assistant" as const, text: "finished answer" },
    ];

    const context = buildThreadTitleConversationContext(messages);

    expect(context).toContain("User: current objective");
    expect(context).toContain("Assistant: finished answer");
    expect(context).not.toContain("partial answer");
    expect(context).not.toContain("old objective");
    expect(context!.length).toBeLessThanOrEqual(THREAD_TITLE_CONTEXT_MAX_CHARS);
  });

  it("requires durable user context before generating a title", () => {
    expect(
      buildThreadTitleConversationContext([
        { role: "system", text: "system context" },
        { role: "assistant", text: "assistant only" },
      ]),
    ).toBeNull();
  });

  it("uses durable attachment metadata when a user turn has no text", () => {
    const context = buildThreadTitleConversationContext([
      {
        role: "user",
        text: "",
        attachments: [
          { type: "image", name: "auth-error.png" },
          { type: "file", name: "callback.log" },
        ],
      },
      { role: "assistant", text: "I inspected both attachments." },
    ]);

    expect(context).toContain("User: [image: auth-error.png] [file: callback.log]");
    expect(context).toContain("Assistant: I inspected both attachments.");
  });

  it("retains the latest user objective when long assistant output fills the budget", () => {
    const context = buildThreadTitleConversationContext([
      { role: "user", text: "Keep this current objective" },
      ...Array.from({ length: 11 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index} ${"x".repeat(2_000)}`,
      })),
    ]);

    expect(context).toContain("User: Keep this current objective");
    expect(context!.length).toBeLessThanOrEqual(THREAD_TITLE_CONTEXT_MAX_CHARS);
  });

  it("keeps distinguishing identifiers within the six-word cap", () => {
    expect(sanitizeGeneratedThreadTitle("PR #1234 Conflict Review and more extra")).toBe(
      "PR #1234 Conflict Review and more",
    );
  });

  it("detects the generic chat placeholder title", () => {
    expect(isGenericChatThreadTitle(" New thread ")).toBe(true);
    expect(isGenericChatThreadTitle("Manual rename")).toBe(false);
  });
});
