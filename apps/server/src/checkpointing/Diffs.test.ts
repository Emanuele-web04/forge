import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseCheckpointFilesFromUnifiedDiff, parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

describe("parseTurnDiffFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", async () => {
    expect(await Effect.runPromise(parseTurnDiffFilesFromUnifiedDiff(""))).toEqual([]);
  });

  it("parses per-file additions and deletions", async () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseTurnDiffFilesFromUnifiedDiff(diff))).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/b.ts", kind: "modified", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", async () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseTurnDiffFilesFromUnifiedDiff(diff))).toEqual([
      { path: "src/new.ts", kind: "renamed", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", async () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(await Effect.runPromise(parseTurnDiffFilesFromUnifiedDiff(diff))).toEqual([
      { path: "a.txt", kind: "modified", additions: 2, deletions: 1 },
    ]);
  });

  it("merges duplicate entries for the same file path", async () => {
    const diff = [
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "index 1111111..2222222 100644",
      "--- a/CLAUDE.md",
      "+++ b/CLAUDE.md",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "index 2222222..3333333 100644",
      "--- a/CLAUDE.md",
      "+++ b/CLAUDE.md",
      "@@ -4,2 +5,0 @@",
      "-three",
      "-four",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseTurnDiffFilesFromUnifiedDiff(diff))).toEqual([
      { path: "CLAUDE.md", kind: "modified", additions: 2, deletions: 3 },
    ]);
  });

  it("maps parsed file summaries into checkpoint files", async () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+extra",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "src/app.ts", kind: "modified", additions: 2, deletions: 1 },
    ]);
  });

  it("preserves deleted-file status in checkpoint summaries", async () => {
    const diff = [
      "diff --git a/src/removed.ts b/src/removed.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/removed.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
      "",
    ].join("\n");

    expect(await Effect.runPromise(parseCheckpointFilesFromUnifiedDiff(diff))).toEqual([
      { path: "src/removed.ts", kind: "deleted", additions: 0, deletions: 1 },
    ]);
  });
});
