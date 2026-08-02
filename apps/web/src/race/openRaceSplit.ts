// FILE: openRaceSplit.ts
// Purpose: Build a multi-pane split view for Model Race candidates.
// Layer: Web UI helper
// Exports: openRaceSplitView

import type { ProjectId, ThreadId } from "@synara/contracts";
import { collectLeaves } from "../splitView.logic";
import { type SplitViewId, useSplitViewStore } from "../splitViewStore";

export function openRaceSplitView(input: {
  readonly ownerProjectId: ProjectId;
  readonly candidateThreadIds: readonly ThreadId[];
}): SplitViewId | null {
  const candidateThreadIds = input.candidateThreadIds.filter(Boolean);
  if (candidateThreadIds.length < 2) {
    return null;
  }

  const [first, second, third] = candidateThreadIds;
  const store = useSplitViewStore.getState();
  const splitViewId = store.createFromDrop({
    sourceThreadId: first!,
    ownerProjectId: input.ownerProjectId,
    droppedThreadId: second!,
    direction: "horizontal",
    side: "second",
  });

  if (third) {
    const splitView = store.splitViewsById[splitViewId];
    if (splitView) {
      const leaves = collectLeaves(splitView.root);
      const targetPaneId = leaves[1]?.id ?? leaves[0]?.id;
      if (targetPaneId) {
        store.dropThreadOnPane({
          splitViewId,
          targetPaneId,
          direction: "vertical",
          side: "second",
          threadId: third,
        });
      }
    }
  }

  return splitViewId;
}
