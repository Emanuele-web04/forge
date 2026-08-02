// FILE: RaceCandidateBanner.tsx
// Purpose: Sticky Keep-this banner for Model Race candidate chat surfaces.
// Layer: Chat UI component
// Exports: RaceCandidateBanner

import type { ThreadId } from "@synara/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import {
  selectRaceSessionForThread,
  useRaceSessionStore,
  type RaceSession,
} from "../../race/raceSessionStore";
import { cn } from "../../lib/utils";

export function RaceCandidateBanner(props: {
  threadId: ThreadId;
  onKeep: (session: RaceSession) => Promise<void> | void;
  onOpenCandidate?: (threadId: ThreadId) => void;
  className?: string;
}) {
  const session = useRaceSessionStore((state) => selectRaceSessionForThread(state, props.threadId));
  const [keeping, setKeeping] = useState(false);

  if (!session || session.winnerThreadId) {
    return null;
  }

  const candidateIndex = session.candidates.findIndex(
    (candidate) => candidate.threadId === props.threadId,
  );
  if (candidateIndex < 0) {
    return null;
  }

  const candidate = session.candidates[candidateIndex]!;
  const modelLabel =
    formatProviderModelOptionName({
      provider: candidate.modelSelection.provider,
      slug: candidate.modelSelection.model,
    }) || candidate.modelSelection.model;

  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur-sm",
        props.className,
      )}
    >
      <div className="min-w-0 flex-1 text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">
          Race · {candidateIndex + 1}/{session.candidates.length}
        </span>
        <span className="mx-1.5 text-muted-foreground/50">·</span>
        <span className="truncate">{modelLabel}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {session.candidates.map((other, index) => {
          if (other.threadId === props.threadId) {
            return null;
          }
          const otherLabel =
            formatProviderModelOptionName({
              provider: other.modelSelection.provider,
              slug: other.modelSelection.model,
            }) || `Model ${index + 1}`;
          return (
            <Button
              key={other.threadId}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => props.onOpenCandidate?.(other.threadId)}
            >
              {otherLabel}
            </Button>
          );
        })}
        <Button
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={keeping}
          onClick={() => {
            setKeeping(true);
            void Promise.resolve(props.onKeep(session)).finally(() => setKeeping(false));
          }}
        >
          {keeping ? "Keeping…" : "Keep this"}
        </Button>
      </div>
    </div>
  );
}
