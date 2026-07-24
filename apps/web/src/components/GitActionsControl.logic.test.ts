import type { GitStatusResult } from "@synara/contracts";
import { assert, describe, it } from "vitest";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  requiresFeatureBranchForDefaultBranchAction,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveCreatePrActionAvailability,
  resolveDefaultCreateBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolvePullActionAvailability,
  resolveQuickAction,
  shouldOfferCreateBranchPrompt,
  summarizeGitResult,
} from "./GitActionsControl.logic";

function statusPr(
  overrides: Partial<NonNullable<GitStatusResult["pr"]>> = {},
): NonNullable<GitStatusResult["pr"]> {
  return {
    number: 10,
    title: "Open PR",
    url: "https://example.com/pr/10",
    baseBranch: "main",
    headBranch: "feature/test",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: null,
    deletions: null,
    changedFiles: null,
    ...overrides,
  };
}

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    branch: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    upstreamBranch: "feature/test",
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("when: branch is clean and has an open PR", () => {
  it("resolveQuickAction opens the existing PR", () => {
    const quick = resolveQuickAction(
      status({
        pr: statusPr({ number: 10, title: "Open PR", url: "https://example.com/pr/10" }),
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "open_pr", label: "View PR", disabled: false });
  });

  it("buildMenuItems disables commit/push and enables open PR", () => {
    const items = buildMenuItems(
      status({
        pr: statusPr({ number: 11, title: "Existing PR", url: "https://example.com/pr/11" }),
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: actions are busy", () => {
  it("resolveQuickAction returns running disabled state", () => {
    const quick = resolveQuickAction(status(), true);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git action in progress.",
    });
  });

  it("buildMenuItems disables all actions", () => {
    const items = buildMenuItems(status(), true);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: git status is unavailable", () => {
  it("resolveQuickAction returns unavailable disabled state", () => {
    const quick = resolveQuickAction(null, false);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git status is unavailable.",
    });
  });

  it("buildMenuItems returns no menu items", () => {
    const items = buildMenuItems(null, false);
    assert.deepEqual(items, []);
  });
});

describe("when: branch is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: statusPr({ number: 13, title: "Open PR", url: "https://example.com/pr/13" }),
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });

  it("buildMenuItems enables push and keeps open PR available", () => {
    const items = buildMenuItems(
      status({
        aheadCount: 2,
        pr: statusPr({ number: 12, title: "Existing PR", url: "https://example.com/pr/12" }),
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: branch is clean, ahead, and has no open PR", () => {
  it("resolveQuickAction pushes and creates a PR", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, pr: null }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
    });
  });

  it("buildMenuItems enables push and create PR, with commit disabled", () => {
    const items = buildMenuItems(status({ aheadCount: 2, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch is clean, up to date, and has no open PR", () => {
  it("resolveQuickAction returns disabled commit on a published feature branch", () => {
    const quick = resolveQuickAction(
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, pr: null }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
    });
  });

  it("buildMenuItems enables create PR for a published feature branch", () => {
    const items = buildMenuItems(status({ aheadCount: 0, behindCount: 0, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction keeps disabled commit when the branch tracks the default branch", () => {
    const quick = resolveQuickAction(
      status({
        branch: "synara/pi-cleanup",
        upstreamBranch: "main",
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      false,
      false,
      true,
      false,
      "main",
    );

    assert.deepEqual(quick, {
      kind: "show_hint",
      label: "Commit",
      hint: "Branch is up to date. No action needed.",
      disabled: true,
    });
  });

  it("resolveCreatePrActionAvailability blocks stale create-pr calls for default upstream", () => {
    const availability = resolveCreatePrActionAvailability({
      gitStatus: status({
        branch: "synara/pi-cleanup",
        upstreamBranch: "main",
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      defaultBranchName: "main",
    });

    assert.deepEqual(availability, {
      canRun: false,
      hint: "No branch changes to include in a PR.",
    });
  });

  it("resolveCreatePrActionAvailability allows clean published feature branches", () => {
    const availability = resolveCreatePrActionAvailability({
      gitStatus: status({
        branch: "feature/test",
        upstreamBranch: "feature/test",
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      defaultBranchName: "main",
    });

    assert.deepEqual(availability, {
      canRun: true,
      hint: null,
    });
  });

  it("buildMenuItems disables create PR when the branch tracks the default branch", () => {
    const items = buildMenuItems(
      status({
        branch: "synara/pi-cleanup",
        upstreamBranch: "main",
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      false,
      true,
      false,
      "main",
    );

    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction keeps disabled commit when the upstream branch name is unknown", () => {
    const quick = resolveQuickAction(
      status({
        upstreamBranch: null,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      false,
    );

    assert.deepEqual(quick, {
      kind: "show_hint",
      label: "Commit",
      hint: "Branch is up to date. No action needed.",
      disabled: true,
    });
  });
});

describe("when: branch is behind upstream", () => {
  it("resolveQuickAction returns pull", () => {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false);
    assert.deepInclude(quick, { kind: "run_pull", label: "Pull", disabled: false });
  });

  it("resolvePullActionAvailability enables pull", () => {
    const availability = resolvePullActionAvailability({
      gitStatus: status({ behindCount: 2 }),
      isBusy: false,
    });

    assert.deepEqual(availability, { canRun: true, hint: null });
  });

  it("buildMenuItems disables push and create PR", () => {
    const items = buildMenuItems(status({ behindCount: 1, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch has diverged from upstream", () => {
  it("resolveQuickAction returns a disabled sync hint", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, behindCount: 1 }), false);
    assert.deepEqual(quick, {
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });

  it("resolvePullActionAvailability blocks fast-forward pull", () => {
    const availability = resolvePullActionAvailability({
      gitStatus: status({ aheadCount: 2, behindCount: 1 }),
      isBusy: false,
    });

    assert.deepEqual(availability, {
      canRun: false,
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });
});

describe("when: branch is up to date", () => {
  it("resolvePullActionAvailability disables pull", () => {
    const availability = resolvePullActionAvailability({
      gitStatus: status({ aheadCount: 0, behindCount: 0 }),
      isBusy: false,
    });

    assert.deepEqual(availability, {
      canRun: false,
      hint: "Branch is already up to date.",
    });
  });
});

describe("when: working tree has local changes", () => {
  it("resolveQuickAction returns commit, push, and create PR", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });

  it("resolveQuickAction falls back to commit when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit",
      label: "Commit",
      disabled: false,
    });
  });

  it("resolveQuickAction hides create-branch when the caller opts out", () => {
    const quick = resolveQuickAction(
      status({ branch: "worktree/semantic-name", hasUpstream: false }),
      false,
      false,
      true,
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction shows create-branch when the caller opts in", () => {
    const quick = resolveQuickAction(
      status({ branch: "worktree/semantic-name", hasUpstream: false }),
      false,
      false,
      true,
      true,
    );
    assert.deepInclude(quick, {
      kind: "create_branch",
      label: "Create Branch",
      disabled: false,
    });
  });

  it("resolveQuickAction returns commit and push when open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: statusPr({ number: 16, title: "Existing PR", url: "https://example.com/pr/16" }),
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("buildMenuItems enables commit and disables push and PR", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "commit_push",
        label: "Commit & push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "commit_push",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: on default branch without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("resolveQuickAction returns push when branch is ahead", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", aheadCount: 2, pr: null }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("buildMenuItems enables commit-and-push row when local changes exist on default branch", () => {
    const items = buildMenuItems(
      status({ branch: "main", hasWorkingTreeChanges: true, aheadCount: 0, pr: null }),
      false,
      true,
      true,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Commit & push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "commit_push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems uses commit-and-push row on default branch", () => {
    const items = buildMenuItems(
      status({ branch: "main", aheadCount: 2, pr: null }),
      false,
      true,
      true,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Commit & push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "commit_push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("does not enable create PR on a clean default branch with nothing new to publish", () => {
    const items = buildMenuItems(
      status({ branch: "main", aheadCount: 0, behindCount: 0, pr: null }),
      false,
      true,
      true,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Commit & push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "commit_push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: working tree has local changes and branch is behind upstream", () => {
  it("resolveQuickAction automatically prefers pulling before commit or push flows", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, behindCount: 1 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_pull",
      label: "Pull",
      disabled: false,
    });
  });

  it("buildMenuItems enables commit and keeps push and PR disabled", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, behindCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "commit_push",
        label: "Commit & push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "commit_push",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: HEAD is detached and there are no local changes", () => {
  it("resolveQuickAction shows detached head hint", () => {
    const quick = resolveQuickAction(
      status({ branch: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("resolveQuickAction offers to attach the managed worktree to a branch", () => {
    const quick = resolveQuickAction(
      status({ branch: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
      false,
      true,
      true,
    );
    assert.deepEqual(quick, {
      label: "Create Branch",
      disabled: false,
      kind: "create_branch",
    });
  });

  it("buildMenuItems keeps commit, push, and PR disabled", () => {
    const items = buildMenuItems(status({ branch: null, hasWorkingTreeChanges: false }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch has no upstream configured", () => {
  it("resolveQuickAction is disabled when clean, no upstream, and no local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, pr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: statusPr({ number: 14, title: "Existing PR", url: "https://example.com/pr/14" }),
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: statusPr({ number: 15, title: "Existing PR", url: "https://example.com/pr/15" }),
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems disables push and create PR when no commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 0 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction disables push-and-pr flows when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "show_hint",
      label: "Push",
      hint: 'Add an "origin" remote before pushing or creating a PR.',
      disabled: true,
    });
  });

  it("buildMenuItems enables create PR when no upstream and commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems disables push and create PR when no origin remote exists", () => {
    const items = buildMenuItems(
      status({ hasUpstream: false, pr: null, aheadCount: 2 }),
      false,
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction is disabled on default branch when no upstream exists and no commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        branch: "main",
        hasUpstream: false,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction uses push-only on default branch when no upstream exists and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        branch: "main",
        hasUpstream: false,
        aheadCount: 1,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("buildMenuItems still disables push and create PR when branch is behind", () => {
    const items = buildMenuItems(
      status({
        branch: "main",
        hasUpstream: false,
        behindCount: 1,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
      true,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Commit & push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "commit_push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default branch", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
  });
});

describe("requiresFeatureBranchForDefaultBranchAction", () => {
  it("requires feature branches for PR actions on the default branch", () => {
    assert.isFalse(requiresFeatureBranchForDefaultBranchAction("push"));
    assert.isFalse(requiresFeatureBranchForDefaultBranchAction("commit_push"));
    assert.isTrue(requiresFeatureBranchForDefaultBranchAction("create_pr"));
    assert.isTrue(requiresFeatureBranchForDefaultBranchAction("commit_push_pr"));
  });
});

describe("resolveDefaultBranchActionDialogCopy", () => {
  it("uses push-only copy when pushing without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("uses push-and-pr copy when creating a PR without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Create feature branch & PR?",
      description: `Pull requests can't be opened from "main" into itself. This action will create a feature branch from your current commits, push it, and create the PR.`,
      continueLabel: "Create feature branch & continue",
    });
  });

  it("keeps commit copy when the action includes a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: true,
    });

    assert.deepEqual(copy, {
      title: "Create feature branch, commit & PR?",
      description: `Pull requests can't be opened from "main" into itself. This action will create a feature branch, commit your changes there, push it, and create the PR.`,
      continueLabel: "Create feature branch & continue",
    });
  });
});

describe("buildGitActionProgressStages", () => {
  it("shows push-only stages for the dedicated push action", () => {
    const stages = buildGitActionProgressStages({
      action: "push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("shows push and pr stages when create-pr needs to publish first", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
      shouldPushBeforePr: true,
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test...", "Creating PR..."]);
  });

  it("shows only push progress when push-only is forced", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      forcePushOnly: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("skips commit stages for create-pr flow when push-only is forced", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      forcePushOnly: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test...", "Creating PR..."]);
  });

  it("includes commit stages for commit+push when working tree is dirty", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/test...",
    ]);
  });
});

describe("summarizeGitResult", () => {
  it("returns commit-focused toast for commit action", () => {
    const result = summarizeGitResult({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "0123456789abcdef",
        subject: "feat: add optimistic UI for git action button",
      },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
    });

    assert.deepEqual(result, {
      title: "Committed 0123456",
      description: "feat: add optimistic UI for git action button",
    });
  });

  it("returns push-focused toast for push action", () => {
    const result = summarizeGitResult({
      action: "commit_push",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "abcdef0123456789",
        subject: "fix: tighten quick action tooltip hover handling",
      },
      push: {
        status: "pushed",
        branch: "foo",
        upstreamBranch: "origin/foo",
      },
      pr: { status: "skipped_not_requested" },
    });

    assert.deepEqual(result, {
      title: "Pushed abcdef0 to origin/foo",
      description: "fix: tighten quick action tooltip hover handling",
    });
  });

  it("returns PR-focused toast for created PR action", () => {
    const result = summarizeGitResult({
      action: "commit_push_pr",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: ship github shortcuts",
      },
      push: {
        status: "pushed",
        branch: "foo",
      },
      pr: {
        status: "created",
        number: 42,
        title: "feat: ship github shortcuts and improve PR CTA in success toast",
      },
    });

    assert.deepEqual(result, {
      title: "Created PR #42",
      description: "feat: ship github shortcuts and improve PR CTA in success toast",
    });
  });

  it("truncates long description text", () => {
    const result = summarizeGitResult({
      action: "commit_push_pr",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "short subject",
      },
      push: { status: "pushed", branch: "foo" },
      pr: {
        status: "created",
        number: 99,
        title:
          "feat: this title is intentionally extremely long so we can validate that toast descriptions are truncated with an ellipsis suffix",
      },
    });

    assert.deepEqual(result, {
      title: "Created PR #99",
      description: "feat: this title is intentionally extremely long so we can validate t...",
    });
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred branch names when available", () => {
    const branch = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(branch, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a branch namespace", () => {
    const branch = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(branch, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred branch name already exists", () => {
    const branch = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(branch, "feature/fix-toast-copy-3");
  });

  it("treats existing branch names as case-insensitive for collision checks", () => {
    const branch = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(branch, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const branch = resolveAutoFeatureBranchName(["main"]);
    assert.equal(branch, "feature/update");
  });
});

describe("resolveDefaultCreateBranchName", () => {
  it("uses Synara as the default namespace", () => {
    const branch = resolveDefaultCreateBranchName(["main"], "fix toast copy");
    assert.equal(branch, "synara/fix-toast-copy");
  });

  it("normalizes an existing legacy synara namespace", () => {
    const branch = resolveDefaultCreateBranchName(["main"], "synara/refine-toolbar-actions");
    assert.equal(branch, "synara/refine-toolbar-actions");
  });

  it("preserves nested namespaces under Synara", () => {
    const branch = resolveDefaultCreateBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(branch, "synara/feature/refine-toolbar-actions");
  });

  it("increments suffix when the Synara branch already exists", () => {
    const branch = resolveDefaultCreateBranchName(
      ["main", "synara/fix-toast-copy", "synara/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(branch, "synara/fix-toast-copy-3");
  });

  it("falls back to synara/update when no preferred name is provided", () => {
    const branch = resolveDefaultCreateBranchName(["main"]);
    assert.equal(branch, "synara/update");
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("does not regress a semantic thread branch back to a temporary worktree branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/semantic-branch",
      gitStatus: status({ branch: "synara/deadbeef" }),
    });

    assert.equal(update, null);
  });

  it("accepts real branch changes", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old",
      gitStatus: status({ branch: "feature/new" }),
    });

    assert.deepEqual(update, { branch: "feature/new" });
  });

  it("does not treat pending branch discovery as out-of-sync with status", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: null,
      gitStatus: status({ branch: "main" }),
    });

    assert.equal(update, null);
  });
});

describe("shouldOfferCreateBranchPrompt", () => {
  const temporaryBranch = "synara/deadbeef";

  it("shows the create-branch prompt for detached managed worktrees", () => {
    assert.isTrue(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/detached",
        gitStatus: {
          branch: null,
          hasUpstream: false,
        },
      }),
    );
  });

  it("shows the create-branch prompt for temporary worktree branches without upstream", () => {
    assert.isTrue(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/feature-test",
        gitStatus: {
          branch: temporaryBranch,
          hasUpstream: false,
        },
      }),
    );
  });

  it("hides the create-branch prompt when the branch already has upstream", () => {
    assert.isFalse(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/feature-test",
        gitStatus: {
          branch: temporaryBranch,
          hasUpstream: true,
        },
      }),
    );
  });

  it("hides the create-branch prompt outside a worktree even when the branch is local-only", () => {
    assert.isFalse(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: null,
        gitStatus: {
          branch: temporaryBranch,
          hasUpstream: false,
        },
      }),
    );
  });

  it("hides the create-branch prompt once the current branch has been finalized", () => {
    assert.isFalse(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/feature-test",
        gitStatus: {
          branch: "feature/test",
          hasUpstream: false,
        },
        createBranchFlowCompleted: true,
      }),
    );
  });

  it("shows the create-branch prompt for a temporary worktree branch until the flow is completed", () => {
    assert.isTrue(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/feature-test",
        gitStatus: {
          branch: temporaryBranch,
          hasUpstream: false,
        },
        createBranchFlowCompleted: false,
      }),
    );
  });

  it("keeps the create-branch prompt visible for a semantic local-only branch until the flow is completed", () => {
    assert.isTrue(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/feature-test",
        gitStatus: {
          branch: "feature/test",
          hasUpstream: false,
        },
        createBranchFlowCompleted: false,
      }),
    );
  });

  it("keeps the create-branch prompt visible when the branch was auto-renamed locally but not finalized", () => {
    assert.isTrue(
      shouldOfferCreateBranchPrompt({
        activeWorktreePath: "/tmp/project/.worktrees/feature-test",
        gitStatus: {
          branch: "feature/test",
          hasUpstream: false,
        },
        createBranchFlowCompleted: false,
      }),
    );
  });
});
