import type { GitBranch } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveAssociatedWorktreeMetadataAfterWorkspacePatch,
  resolveDraftEnvModeAfterBranchChange,
  resolveFixedLocalWorkspacePatch,
  resolveBranchToolbarValue,
  shouldSyncLocalThreadBranch,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.synara/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base branch before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a branch already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.synara/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });

  it("keeps legacy .synara worktree paths working for migrated threads", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.synara/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveFixedLocalWorkspacePatch", () => {
  it("preserves the selected folder for branch-only updates", () => {
    expect(
      resolveFixedLocalWorkspacePatch({
        currentWorkingDirectory: "/repo/current",
        patch: { branch: "feature/demo", worktreePath: null },
      }),
    ).toEqual({
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: "/repo/current",
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      createBranchFlowCompleted: false,
    });
  });

  it("uses an existing worktree selection as the next concrete folder", () => {
    expect(
      resolveFixedLocalWorkspacePatch({
        currentWorkingDirectory: "/repo/current",
        patch: {
          branch: "feature/demo",
          worktreePath: "/repo/.worktrees/feature-demo",
        },
      }),
    ).toMatchObject({
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: "/repo/.worktrees/feature-demo",
    });
  });

  it("honors an explicit working-directory clear", () => {
    expect(
      resolveFixedLocalWorkspacePatch({
        currentWorkingDirectory: "/repo/current",
        patch: { workingDirectory: null },
      }).workingDirectory,
    ).toBeNull();
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git branch when no explicit base branch is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base branch", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out branch when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("shouldSyncLocalThreadBranch", () => {
  it("syncs stale local thread metadata to the concrete git checkout", () => {
    expect(
      shouldSyncLocalThreadBranch({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "synara/pi",
        currentGitBranch: "main",
        hasServerThread: true,
        isThreadSettled: false,
        isBranchActionPending: false,
      }),
    ).toBe(true);
  });

  it("does not sync while a branch action is pending", () => {
    expect(
      shouldSyncLocalThreadBranch({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "synara/pi",
        currentGitBranch: "main",
        hasServerThread: true,
        isThreadSettled: false,
        isBranchActionPending: true,
      }),
    ).toBe(false);
  });

  it("does not materialize the git checkout branch into an intentionally branchless local draft", () => {
    expect(
      shouldSyncLocalThreadBranch({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
        hasServerThread: false,
        isThreadSettled: false,
        isBranchActionPending: false,
      }),
    ).toBe(false);
  });

  it("syncs missing branch metadata for local server threads", () => {
    expect(
      shouldSyncLocalThreadBranch({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
        hasServerThread: true,
        isThreadSettled: false,
        isBranchActionPending: false,
      }),
    ).toBe(true);
  });

  it("keeps explicit base branch selection in new-worktree mode", () => {
    expect(
      shouldSyncLocalThreadBranch({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
        hasServerThread: true,
        isThreadSettled: false,
        isBranchActionPending: false,
      }),
    ).toBe(false);
  });

  it("keeps the last branch on a settled thread until it is resumed", () => {
    expect(
      shouldSyncLocalThreadBranch({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/finished",
        currentGitBranch: "feature/current",
        hasServerThread: true,
        isThreadSettled: true,
        isBranchActionPending: false,
      }),
    ).toBe(false);
  });
});

describe("resolveAssociatedWorktreeMetadataAfterWorkspacePatch", () => {
  it("preserves associated worktree metadata during local branch-only syncs", () => {
    expect(
      resolveAssociatedWorktreeMetadataAfterWorkspacePatch({
        branch: "main",
        worktreePath: null,
        existingAssociatedWorktreePath: "/repo/.worktrees/synara-pi",
        existingAssociatedWorktreeBranch: "synara/pi",
        existingAssociatedWorktreeRef: "synara/pi",
      }),
    ).toEqual({
      associatedWorktreePath: "/repo/.worktrees/synara-pi",
      associatedWorktreeBranch: "synara/pi",
      associatedWorktreeRef: "synara/pi",
    });
  });

  it("derives associated metadata from an active worktree checkout", () => {
    expect(
      resolveAssociatedWorktreeMetadataAfterWorkspacePatch({
        branch: "feature/worktree",
        worktreePath: "/repo/.worktrees/feature-worktree",
        existingAssociatedWorktreePath: "/repo/.worktrees/old",
        existingAssociatedWorktreeBranch: "old",
        existingAssociatedWorktreeRef: "old",
      }),
    ).toEqual({
      associatedWorktreePath: "/repo/.worktrees/feature-worktree",
      associatedWorktreeBranch: "feature/worktree",
      associatedWorktreeRef: "feature/worktree",
    });
  });

  it("lets explicit associated branch patches update the associated ref", () => {
    expect(
      resolveAssociatedWorktreeMetadataAfterWorkspacePatch({
        branch: "main",
        worktreePath: null,
        existingAssociatedWorktreePath: "/repo/.worktrees/synara-pi",
        existingAssociatedWorktreeBranch: "synara/pi",
        existingAssociatedWorktreeRef: "synara/pi",
        patchAssociatedWorktreeBranch: "feature/new-pair",
      }),
    ).toEqual({
      associatedWorktreePath: "/repo/.worktrees/synara-pi",
      associatedWorktreeBranch: "feature/new-pair",
      associatedWorktreeRef: "feature/new-pair",
    });
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: GitBranch[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: GitBranch[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected branch", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.synara/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: "/repo/.synara/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.synara/worktrees/feature-b",
      nextWorktreePath: "/repo/.synara/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the branch already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.synara/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default branch in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.synara/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default branches", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.synara/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.synara/worktrees/feature-a",
      nextWorktreePath: "/repo/.synara/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});
