import type { RepoDiffScope } from "~/repoDiffScopeStore";

export type DiffEditBaseScope = RepoDiffScope;

/**
 * Base side of an editable diff. The branch scope defers to the server so the
 * editor compares against exactly the base the branch diff itself used
 * (upstream merge base, or the fallback base when the branch has no upstream).
 */
export type DiffEditBaseRev = { rev: string } | { base: "branch" };

export interface DiffFileEditRequest {
  filePath: string;
  /**
   * Pre-change path for renamed/moved files: the base revision usually still
   * holds the file under its old name, so the base-side read must use it.
   */
  basePath?: string | undefined;
  mode: "diff" | "file";
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
  return { rev: "HEAD" };
}
