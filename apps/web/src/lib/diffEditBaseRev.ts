import type { RepoDiffScope } from "~/repoDiffScopeStore";

export type DiffEditBaseScope = RepoDiffScope | "ref";

export interface DiffEditBaseRev {
  rev?: string;
  mergeBaseWith?: string;
}

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
  upstreamBranch: string | null,
): DiffEditBaseRev {
  if (scope === "ref") {
    const trimmedRef = compareRef?.trim() ?? "";
    return trimmedRef.length > 0 ? { rev: trimmedRef } : { rev: "HEAD" };
  }
  if (scope === "branch") {
    const trimmedUpstream = upstreamBranch?.trim() ?? "";
    return trimmedUpstream.length > 0 ? { mergeBaseWith: trimmedUpstream } : { rev: "HEAD" };
  }
  return { rev: "HEAD" };
}
