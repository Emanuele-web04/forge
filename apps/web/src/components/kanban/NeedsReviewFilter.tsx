// FILE: NeedsReviewFilter.tsx
// Purpose: The v2-only "Needs review" toggle. Reads and writes the persisted
//          `kanbanNeedsReviewFilter` store flag directly, so the project board
//          and the overview render one identical control (component-level single
//          source, mirroring the disclosureMotion convention).
// Layer: Kanban UI component (store-aware)
// Exports: NeedsReviewFilter

import { Checkbox } from "../ui/checkbox";
import { useKanbanUiStore } from "../../kanbanUiStore";

export function NeedsReviewFilter() {
  const needsReviewEnabled = useKanbanUiStore((state) => state.kanbanNeedsReviewFilter);
  const setNeedsReviewEnabled = useKanbanUiStore((state) => state.setKanbanNeedsReviewFilter);
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground/80">
      <Checkbox
        checked={needsReviewEnabled}
        onCheckedChange={(checked) => setNeedsReviewEnabled(checked === true)}
      />
      Needs review
    </label>
  );
}
