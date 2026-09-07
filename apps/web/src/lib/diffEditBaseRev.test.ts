import { describe, expect, it } from "vitest";

import { resolveDiffEditBaseRev, resolveDiffFileEditMode } from "./diffEditBaseRev";

describe("resolveDiffEditBaseRev", () => {
  it("compares the working tree and staged scopes against HEAD", () => {
    expect(resolveDiffEditBaseRev("workingTree", null)).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("staged", null)).toEqual({ rev: "HEAD" });
  });

  it("compares the unstaged scope against the index", () => {
    expect(resolveDiffEditBaseRev("unstaged", null)).toEqual({ base: "index" });
  });

  it("lets the server resolve the branch scope base", () => {
    expect(resolveDiffEditBaseRev("branch", null)).toEqual({ base: "branch" });
    expect(resolveDiffEditBaseRev("branch", "ignored")).toEqual({ base: "branch" });
  });

  it("uses the compare ref for the ref scope", () => {
    expect(resolveDiffEditBaseRev("ref", "v1.2.0")).toEqual({ rev: "v1.2.0" });
    expect(resolveDiffEditBaseRev("ref", "  release  ")).toEqual({ rev: "release" });
  });

  it("falls back to HEAD when the ref scope has no ref", () => {
    expect(resolveDiffEditBaseRev("ref", null)).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("ref", "")).toEqual({ rev: "HEAD" });
  });
});

describe("resolveDiffFileEditMode", () => {
  it("opens a diff editor for working-tree-backed repo scopes", () => {
    expect(resolveDiffFileEditMode("repo", "workingTree")).toBe("diff");
    expect(resolveDiffFileEditMode("repo", "unstaged")).toBe("diff");
    expect(resolveDiffFileEditMode("repo", "branch")).toBe("diff");
    expect(resolveDiffFileEditMode("repo", "ref")).toBe("diff");
  });

  it("opens the plain editor where the diff editor cannot represent the scope", () => {
    expect(resolveDiffFileEditMode("repo", "staged")).toBe("file");
    expect(resolveDiffFileEditMode("turn", "workingTree")).toBe("file");
  });
});
