// FILE: ComposerVoiceRecorderBar.tsx
// Purpose: Renders the expanded WhatsApp-style voice recorder UI inside the chat composer.
// Layer: Chat composer presentation
// Depends on: live waveform samples and caller-owned record/cancel/send actions.

import { useEffect, useRef, useState } from "react";

import { Loader2Icon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface ComposerVoiceRecorderBarProps {
  disabled?: boolean;
  durationLabel: string;
  isRecording: boolean;
  isTranscribing: boolean;
  waveformLevels: readonly number[];
  onDiscard: () => void;
  onStop: () => void;
}

const BAR_WIDTH_PX = 2;
const BAR_GAP_PX = 2;
const BAR_MIN_HEIGHT_PX = 3;
const BAR_MAX_HEIGHT_PX = 22;

export function ComposerVoiceRecorderBar(props: ComposerVoiceRecorderBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [visibleBarCount, setVisibleBarCount] = useState(96);

  useEffect(() => {
    const node = trackRef.current;
    if (!node) {
      return;
    }
    const computeVisibleBars = () => {
      const width = node.clientWidth;
      if (width <= 0) {
        return;
      }
      setVisibleBarCount(Math.max(8, Math.floor(width / (BAR_WIDTH_PX + BAR_GAP_PX))));
    };
    computeVisibleBars();
    const observer = new ResizeObserver(computeVisibleBars);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const visibleLevels = props.waveformLevels.slice(-visibleBarCount);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div ref={trackRef} className="relative flex h-7 min-w-0 flex-1 items-center overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-zinc-300 dark:border-zinc-700"
        />
        <div
          className="relative ml-auto flex h-full items-center"
          style={{ gap: `${BAR_GAP_PX}px` }}
        >
          {visibleLevels.map((level, index) => {
            const clamped = Math.max(0.04, Math.min(1, level));
            const height = Math.round(
              BAR_MIN_HEIGHT_PX + clamped * (BAR_MAX_HEIGHT_PX - BAR_MIN_HEIGHT_PX),
            );
            const positionFromRight = visibleLevels.length - index;
            return (
              <span
                key={positionFromRight}
                aria-hidden="true"
                className={cn(
                  "shrink-0 rounded-[1px] bg-zinc-900 dark:bg-zinc-100",
                  props.isTranscribing && "opacity-55",
                )}
                style={{
                  width: `${BAR_WIDTH_PX}px`,
                  height: `${height}px`,
                }}
              />
            );
          })}
        </div>
      </div>

      <span className="shrink-0 text-xs font-medium tabular-nums tracking-[0.02em] text-zinc-500 dark:text-zinc-400">
        {props.durationLabel}
      </span>

      <button
        type="button"
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-zinc-200/80 text-zinc-700 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/15 sm:h-7 sm:w-7"
        aria-label={props.isTranscribing ? "Transcribing voice note" : "Cancel voice recording"}
        disabled={props.disabled || props.isTranscribing}
        onClick={props.onDiscard}
      >
        {props.isTranscribing ? (
          <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
        ) : (
          <XIcon aria-hidden="true" className="size-3.5" />
        )}
      </button>

      <Button
        type="button"
        variant="prominent"
        size="icon-xs"
        className="size-7 rounded-full sm:size-7"
        aria-label={props.isTranscribing ? "Transcribing voice note" : "Stop voice recording"}
        disabled={props.disabled || props.isTranscribing}
        onClick={props.onStop}
      >
        {props.isTranscribing ? (
          <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
        ) : (
          <span aria-hidden="true" className="block size-2 rounded-[1px] bg-current" />
        )}
      </Button>
    </div>
  );
}
