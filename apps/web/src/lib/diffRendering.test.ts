// FILE: diffRendering.test.ts
// Purpose: Verifies shared git patch helpers used by diff chrome and header badges.
// Layer: Web diff utility tests
// Depends on: Vitest and diffRendering helpers

import { describe, expect, it } from "vitest";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  compareDiffPaths,
  fileDiffStatsByPath,
  getRenderablePatch,
  isSymlinkFileDiff,
  resolveDiffCopyText,
  resolveFileDiffStatByChangedPath,
  resolveFileDiffPath,
  resolveFileDiffPrevPath,
  sortFileDiffsByPath,
  splitPatchIntoFileSegments,
  splitRepoRelativePath,
  summarizePatchTotals,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

const FILE_A_PATCH = [
  "diff --git a/a.ts b/a.ts",
  "index 0000001..0000002 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " const shared = 1;",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

const FILE_B_PATCH = [
  "diff --git a/b.ts b/b.ts",
  "index 0000003..0000004 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,1 +1,2 @@",
  " const b = 1;",
  "+const added = 2;",
].join("\n");

const FILE_B_PATCH_EDITED = FILE_B_PATCH.replace("const added = 2;", "const added = 3;");

describe("splitPatchIntoFileSegments", () => {
  it("splits a multi-file patch on file boundaries", () => {
    const segments = splitPatchIntoFileSegments(`${FILE_A_PATCH}\n${FILE_B_PATCH}`);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("a/a.ts");
    expect(segments[0]).not.toContain("a/b.ts");
    expect(segments[1]).toContain("a/b.ts");
  });

  it("returns a single-file patch unchanged", () => {
    expect(splitPatchIntoFileSegments(FILE_A_PATCH)).toEqual([FILE_A_PATCH]);
  });

  it("keeps leading metadata attached to the first segment", () => {
    const segments = splitPatchIntoFileSegments(`commit message\n${FILE_A_PATCH}\n${FILE_B_PATCH}`);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("commit message");
  });

  it("does not split on hunk lines that mention diff --git", () => {
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,1 +1,2 @@",
      " existing",
      "+diff --git is a header prefix",
    ].join("\n");

    expect(splitPatchIntoFileSegments(patch)).toEqual([patch]);
  });
});

describe("getRenderablePatch per-file cache keys", () => {
  it("keeps a file's render key stable when another file changes", () => {
    const before = getRenderablePatch(`${FILE_A_PATCH}\n${FILE_B_PATCH}`);
    const after = getRenderablePatch(`${FILE_A_PATCH}\n${FILE_B_PATCH_EDITED}`);
    if (before?.kind !== "files" || after?.kind !== "files") {
      throw new Error("expected parsed files");
    }

    const keyOf = (renderable: typeof before, path: string) => {
      const file = renderable.files.find((candidate) => resolveFileDiffPath(candidate) === path);
      if (!file) throw new Error(`missing ${path}`);
      return buildFileDiffRenderKey(file);
    };

    expect(keyOf(after, "a.ts")).toBe(keyOf(before, "a.ts"));
    expect(keyOf(after, "b.ts")).not.toBe(keyOf(before, "b.ts"));
  });

  it("parses the same files and stats as before splitting", () => {
    const patch = `${FILE_A_PATCH}\n${FILE_B_PATCH}`;
    const renderable = getRenderablePatch(patch);
    if (renderable?.kind !== "files") {
      throw new Error("expected parsed files");
    }

    expect(renderable.files.map((file) => resolveFileDiffPath(file))).toEqual(["a.ts", "b.ts"]);
    expect(summarizePatchTotals(patch)).toEqual({ additions: 2, deletions: 1, fileCount: 2 });
  });
});

