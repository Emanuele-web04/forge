// FILE: TitlesStep.tsx
// Purpose: Onboarding question for opt-in automatic thread-title refresh (#1041).
//          Default stays off unless the user explicitly picks a mode here.
// Layer: Web UI component

import type { ThreadTitleRefreshMode } from "@synara/contracts";

import { useAppSettings } from "~/appSettings";
import { cn } from "~/lib/utils";

const OPTIONS: ReadonlyArray<{ value: ThreadTitleRefreshMode; label: string; hint: string }> = [
  {
    value: "off",
    label: "Keep titles as I write them",
    hint: "Nothing changes unless you rename a thread yourself.",
  },
  {
    value: "suggested",
    label: "Suggest fresh titles",
    hint: "Synara previews a new title when the topic drifts; you approve it.",
  },
  {
    value: "automatic",
    label: "Refresh titles automatically",
    hint: "Titles update on their own after real progress. Manual renames always win.",
  },
];

export function TitlesStep() {
  const { settings, updateSettings } = useAppSettings();
  const selected = settings.titleRefreshMode ?? "off";
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Thread title refresh">
      {OPTIONS.map((option) => {
        const active = selected === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn(
              "flex min-w-0 cursor-pointer items-start gap-3 rounded-[10px] border bg-popover px-3.5 py-3 text-start outline-none transition-colors motion-reduce:transition-none",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
              active
                ? "border-foreground ring-1 ring-foreground ring-inset"
                : "border-foreground/9 hover:border-foreground/25",
            )}
            onClick={() => updateSettings({ titleRefreshMode: option.value })}
          >
            <span
              aria-hidden
              className={cn(
                "mt-1 size-3.5 shrink-0 rounded-full border",
                active ? "border-foreground bg-foreground" : "border-foreground/30",
              )}
            />
            <span className="min-w-0">
              <span className="block text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
                {option.label}
              </span>
              <span className="mt-0.5 block text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/80">
                {option.hint}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
