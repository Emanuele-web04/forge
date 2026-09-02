// FILE: threadWorkspace.test.ts
// Purpose: Verifies workspace-root containment used to attribute dev servers to projects.
// Layer: Shared runtime utility tests
// Depends on: Vitest and threadWorkspace helpers

import { describe, expect, it } from "vitest";
import {
  isScratchWorkspacePath,
  isWorkspaceRootWithin,
  normalizeWorkspaceRootForComparison,
  SCRATCH_WORKSPACES_DIRNAME,
  workspaceRootsEqual,
} from "./threadWorkspace";

describe("isWorkspaceRootWithin", () => {
  it("treats an identical root as contained", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app", "/Users/dev/app")).toBe(true);
  });

  it("treats a nested path as contained", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app/apps/web", "/Users/dev/app")).toBe(true);
  });

  it("ignores trailing slashes and separator style", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app/apps/web/", "/Users/dev/app/")).toBe(true);
  });

  it("does not match a sibling that shares a name prefix", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app-extra", "/Users/dev/app")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(isWorkspaceRootWithin("/Users/dev/other", "/Users/dev/app")).toBe(false);
  });

  it("does not match when the candidate is an ancestor of the root", () => {
    expect(isWorkspaceRootWithin("/Users/dev", "/Users/dev/app")).toBe(false);
  });

  it("keeps a Windows drive root distinct from a drive-relative path", () => {
    const options = { platform: "win32" } as const;
    expect(normalizeWorkspaceRootForComparison("C:\\", options)).toBe("c:/");
    expect(normalizeWorkspaceRootForComparison("C:", options)).toBe("c:");
    expect(workspaceRootsEqual("C:", "C:\\", options)).toBe(false);
    expect(isWorkspaceRootWithin("C:\\repo", "C:\\", options)).toBe(true);
  });

  it("returns false for empty inputs", () => {
    expect(isWorkspaceRootWithin("", "/Users/dev/app")).toBe(false);
    expect(isWorkspaceRootWithin("/Users/dev/app", "")).toBe(false);
  });
});

describe("isScratchWorkspacePath", () => {
  it("matches absolute paths inside a per-thread scratch workspace", () => {
    expect(
      isScratchWorkspacePath(`/private/tmp/${SCRATCH_WORKSPACES_DIRNAME}/thread-1/report.pdf`),
    ).toBe(true);
    expect(
      isScratchWorkspacePath(`/tmp/${SCRATCH_WORKSPACES_DIRNAME}/thread-1/nested/img.png`),
    ).toBe(true);
  });

  it("matches Windows-style absolute paths with backslashes", () => {
    expect(
      isScratchWorkspacePath(`C:\\Temp\\${SCRATCH_WORKSPACES_DIRNAME}\\thread-1\\report.pdf`),
    ).toBe(true);
  });

  it("does not match relative paths even when they contain the segment", () => {
    expect(isScratchWorkspacePath(`${SCRATCH_WORKSPACES_DIRNAME}/thread-1/report.pdf`)).toBe(false);
    expect(isScratchWorkspacePath(`work/${SCRATCH_WORKSPACES_DIRNAME}/report.pdf`)).toBe(false);
  });

  it("does not match absolute paths without the scratch segment", () => {
    expect(isScratchWorkspacePath("/Users/dev/Documents/report.pdf")).toBe(false);
  });

  it("does not match when the dirname is the final segment", () => {
    expect(isScratchWorkspacePath(`/tmp/${SCRATCH_WORKSPACES_DIRNAME}`)).toBe(false);
  });

  it("does not match a directory name that merely shares the prefix", () => {
    expect(isScratchWorkspacePath(`/tmp/${SCRATCH_WORKSPACES_DIRNAME}-extra/file.pdf`)).toBe(false);
  });
});
