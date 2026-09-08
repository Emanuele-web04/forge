import { describe, expect, it } from "vitest";
import { extractEditorGutterChanges } from "./editorGutterDiff";

const addedOnlyPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
  " const e = 5;",
  "",
].join("\n");

const deletionOnlyPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,3 @@",
  " const a = 1;",
  " const b = 2;",
  "-const c = 3;",
  "-const d = 4;",
  " const e = 5;",
  "",
].join("\n");

const modifiedPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 20;",
  " const c = 3;",
  " const d = 4;",
  "",
].join("\n");

const multiHunkPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "+const inserted = 0;",
  " const b = 2;",
  " const c = 3;",
  " const d = 4;",
  "@@ -20,6 +21,6 @@",
  " const t = 20;",
  " const u = 21;",
  "-const v = 22;",
  "+const v = 220;",
  " const w = 23;",
  " const x = 24;",
  " const y = 25;",
  "",
].join("\n");

const untrackedPatch = [
  "diff --git a/src/fresh.ts b/src/fresh.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/fresh.ts",
  "@@ -0,0 +1,3 @@",
  "+const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  "",
].join("\n");

describe("extractEditorGutterChanges", () => {
  it("marks an addition-only hunk as added", () => {
    expect(extractEditorGutterChanges(addedOnlyPatch, "src/app.ts").ranges).toEqual([
      { kind: "added", startLine: 2, endLine: 3 },
    ]);
  });

  it("collapses a deletion-only run into one marker anchored at the preceding line", () => {
    expect(extractEditorGutterChanges(deletionOnlyPatch, "src/app.ts").ranges).toEqual([
      { kind: "deleted", startLine: 2, endLine: 2 },
    ]);
  });

  it("marks a replaced line as modified", () => {
    expect(extractEditorGutterChanges(modifiedPatch, "src/app.ts").ranges).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
    ]);
  });

  it("reports every hunk in new-file line numbers", () => {
    expect(extractEditorGutterChanges(multiHunkPatch, "src/app.ts").ranges).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
      { kind: "modified", startLine: 23, endLine: 23 },
    ]);
  });

  it("matches an absolute preview path against repo-relative patch paths", () => {
    expect(extractEditorGutterChanges(addedOnlyPatch, "/Users/dev/repo/src/app.ts").ranges).toEqual(
      [{ kind: "added", startLine: 2, endLine: 3 }],
    );
  });

  it("returns nothing when the file is missing from the patch", () => {
    expect(extractEditorGutterChanges(addedOnlyPatch, "src/other.ts").ranges).toEqual([]);
  });

  it("returns nothing without a patch or a path", () => {
    expect(extractEditorGutterChanges(undefined, "src/app.ts").ranges).toEqual([]);
    expect(extractEditorGutterChanges("", "src/app.ts").ranges).toEqual([]);
    expect(extractEditorGutterChanges(addedOnlyPatch, null).ranges).toEqual([]);
  });

  it("covers a new file as one added range", () => {
    expect(extractEditorGutterChanges(untrackedPatch, "src/fresh.ts").ranges).toEqual([
      { kind: "added", startLine: 1, endLine: 3 },
    ]);
  });
});

describe("whole-file addition flag", () => {
  it("is true for a new file and false for an edited one", () => {
    expect(extractEditorGutterChanges(untrackedPatch, "src/fresh.ts").wholeFileAddition).toBe(true);
    expect(extractEditorGutterChanges(addedOnlyPatch, "src/app.ts").wholeFileAddition).toBe(false);
    expect(extractEditorGutterChanges(addedOnlyPatch, "src/missing.ts").wholeFileAddition).toBe(
      false,
    );
  });
});
