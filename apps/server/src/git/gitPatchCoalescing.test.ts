import { describe, expect, it } from "vitest";

import {
  buildRecreatedFileDiff,
  removePatchSegmentsForPaths,
  splitGitPatchSegments,
} from "./gitPatchCoalescing";

const DELETED_X = [
  "diff --git a/x b/x",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/x",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-one",
  "",
].join("\n");

const CHANGED_Y = [
  "diff --git a/y b/y",
  "index 2222222..3333333 100644",
  "--- a/y",
  "+++ b/y",
  "@@ -1 +1 @@",
  "-diff --git a/z b/z",
  "+changed",
  "",
].join("\n");

describe("removePatchSegmentsForPaths", () => {
  it("drops only the segments for the named paths", () => {
    const combined = `${DELETED_X}${CHANGED_Y}`;
    expect(splitGitPatchSegments(combined)).toHaveLength(2);
    expect(removePatchSegmentsForPaths(combined, new Set(["x"]))).toBe(CHANGED_Y);
    expect(removePatchSegmentsForPaths(combined, new Set())).toBe(combined);
  });
});

describe("buildRecreatedFileDiff", () => {
  it("rewrites a no-index diff against a temporary copy as an in-place change", () => {
    const noIndex = [
      "diff --git a/tmp/base-copy b/x",
      "index 1111111..4444444 100644",
      "--- a/tmp/base-copy",
      "+++ b/x",
      "@@ -1 +1,2 @@",
      "-one",
      "+two",
      "+three",
      "",
    ].join("\n");
    expect(buildRecreatedFileDiff(noIndex, "x")).toEqual({
      patch: [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1,2 @@",
        "-one",
        "+two",
        "+three",
        "",
      ].join("\n"),
      insertions: 2,
      deletions: 1,
    });
  });

  it("returns null when git produced no text hunks", () => {
    expect(buildRecreatedFileDiff("Binary files a/tmp/base-copy and b/x differ\n", "x")).toBeNull();
  });
});
