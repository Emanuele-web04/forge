import { describe, expect, it } from "vitest";

import {
  isWorkspaceSearchFilesystemPathQuery,
  resolveWorkspaceSearchFilesystemPath,
} from "./WorkspaceSearchPalette.logic";

describe("isWorkspaceSearchFilesystemPathQuery", () => {
  it("detects absolute and home-relative paths", () => {
    expect(isWorkspaceSearchFilesystemPathQuery("/Users/dev/notes/todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("~/notes/todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("~\\notes\\todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("C:\\Users\\dev\\notes\\todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("/Users/dev/notes/todo.md:12:3")).toBe(true);
  });

  it("rejects fuzzy search queries and bare home", () => {
    expect(isWorkspaceSearchFilesystemPathQuery("Composer")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("src/app.ts")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("~")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("   ")).toBe(false);
  });
});

describe("resolveWorkspaceSearchFilesystemPath", () => {
  const cwd = "/Users/tester/project";

  it("maps in-workspace absolute paths to workspace-relative form", () => {
    expect(resolveWorkspaceSearchFilesystemPath(`${cwd}/src/app.ts`, cwd)).toBe("src/app.ts");
    expect(resolveWorkspaceSearchFilesystemPath(`${cwd}/src/app.ts:42`, cwd)).toBe("src/app.ts");
  });

  it("keeps out-of-workspace absolute paths absolute", () => {
    expect(resolveWorkspaceSearchFilesystemPath("/Users/tester/notes/todo.md", cwd)).toBe(
      "/Users/tester/notes/todo.md",
    );
  });

  it("expands ~/ against the home inferred from cwd", () => {
    expect(resolveWorkspaceSearchFilesystemPath("~/notes/todo.md", cwd)).toBe(
      "/Users/tester/notes/todo.md",
    );
    expect(resolveWorkspaceSearchFilesystemPath("~/project/src/app.ts", cwd)).toBe("src/app.ts");
  });

  it("returns null when ~/ cannot be expanded", () => {
    expect(resolveWorkspaceSearchFilesystemPath("~/notes/todo.md", null)).toBeNull();
    expect(resolveWorkspaceSearchFilesystemPath("~/notes/todo.md", "/tmp/scratch")).toBeNull();
  });

  it("returns null for non-path queries", () => {
    expect(resolveWorkspaceSearchFilesystemPath("Composer", cwd)).toBeNull();
  });

  it("expands Windows home-relative paths from a Windows cwd", () => {
    expect(
      resolveWorkspaceSearchFilesystemPath("~\\notes\\todo.md", "C:\\Users\\tester\\project"),
    ).toBe("C:\\Users\\tester\\notes\\todo.md");
  });
});
