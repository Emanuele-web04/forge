import { describe, expect, it } from "vitest";

import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
  workspaceRelativePathOf,
} from "./path";

describe("isWorkspaceRelativePathSafe", () => {
  it("accepts plain workspace-relative paths", () => {
    expect(isWorkspaceRelativePathSafe("src/app.ts")).toBe(true);
    expect(isWorkspaceRelativePathSafe("docs")).toBe(true);
    expect(isWorkspaceRelativePathSafe("a/b/c.txt")).toBe(true);
  });

  it("rejects traversal segments", () => {
    expect(isWorkspaceRelativePathSafe("..")).toBe(false);
    expect(isWorkspaceRelativePathSafe("../../etc/passwd")).toBe(false);
    expect(isWorkspaceRelativePathSafe("src/../../etc")).toBe(false);
    expect(isWorkspaceRelativePathSafe("..\\windows")).toBe(false);
    expect(isWorkspaceRelativePathSafe("./src")).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isWorkspaceRelativePathSafe("/etc/passwd")).toBe(false);
    expect(isWorkspaceRelativePathSafe("C:\\Windows")).toBe(false);
    expect(isWorkspaceRelativePathSafe("\\\\server\\share")).toBe(false);
  });

  it("rejects empty and whitespace-only values", () => {
    expect(isWorkspaceRelativePathSafe("")).toBe(false);
    expect(isWorkspaceRelativePathSafe("   ")).toBe(false);
  });
});

describe("workspaceRelativePathOf", () => {
  it("strips the workspace root from contained absolute paths", () => {
    expect(workspaceRelativePathOf("/repo/app/src/page.tsx", "/repo/app")).toBe("src/page.tsx");
    expect(workspaceRelativePathOf("/repo/app/readme.md", "/repo/app/")).toBe("readme.md");
  });

  it("returns null for paths outside the root or the root itself", () => {
    expect(workspaceRelativePathOf("/repo/other/src/page.tsx", "/repo/app")).toBeNull();
    expect(workspaceRelativePathOf("/repo/app", "/repo/app")).toBeNull();
    expect(workspaceRelativePathOf("/repo/application/file.ts", "/repo/app")).toBeNull();
  });

  it("normalizes Windows separators and path casing", () => {
    expect(workspaceRelativePathOf("C:\\Repo\\App\\Src\\Page.tsx", "c:/repo/app")).toBe(
      "Src/Page.tsx",
    );
  });

  it("compares normalized UNC paths case-insensitively", () => {
    expect(
      workspaceRelativePathOf("//Server/Share/Repo/Src/Page.tsx", "\\\\server\\share\\repo"),
    ).toBe("Src/Page.tsx");
  });

  it("derives Windows relative paths from segments after length-changing case folds", () => {
    expect(workspaceRelativePathOf("C:\\İ\\secret", "c:\\i̇")).toBe("secret");
  });

  it("keeps POSIX path comparisons case-sensitive", () => {
    expect(workspaceRelativePathOf("/Repo/App/src/page.tsx", "/repo/app")).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(workspaceRelativePathOf("", "/repo/app")).toBeNull();
    expect(workspaceRelativePathOf("/repo/app/file.ts", "  ")).toBeNull();
  });
});

describe("isLocalAbsolutePath", () => {
  it("recognizes POSIX and Windows absolute paths", () => {
    expect(isLocalAbsolutePath("/Users/dev/file.txt")).toBe(true);
    expect(isLocalAbsolutePath("C:\\Users\\dev\\file.txt")).toBe(true);
  });

  it("rejects a drive-relative Windows path", () => {
    expect(isLocalAbsolutePath("C:")).toBe(false);
  });

  it("can disable Windows path recognition for native POSIX server reads", () => {
    expect(isLocalAbsolutePath("C:\\Users\\dev\\file.txt", { allowWindowsPaths: false })).toBe(
      false,
    );
  });
});

describe("joinWorkspaceRelativePath", () => {
  it("joins with the root's separator style", () => {
    expect(joinWorkspaceRelativePath("/repo/app", "src/page.tsx")).toBe("/repo/app/src/page.tsx");
    expect(joinWorkspaceRelativePath("/repo/app/", "readme.md")).toBe("/repo/app/readme.md");
    expect(joinWorkspaceRelativePath("C:\\repo\\app", "src/page.tsx")).toBe(
      "C:\\repo\\app\\src\\page.tsx",
    );
  });

  it("round-trips through workspaceRelativePathOf", () => {
    const joined = joinWorkspaceRelativePath("/repo/app", "src/page.tsx");
    expect(workspaceRelativePathOf(joined, "/repo/app")).toBe("src/page.tsx");
  });
});
