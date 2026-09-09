import { describe, expect, it } from "vitest";

import {
  FILE_PREVIEW_FIND_MAX_MATCHES,
  anchorFilePreviewMatchIndex,
  collectFilePreviewMatches,
  filePreviewMatchCountLabel,
  lineIndexForOffset,
  stepFilePreviewFindIndex,
} from "./filePreviewFind.logic";

describe("collectFilePreviewMatches", () => {
  it("finds case-insensitive substrings with stable indexes", () => {
    expect(collectFilePreviewMatches("Error: failed with error", "ERROR")).toEqual([
      { index: 0, startOffset: 0, endOffset: 5 },
      { index: 1, startOffset: 19, endOffset: 24 },
    ]);
  });

  it("caps reported matches", () => {
    const contents = "aa".repeat(FILE_PREVIEW_FIND_MAX_MATCHES + 5);
    const matches = collectFilePreviewMatches(contents, "aa");
    expect(matches).toHaveLength(FILE_PREVIEW_FIND_MAX_MATCHES);
    expect(matches.at(-1)?.index).toBe(FILE_PREVIEW_FIND_MAX_MATCHES - 1);
  });
});

describe("stepFilePreviewFindIndex", () => {
  it("wraps next and previous", () => {
    expect(stepFilePreviewFindIndex(3, 0, "next")).toBe(1);
    expect(stepFilePreviewFindIndex(3, 2, "next")).toBe(0);
    expect(stepFilePreviewFindIndex(3, 0, "previous")).toBe(2);
  });
});

describe("anchorFilePreviewMatchIndex", () => {
  const matches = collectFilePreviewMatches("one two one", "one");

  it("keeps the exact prior offset when still present", () => {
    expect(anchorFilePreviewMatchIndex(matches, { startOffset: 8, endOffset: 11 })).toBe(1);
  });

  it("falls back to the nearest offset after a live edit", () => {
    expect(anchorFilePreviewMatchIndex(matches, { startOffset: 7, endOffset: 10 })).toBe(1);
  });

  it("returns -1 when there are no matches", () => {
    expect(anchorFilePreviewMatchIndex([], { startOffset: 0, endOffset: 1 })).toBe(-1);
  });
});

describe("lineIndexForOffset", () => {
  it("counts newlines before the offset", () => {
    expect(lineIndexForOffset("a\nb\nc", 0)).toBe(0);
    expect(lineIndexForOffset("a\nb\nc", 2)).toBe(1);
    expect(lineIndexForOffset("a\nb\nc", 4)).toBe(2);
  });
});

describe("filePreviewMatchCountLabel", () => {
  it("formats empty, miss, hit, and capped counts", () => {
    expect(
      filePreviewMatchCountLabel({
        query: "",
        matchCount: 0,
        activeIndex: -1,
        capped: false,
      }),
    ).toBe("");
    expect(
      filePreviewMatchCountLabel({
        query: "x",
        matchCount: 0,
        activeIndex: -1,
        capped: false,
      }),
    ).toBe("No results");
    expect(
      filePreviewMatchCountLabel({
        query: "x",
        matchCount: 3,
        activeIndex: 1,
        capped: false,
      }),
    ).toBe("2 / 3");
    expect(
      filePreviewMatchCountLabel({
        query: "x",
        matchCount: FILE_PREVIEW_FIND_MAX_MATCHES,
        activeIndex: 0,
        capped: true,
      }),
    ).toBe(`1 / ${FILE_PREVIEW_FIND_MAX_MATCHES}+`);
  });
});
