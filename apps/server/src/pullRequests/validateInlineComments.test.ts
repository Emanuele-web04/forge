import { describe, expect, it } from "vitest";

import { validateInlineComments } from "./validateInlineComments";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,4 @@",
  " context",
  "-old",
  "+new",
  " context",
  "--- looks like a header",
  "+++ also looks like a header",
  "diff --git a/src/deleted.ts b/src/deleted.ts",
  "--- a/src/deleted.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
].join("\n");

describe("validateInlineComments", () => {
  it("accepts changed lines on their GitHub diff side", () => {
    expect(
      validateInlineComments(patch, [
        { id: "left", path: "src/a.ts", line: 11, side: "LEFT" },
        { id: "right", path: "src/a.ts", line: 11, side: "RIGHT" },
        { id: "deleted", path: "src/deleted.ts", line: 1, side: "LEFT" },
        { id: "header-left", path: "src/a.ts", line: 13, side: "LEFT" },
        { id: "header-right", path: "src/a.ts", line: 13, side: "RIGHT" },
        { id: "context-left", path: "src/a.ts", line: 10, side: "LEFT" },
        { id: "context-right", path: "src/a.ts", line: 10, side: "RIGHT" },
      ]),
    ).toEqual([]);
  });

  it("returns every invalid draft id without dropping valid drafts", () => {
    expect(
      validateInlineComments(patch, [
        { id: "valid", path: "src/a.ts", line: 11, side: "RIGHT" },
        { id: "wrong-side", path: "src/deleted.ts", line: 1, side: "RIGHT" },
        { id: "context", path: "src/a.ts", line: 10, side: "RIGHT" },
        { id: "missing", path: "src/missing.ts", line: 1, side: "RIGHT" },
      ]),
    ).toEqual(["wrong-side", "missing"]);
  });
});
