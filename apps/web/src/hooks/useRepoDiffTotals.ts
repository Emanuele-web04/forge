// FILE: useRepoDiffTotals.ts
// Purpose: Resolve the working-tree diff totals (+additions / -deletions) for the
//          currently selected repo diff scope. Shared by the chat-header diff toggle
//          badge and the Environment panel "Changes" row so both read the same numbers.
// Layer: Chat git data hook

import { useQuery } from "@tanstack/react-query";

import { gitWorkingTreeDiffStatsQueryOptions } from "~/lib/gitReactQuery";
import { useRepoDiffScopeCwdSync, useRepoDiffScopeStore } from "~/repoDiffScopeStore";

export interface RepoDiffTotals {
  additions: number;
  deletions: number;
  /** Number of files touched in the selected scope. */
  fileCount: number;
  /** True when the working tree has any insertions or deletions in the selected scope. */
  hasChanges: boolean;
}

export function useRepoDiffTotals({
  gitCwd,
  isGitRepo,
  refetchInterval: refetchIntervalProp,
}: {
  gitCwd: string | null;
  isGitRepo: boolean;
  refetchInterval?: number | false;
}): RepoDiffTotals {
  const refetchInterval = refetchIntervalProp ?? false;
  useRepoDiffScopeCwdSync(gitCwd);
  // Match the Diff panel source selector so every surface shows the selected scope.
  const repoDiffScope = useRepoDiffScopeStore((store) => store.scope);
  const repoDiffCompareRef = useRepoDiffScopeStore((store) => store.compareRef);
  // Counts only. These poll every few seconds during a live turn, and the patch they used to
  // be derived from grows with the working tree, so fetching it here made a large diff cost
  // megabytes of transfer plus a main-thread reparse per poll. The server counts the same
  // patch it would have sent, so the displayed numbers are unchanged.
  const { data: totals } = useQuery(
    gitWorkingTreeDiffStatsQueryOptions({
      cwd: gitCwd,
      scope: repoDiffScope,
      compareRef: repoDiffCompareRef,
      enabled: isGitRepo,
      refetchInterval,
    }),
  );
  const additions = totals?.additions ?? 0;
  const deletions = totals?.deletions ?? 0;
  const fileCount = totals?.fileCount ?? 0;
  return { additions, deletions, fileCount, hasChanges: additions > 0 || deletions > 0 };
}
