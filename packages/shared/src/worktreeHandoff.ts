export type WorktreeHandoffIntent =
  | {
      kind: "create-new";
      worktreeName: string;
      baseBranch: string | null;
    }
  | {
      kind: "reuse-associated";
      associatedWorktreePath: string | null;
      associatedWorktreeBranch: string | null;
      associatedWorktreeRef: string | null;
      baseBranch: string | null;
    };

export interface WorktreeHandoffWorkspaceMetadata {
  readonly envMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
  readonly createBranchFlowCompleted?: false;
}

export function resolveWorktreeHandoffWorkspaceMetadata(input: {
  readonly targetMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
}): WorktreeHandoffWorkspaceMetadata {
  return {
    envMode: input.targetMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
    associatedWorktreePath: input.associatedWorktreePath,
    associatedWorktreeBranch: input.associatedWorktreeBranch,
    associatedWorktreeRef: input.associatedWorktreeRef,
    ...(input.targetMode === "worktree" ? { createBranchFlowCompleted: false } : {}),
  };
}

export function hasAssociatedWorktree(input: {
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
}): boolean {
  return Boolean(
    input.associatedWorktreePath ?? input.associatedWorktreeBranch ?? input.associatedWorktreeRef,
  );
}

export function resolveWorktreeHandoffIntent(input: {
  preferredNewWorktreeName?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
  preferredWorktreeBaseBranch?: string | null;
  currentBranch?: string | null;
}): WorktreeHandoffIntent | null {
  const normalizedWorktreeName = input.preferredNewWorktreeName?.trim() ?? "";
  const baseBranch = input.preferredWorktreeBaseBranch ?? input.currentBranch ?? null;

  if (normalizedWorktreeName.length > 0) {
    return {
      kind: "create-new",
      worktreeName: normalizedWorktreeName,
      baseBranch,
    };
  }

  if (!hasAssociatedWorktree(input)) {
    return null;
  }

  return {
    kind: "reuse-associated",
    associatedWorktreePath: input.associatedWorktreePath ?? null,
    associatedWorktreeBranch: input.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: input.associatedWorktreeRef ?? null,
    baseBranch,
  };
}