describe("resolveDiffCopyText", () => {
  it("preserves the original patch content for clipboard writes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')\n";

    expect(resolveDiffCopyText(patch)).toBe(patch);
  });

  it("preserves mode-only metadata without reconstructing the patch", () => {
    const patch = [
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    expect(resolveDiffCopyText(patch)).toBe(patch);
  });

  it("preserves every line of a large patch without depending on mounted rows", () => {
    const bodyLines = Array.from({ length: 6000 }, (_, index) => `+line ${index + 1}`);
    const patch = [
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/big.txt",
      "@@ -0,0 +1,6000 @@",
      ...bodyLines,
      "",
    ].join("\n");

    expect(resolveDiffCopyText(patch)).toBe(patch);
  });

  it("does not expose empty or missing patches as copyable", () => {
    expect(resolveDiffCopyText(undefined)).toBeNull();
    expect(resolveDiffCopyText(" \n\t ")).toBeNull();
  });
});

describe("resolveFileDiffPrevPath", () => {
  const parseSingleFile = (patch: string) => {
    const renderable = getRenderablePatch(patch, "prev-path:test");
    if (renderable?.kind !== "files" || renderable.files.length !== 1) {
      throw new Error("expected one parsed file");
    }
    return renderable.files[0]!;
  };

  it("returns the old path only for renamed files", () => {
    const renamed = parseSingleFile(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 80%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "index 1111111..2222222 100644",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1,1 +1,1 @@",
        "-const value = 1;",
        "+const value = 2;",
        "",
      ].join("\n"),
    );
    expect(resolveFileDiffPath(renamed)).toBe("src/new.ts");
    expect(resolveFileDiffPrevPath(renamed)).toBe("src/old.ts");
  });

  it("reports no old path for added files, whose base side does not exist", () => {
    const added = parseSingleFile(
      [
        "diff --git a/src/added.ts b/src/added.ts",
        "new file mode 100644",
        "index 0000000..2222222",
        "--- /dev/null",
        "+++ b/src/added.ts",
        "@@ -0,0 +1,1 @@",
        "+const value = 1;",
        "",
      ].join("\n"),
    );
    expect(added.type).toBe("new");
    expect(resolveFileDiffPrevPath(added)).toBeNull();
  });

  it("reports no old path for in-place edits", () => {
    const changed = parseSingleFile(
      [
        "diff --git a/src/one.ts b/src/one.ts",
        "index 1111111..2222222 100644",
        "--- a/src/one.ts",
        "+++ b/src/one.ts",
        "@@ -1,1 +1,1 @@",
        "-const one = 1;",
        "+const one = 2;",
        "",
      ].join("\n"),
    );
    expect(resolveFileDiffPrevPath(changed)).toBeNull();
  });
});

