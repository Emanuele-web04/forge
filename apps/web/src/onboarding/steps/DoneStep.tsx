// FILE: DoneStep.tsx
// Purpose: Closing step of the welcome tour: the day-one shortcuts. The run summary lives
//          in the dialog header.
// Layer: Web UI component

import { TourShortcutList } from "./FeatureTourStep";

export function DoneStep() {
  return (
    <div className="flex flex-col gap-3.5 px-[120px]">
      <p className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium tracking-[0.04em] text-muted-foreground/70 uppercase">
        Shortcuts worth learning today
      </p>
      <TourShortcutList />
    </div>
  );
}
