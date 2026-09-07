import type { RepoDiffScope } from "~/repoDiffScopeStore";

export type DiffEditBaseScope = RepoDiffScope;

/**
 * Base side of an editable diff. Server-resolved bases keep the editor on
 * exactly the tree the diff itself compared against: the branch diff's
 * upstream or fallback merge base, or the index for unstaged changes.
 */
export type DiffEditBaseRev = { rev: string } | { base: "branch" | "index" };

export type DiffFileEditMode = "diff" | "file";

export interface DiffFileEditRequest {
  filePath: string;
  /**
   * Pre-change path for renamed/moved files: the base revision usually still
   * holds the file under its old name, so the base-side read must use it.
   */
  basePath?: string | undefined;
  mode: DiffFileEditMode;
  baseRev: DiffEditBaseRev;
}

export function resolveDiffEditBaseRev(
  scope: DiffEditBaseScope,
  compareRef: string | null,
): DiffEditBaseRev {
  if (scope === "ref") {
    const trimmedRef = compareRef?.trim() ?? "";
    return trimmedRef.length > 0 ? { rev: trimmedRef } : { rev: "HEAD" };
  }
  if (scope === "branch") {
    return { base: "branch" };
  }
  if (scope === "unstaged") {
    return { base: "index" };
  }
  return { rev: "HEAD" };
}

/**
 * The diff editor always edits the working tree. Turn diffs (checkpoint
 * snapshots) and the staged scope (whose modified side is the index) cannot
 * be represented that way, so they open the plain file editor instead.
 */
export function resolveDiffFileEditMode(
  viewKind: "repo" | "turn",
  scope: DiffEditBaseScope,
): DiffFileEditMode {
  return viewKind === "turn" || scope === "staged" ? "file" : "diff";
}
