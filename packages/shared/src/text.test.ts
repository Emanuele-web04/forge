// FILE: text.test.ts
// Purpose: Verifies the shared count-pluralization helper used across server and web.
// Layer: Shared runtime utility tests
// Depends on: Vitest and text helpers

import { describe, expect, it } from "vitest";
import { pluralize, splitsSurrogatePair, unicodeSafeEndOffset } from "./text";

describe("UTF-16 boundaries", () => {
  const text = "a📌b";

  it("detects only offsets inside a surrogate pair", () => {
    expect(splitsSurrogatePair(text, 1)).toBe(false);
    expect(splitsSurrogatePair(text, 2)).toBe(true);
    expect(splitsSurrogatePair(text, 3)).toBe(false);
  });

  it("moves an end offset back only when it splits a surrogate pair", () => {
    expect(unicodeSafeEndOffset(text, 0)).toBe(0);
    expect(unicodeSafeEndOffset(text, 1)).toBe(1);
    expect(unicodeSafeEndOffset(text, 2)).toBe(1);
    expect(unicodeSafeEndOffset(text, 3)).toBe(3);
    expect(unicodeSafeEndOffset(text, text.length)).toBe(text.length);
  });
});

describe("pluralize", () => {
  it("returns the singular form for a count of one", () => {
    expect(pluralize(1, "file")).toBe("file");
  });

  it("defaults the plural form to the singular plus 's'", () => {
    expect(pluralize(0, "file")).toBe("files");
    expect(pluralize(2, "file")).toBe("files");
  });

  it("uses an explicit plural for irregular forms", () => {
    expect(pluralize(1, "has", "have")).toBe("has");
    expect(pluralize(3, "has", "have")).toBe("have");
  });

  it("supports a noun-and-verb phrase as singular/plural", () => {
    expect(pluralize(1, "thread is", "threads are")).toBe("thread is");
    expect(pluralize(5, "thread is", "threads are")).toBe("threads are");
  });
});