describe("isSymlinkFileDiff", () => {
  const parseSingleFile = (patch: string) => {
    const renderable = getRenderablePatch(patch, "symlink:test");
    if (renderable?.kind !== "files" || renderable.files.length !== 1) {
      throw new Error("expected one parsed file");
    }
    return renderable.files[0]!;
  };

  it("recognizes changed and added symlinks by their git mode", () => {
    const changed = parseSingleFile(
      [
        "diff --git a/link b/link",
        "index 1111111..2222222 120000",
        "--- a/link",
        "+++ b/link",
        "@@ -1 +1 @@",
        "-old-target",
        "\\ No newline at end of file",
        "+new-target",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(isSymlinkFileDiff(changed)).toBe(true);
    const added = parseSingleFile(
      [
        "diff --git a/link b/link",
        "new file mode 120000",
        "index 0000000..2222222",
        "--- /dev/null",
        "+++ b/link",
        "@@ -0,0 +1 @@",
        "+target",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(isSymlinkFileDiff(added)).toBe(true);
  });

  it("treats regular files as editable", () => {
    const regular = parseSingleFile(
      [
        "diff --git a/src/one.ts b/src/one.ts",
        "index 1111111..2222222 100644",
        "--- a/src/one.ts",
        "+++ b/src/one.ts",
        "@@ -1,1 +1,1 @@",
        "-const one = 1;",
        "+const one = 2;",
        "",
      ].join("\n"),
    );
    expect(isSymlinkFileDiff(regular)).toBe(false);
  });
});

describe("file diff identity helpers", () => {
  const twoFilePatch = [
    "diff --git a/src/one.ts b/src/one.ts",
    "index 1111111..2222222 100644",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1,1 +1,1 @@",
    "-const one = 1;",
    "+const one = 2;",
    "diff --git a/src/two.ts b/src/two.ts",
    "index 3333333..4444444 100644",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -1,1 +1,1 @@",
    "-const two = 1;",
    "+const two = 2;",
    "",
  ].join("\n");

  it("strips a/ and b/ prefixes from parsed file paths", () => {
    const renderable = getRenderablePatch(twoFilePatch, "git-pane:test");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    const paths = renderable.files.map((file) => resolveFileDiffPath(file));
    expect(paths).toContain("src/one.ts");
    expect(paths).toContain("src/two.ts");
  });

  it("derives a unique, stable render key per file", () => {
    const renderable = getRenderablePatch(twoFilePatch, "git-pane:test");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    const keys = renderable.files.map((file) => buildFileDiffRenderKey(file));
    expect(new Set(keys).size).toBe(keys.length);
    // Re-parsing the same patch yields the same identity for selection persistence.
    const reparsed = getRenderablePatch(twoFilePatch, "git-pane:test");
    if (reparsed?.kind !== "files") return;
    expect(reparsed.files.map((file) => buildFileDiffRenderKey(file))).toEqual(keys);
  });

  it("keeps binary image diffs as renderable file rows", () => {
    const patch = [
      "diff --git a/assets/screenshot.png b/assets/screenshot.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/screenshot.png and b/assets/screenshot.png differ",
      "",
    ].join("\n");

    const renderable = getRenderablePatch(patch, "git-pane:binary-image");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    expect(renderable.files).toHaveLength(1);
    const [file] = renderable.files;
    expect(file).toBeDefined();
    if (!file) return;
    expect(resolveFileDiffPath(file)).toBe("assets/screenshot.png");
    expect(file.hunks).toEqual([]);
  });
});

describe("splitRepoRelativePath", () => {
  it("splits a nested path into a trailing-slash dir and leaf name", () => {
    expect(splitRepoRelativePath("src/components/Foo.tsx")).toEqual({
      dir: "src/components/",
      name: "Foo.tsx",
    });
  });

  it("treats a bare filename as having no directory", () => {
    expect(splitRepoRelativePath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("sortFileDiffsByPath", () => {
  it("preserves default-locale ordering and stable case, accent, and numeric ties", () => {
    const paths = [
      "File2.ts",
      "file02.ts",
      "file10.ts",
      "é.ts",
      "E.ts",
      "e.ts",
      "日本2.ts",
      "日本10.ts",
    ];
    const expected = paths.toSorted((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
    );
    expect(paths.toSorted(compareDiffPaths)).toEqual(expected);
    for (const left of paths) {
      for (const right of paths) {
        expect(Math.sign(compareDiffPaths(left, right))).toBe(
          Math.sign(left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })),
        );
      }
    }
  });

  const outOfOrderPatch = [
    "diff --git a/src/zebra.ts b/src/zebra.ts",
    "index 1111111..2222222 100644",
    "--- a/src/zebra.ts",
    "+++ b/src/zebra.ts",
    "@@ -1,1 +1,1 @@",
    "-const z = 1;",
    "+const z = 2;",
    "diff --git a/src/item10.ts b/src/item10.ts",
    "index 3333333..4444444 100644",
    "--- a/src/item10.ts",
    "+++ b/src/item10.ts",
    "@@ -1,1 +1,1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "diff --git a/src/item2.ts b/src/item2.ts",
    "index 5555555..6666666 100644",
    "--- a/src/item2.ts",
    "+++ b/src/item2.ts",
    "@@ -1,1 +1,1 @@",
    "-const b = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  it("orders files by natural path order without mutating the input", () => {
    const renderable = getRenderablePatch(outOfOrderPatch, "git-pane:sort");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    const original = [...renderable.files];
    const sorted = sortFileDiffsByPath(renderable.files);

    // Numeric-aware ordering keeps item2 before item10, and the input is untouched.
    expect(sorted.map((file) => resolveFileDiffPath(file))).toEqual([
      "src/item2.ts",
      "src/item10.ts",
      "src/zebra.ts",
    ]);
    expect(renderable.files).toEqual(original);
  });
});

describe("summarizePatchTotals", () => {
  it("summarizes additions and deletions from a single-file unified patch", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,4 @@",
      " const stable = true;",
      "-const oldValue = 1;",
      "+const newValue = 1;",
      "+const addedValue = 2;",
      " export { stable };",
      "",
    ].join("\n");

    expect(summarizePatchTotals(patch)).toEqual({ additions: 2, deletions: 1, fileCount: 1 });
  });

  it("includes the changed file count alongside additions and deletions", () => {
    const patch = [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1111111..2222222 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 1;",
      "+const b = 2;",
      "diff --git a/src/two.ts b/src/two.ts",
      "index 3333333..4444444 100644",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -0,0 +1,2 @@",
      "+const c = 3;",
      "+const d = 4;",
      "",
    ].join("\n");

    expect(summarizePatchTotals(patch)).toEqual({ additions: 3, deletions: 1, fileCount: 2 });
  });

  it("returns null when the patch has no file diffs", () => {
    expect(summarizePatchTotals(undefined)).toBeNull();
  });
});

describe("fileDiffStatsByPath", () => {
  it("builds per-file stats from a parsed patch", () => {
    const patch = [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1111111..2222222 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      "-const one = 1;",
      "+const one = 2;",
      " const stable = true;",
      "diff --git a/src/two.ts b/src/two.ts",
      "index 3333333..4444444 100644",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -0,0 +1,2 @@",
      "+const two = 2;",
      "+export { two };",
      "",
    ].join("\n");

    expect(fileDiffStatsByPath(patch)).toEqual(
      new Map([
        ["src/one.ts", { additions: 1, deletions: 1 }],
        ["src/two.ts", { additions: 2, deletions: 0 }],
      ]),
    );
  });
});

describe("resolveFileDiffStatByChangedPath", () => {
  it("matches absolute changed-file paths to repo-relative patch stats", () => {
    const stat = { additions: 2, deletions: 1 };
    const statsByPath = new Map([["apps/web/src/App.tsx", stat]]);

    expect(
      resolveFileDiffStatByChangedPath(
        statsByPath,
        "/Users/example/project/apps/web/src/App.tsx",
        2,
      ),
    ).toBe(stat);
  });

  it("does not reuse a sole parsed stat across unrelated files in a multi-file row", () => {
    const statsByPath = new Map([["src/only-patched.ts", { additions: 3, deletions: 0 }]]);

    expect(resolveFileDiffStatByChangedPath(statsByPath, "src/unrelated.ts", 2)).toBeUndefined();
  });

  it("keeps the single-file fallback when the visible row also has one changed file", () => {
    const stat = { additions: 1, deletions: 4 };
    const statsByPath = new Map([["src/generated-name.ts", stat]]);

    expect(resolveFileDiffStatByChangedPath(statsByPath, "provider-reported-name.ts", 1)).toBe(
      stat,
    );
  });

  it("avoids ambiguous basename matches", () => {
    const statsByPath = new Map([
      ["src/a/index.ts", { additions: 1, deletions: 0 }],
      ["src/b/index.ts", { additions: 0, deletions: 1 }],
    ]);

    expect(resolveFileDiffStatByChangedPath(statsByPath, "index.ts", 2)).toBeUndefined();
  });
});
