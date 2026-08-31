import { describe, expect, it } from "vitest";

import { parseGitBlamePorcelain } from "./gitBlameParsing.ts";

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const ZERO_SHA = "0".repeat(40);

describe("git blame porcelain parsing", () => {
  it("parses a committed line", () => {
    const stdout = [
      `${SHA} 12 12 1`,
      "author Ada Lovelace",
      "author-mail <ada@example.com>",
      "author-time 1700000000",
      "author-tz +0100",
      "committer Someone Else",
      "committer-mail <else@example.com>",
      "committer-time 1700000005",
      "committer-tz +0100",
      "summary Teach the engine to count",
      "previous 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c src/engine.ts",
      "filename src/engine.ts",
      "\tconst total = count(items);",
      "",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)).toEqual({
      sha: SHA,
      shortSha: "1a2b3c4",
      author: "Ada Lovelace",
      authorEmail: "ada@example.com",
      authorTime: new Date(1_700_000_000_000).toISOString(),
      summary: "Teach the engine to count",
      uncommitted: false,
    });
  });

  it("flags the all-zero sha as uncommitted and drops the placeholder summary", () => {
    const stdout = [
      `${ZERO_SHA} 4 4 1`,
      "author Not Committed Yet",
      "author-mail <not.committed.yet>",
      "author-time 1700000100",
      "author-tz +0000",
      "summary Version of src/engine.ts from src/engine.ts",
      "filename src/engine.ts",
      "\tconst pending = true;",
      "",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)).toMatchObject({
      sha: ZERO_SHA,
      shortSha: "",
      author: "Not Committed Yet",
      authorEmail: "not.committed.yet",
      summary: "",
      uncommitted: true,
    });
  });

  it("keeps summary text that itself looks like a porcelain field", () => {
    const stdout = [
      `${SHA} 1 1 1`,
      "author Ada Lovelace",
      "author-mail <ada@example.com>",
      "author-time 1700000000",
      "summary author-time handling for blame",
      "filename src/engine.ts",
      "\tvalue",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)?.summary).toBe("author-time handling for blame");
  });

  it("does not treat tz or committer fields as the author", () => {
    const stdout = [
      `${SHA} 1 1 1`,
      "author-tz +0530",
      "committer Not The Author",
      "author Ada Lovelace",
      "author-time 1700000000",
      "\tvalue",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)?.author).toBe("Ada Lovelace");
  });

  it("ignores content lines that follow the blame header", () => {
    const stdout = [
      `${SHA} 1 1 1`,
      "author Ada Lovelace",
      "author-time 1700000000",
      "summary Real summary",
      "\tauthor Fake Author",
      "\tsummary Fake summary",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)).toMatchObject({
      author: "Ada Lovelace",
      summary: "Real summary",
    });
  });

  it("returns null when no blame header is present", () => {
    expect(parseGitBlamePorcelain("fatal: no such path\n")).toBeNull();
    expect(parseGitBlamePorcelain("")).toBeNull();
  });

  it("returns an empty timestamp when author-time is unparsable", () => {
    const stdout = [
      `${SHA} 1 1 1`,
      "author Ada Lovelace",
      "author-time not-a-number",
      "summary Broken clock",
      "\tvalue",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)?.authorTime).toBe("");
  });

  it("parses SHA-256 repository object IDs", () => {
    const sha256 = "a".repeat(64);
    const zeroSha256 = "0".repeat(64);
    const stdout = [
      `${sha256} 2 2 1`,
      "author Ada Lovelace",
      "author-mail <ada@example.com>",
      "author-time 1700000000",
      "summary Hash stretched",
      "\tvalue",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)).toMatchObject({
      sha: sha256,
      shortSha: "aaaaaaa",
      uncommitted: false,
    });
    expect(parseGitBlamePorcelain(`${zeroSha256} 3 3 1\nauthor x\n\tvalue\n`)?.uncommitted).toBe(
      true,
    );
  });

  it("returns an empty timestamp when author-time is outside the Date range", () => {
    const stdout = [
      `${SHA} 1 1 1`,
      "author Ada Lovelace",
      "author-time 99999999999999999999",
      "summary Clock broke",
      "\tvalue",
    ].join("\n");

    expect(parseGitBlamePorcelain(stdout)?.authorTime).toBe("");
  });
});
