// Purpose: Shared inherit/off/suggested/automatic picker for title refresh (#1041).
// Layer: Shared UI component.

import type { ThreadTitleRefreshMode } from "@synara/contracts";

import { cn } from "../lib/utils";

const MODE_OPTIONS: ReadonlyArray<{ value: ThreadTitleRefreshMode | null; label: string }> = [
  { value: null, label: "Inherit" },
  { value: "off", label: "Off" },
  { value: "suggested", label: "Suggested" },
  { value: "automatic", label: "Automatic" },
];

export function TitleRefreshModePicker({
  value,
  onChange,
}: {
  value: ThreadTitleRefreshMode | null;
  onChange: (mode: ThreadTitleRefreshMode | null) => void;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground">Automatic titles</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Automatic titles">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] font-medium",
              value === option.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
