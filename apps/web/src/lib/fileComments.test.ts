import { describe, expect, it } from "vitest";

import {
  appendFileCommentsToPrompt,
  buildFileCommentsPromptBlock,
  createFileCommentDraft,
  extractTrailingFileComments,
  FILE_COMMENT_TEXT_MAX_CHARS,
  formatFileCommentLabel,
  formatFileCommentRange,
  formatFileCommentTitleSeed,
  getFileCommentValidationError,
  normalizeFileCommentSelection,
  normalizeFileCommentText,
  type FileCommentSelection,
} from "./fileComments";

function makeSelection(overrides?: Partial<FileCommentSelection>): FileCommentSelection {
  return {
    path: "src/app.ts",
    startLine: 12,
    endLine: 12,
    text: "rename this helper",
    ...overrides,
  };
}

describe("fileComments", () => {
  it("normalizes comment text by stripping CRLF and edge whitespace", () => {
    expect(normalizeFileCommentText("  hello\r\nworld  \n\n")).toBe("hello\nworld");
    expect(normalizeFileCommentText("\n\n  \n")).toBe("");
  });

  it("validates path and text presence and length", () => {
    expect(getFileCommentValidationError(makeSelection())).toBeNull();
    expect(getFileCommentValidationError(makeSelection({ text: "   " }))).toBe("empty");
    expect(getFileCommentValidationError(makeSelection({ path: "  " }))).toBe("empty");
    expect(
      getFileCommentValidationError(
        makeSelection({ text: "x".repeat(FILE_COMMENT_TEXT_MAX_CHARS + 1) }),
      ),
    ).toBe("too-long");
  });

  it("normalizes a selection: trims path, clamps/orders lines, normalizes text", () => {
    expect(
      normalizeFileCommentSelection({
        path: "  src/app.ts  ",
        startLine: 9.8,
        endLine: 3,
        text: "  fix\r\nthis  ",
      }),
    ).toEqual({
      path: "src/app.ts",
      startLine: 9,
      endLine: 9,
      text: "fix\nthis",
    });
    expect(normalizeFileCommentSelection(makeSelection({ text: "" }))).toBeNull();
  });

  it("clamps a sub-1 start line up to 1 and keeps the end at/after the start", () => {
    expect(normalizeFileCommentSelection(makeSelection({ startLine: 0, endLine: 0 }))).toEqual({
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
      text: "rename this helper",
    });
  });

  it("creates a draft with an id from a valid selection only", () => {
    const draft = createFileCommentDraft(makeSelection({ startLine: 3, endLine: 5 }));
    expect(draft).not.toBeNull();
    expect(draft?.id).toBeTypeOf("string");
    expect(draft?.id.length).toBeGreaterThan(0);
    expect(draft).toMatchObject({
      path: "src/app.ts",
      startLine: 3,
      endLine: 5,
      text: "rename this helper",
    });
    expect(createFileCommentDraft(makeSelection({ text: "  " }))).toBeNull();
  });

  it("formats ranges, labels, and title seeds", () => {
    expect(formatFileCommentRange({ startLine: 5, endLine: 5 })).toBe("line 5");
    expect(formatFileCommentRange({ startLine: 3, endLine: 7 })).toBe("lines 3-7");
    expect(formatFileCommentLabel({ path: "a/b.ts", startLine: 3, endLine: 7 })).toBe(
      "a/b.ts lines 3-7",
    );
    expect(formatFileCommentTitleSeed(1)).toBe("File comment");
    expect(formatFileCommentTitleSeed(2)).toBe("File comments");
  });

  it("builds a numbered prompt block and skips invalid entries", () => {
    expect(
      buildFileCommentsPromptBlock([
        makeSelection({ path: "src/app.ts", startLine: 3, endLine: 5, text: "rename helper" }),
        makeSelection({ path: "src/util.ts", startLine: 8, endLine: 8, text: "guard null\nhere" }),
      ]),
    ).toBe(
      [
        "<file_comments>",
        "- src/app.ts lines 3-5:",
        "  rename helper",
        "",
        "- src/util.ts line 8:",
        "  guard null",
        "  here",
        "</file_comments>",
      ].join("\n"),
    );
    expect(buildFileCommentsPromptBlock([makeSelection({ text: "" })])).toBe("");
  });

  it("appends the block after prompt text, or returns the bare block/prompt", () => {
    expect(appendFileCommentsToPrompt("Investigate this", [makeSelection()])).toBe(
      [
        "Investigate this",
        "",
        "<file_comments>",
        "- src/app.ts line 12:",
        "  rename this helper",
        "</file_comments>",
      ].join("\n"),
    );
    expect(appendFileCommentsToPrompt("Investigate this", [])).toBe("Investigate this");
    expect(appendFileCommentsToPrompt("", [makeSelection()])).toBe(
      ["<file_comments>", "- src/app.ts line 12:", "  rename this helper", "</file_comments>"].join(
        "\n",
      ),
    );
  });

  it("extracts trailing file comments and the leading prompt text", () => {
    const prompt = appendFileCommentsToPrompt("Investigate this", [
      makeSelection({ path: "src/app.ts", startLine: 3, endLine: 5, text: "rename helper" }),
      makeSelection({ path: "src/util.ts", startLine: 8, endLine: 8, text: "guard null\nhere" }),
    ]);
    expect(extractTrailingFileComments(prompt)).toEqual({
      promptText: "Investigate this",
      comments: [
        { path: "src/app.ts", startLine: 3, endLine: 5, text: "rename helper" },
        { path: "src/util.ts", startLine: 8, endLine: 8, text: "guard null\nhere" },
      ],
    });
  });

  it("leaves prompt text untouched when there is no trailing block", () => {
    expect(extractTrailingFileComments("No comments here")).toEqual({
      promptText: "No comments here",
      comments: [],
    });
  });

  it("round-trips append -> extract for multi-line comment text", () => {
    const selections = [
      makeSelection({ path: "a.ts", startLine: 1, endLine: 2, text: "line one\nline two" }),
    ];
    const prompt = appendFileCommentsToPrompt("Do the thing", selections);
    const extracted = extractTrailingFileComments(prompt);
    expect(extracted.promptText).toBe("Do the thing");
    expect(extracted.comments).toEqual([
      { path: "a.ts", startLine: 1, endLine: 2, text: "line one\nline two" },
    ]);
  });
});
