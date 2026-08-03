import { describe, expect, it } from "vitest";

import { resolveWorktreeHandoffWorkspaceMetadata } from "./worktreeHandoff";

describe("resolveWorktreeHandoffWorkspaceMetadata", () => {
  it("projects a completed worktree handoff into active thread workspace metadata", () => {
    expect(
      resolveWorktreeHandoffWorkspaceMetadata({
        targetMode: "worktree",
        branch: "feature/preview-root",
        worktreePath: "/repo/worktrees/preview-root",
        associatedWorktreePath: "/repo/worktrees/preview-root",
        associatedWorktreeBranch: "feature/preview-root",
        associatedWorktreeRef: "abc123",
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "feature/preview-root",
      worktreePath: "/repo/worktrees/preview-root",
      associatedWorktreePath: "/repo/worktrees/preview-root",
      associatedWorktreeBranch: "feature/preview-root",
      associatedWorktreeRef: "abc123",
      createBranchFlowCompleted: false,
    });
  });

  it("clears the active worktree path when handing back to local", () => {
    expect(
      resolveWorktreeHandoffWorkspaceMetadata({
        targetMode: "local",
        branch: "main",
        worktreePath: null,
        associatedWorktreePath: "/repo/worktrees/preview-root",
        associatedWorktreeBranch: "feature/preview-root",
        associatedWorktreeRef: "abc123",
      }),
    ).toEqual({
      envMode: "local",
      branch: "main",
      worktreePath: null,
      associatedWorktreePath: "/repo/worktrees/preview-root",
      associatedWorktreeBranch: "feature/preview-root",
      associatedWorktreeRef: "abc123",
    });
  });
});
