// FILE: SidebarElapsedTimeLabel.tsx
// Purpose: Live "running for" label for sidebar thread rows. Ticks at 1s like the
// chat "Working for" header (same start timestamp, same formatter) so both agree;
// the clock only runs while its own row is working, never for idle rows.
// Exports: SidebarElapsedTimeLabel

import { useNowMs } from "~/hooks/useNowMs";
import type { SidebarThreadSummary } from "../types";
import {
  isThreadActivelyWorking,
  resolveThreadElapsedMs,
  resolveUrgentThreadTimeLabel,
  shouldShowThreadStartingLabel,
} from "./Sidebar.logic";

export function SidebarElapsedTimeLabel({
  thread,
  recencyLabel,
}: {
  thread: SidebarThreadSummary;
  /** Static relative-time fallback once the thread stops running. */
  recencyLabel: string | null;
}) {
  const running = isThreadActivelyWorking(thread) || thread.session?.status === "connecting";
  const nowMs = useNowMs(running, 1_000);
  const label = resolveUrgentThreadTimeLabel({
    elapsedMs: running ? resolveThreadElapsedMs(thread, nowMs) : null,
    isStarting: shouldShowThreadStartingLabel(thread),
    recencyLabel,
  });
  if (label === null) {
    return null;
  }
  return (
    <span className="shrink-0 text-muted-foreground/60 tabular-nums" title={label.title}>
      {label.text}
    </span>
  );
}
