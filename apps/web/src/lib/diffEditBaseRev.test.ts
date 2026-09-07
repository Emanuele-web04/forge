import { describe, expect, it } from "vitest";

import { resolveDiffEditBaseRev } from "./diffEditBaseRev";

describe("resolveDiffEditBaseRev", () => {
  it("compares working-tree style scopes against HEAD", () => {
    expect(resolveDiffEditBaseRev("workingTree", null)).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("unstaged", null)).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("staged", null)).toEqual({ rev: "HEAD" });
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
