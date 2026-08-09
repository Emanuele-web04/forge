// FILE: AppIconPicker.tsx
// Purpose: Render the visual desktop app-icon choices used by Appearance settings.
// Layer: Settings UI component

import type { DesktopAppIcon } from "@synara/contracts";
import { cn } from "~/lib/utils";

const APP_ICON_OPTIONS = [
  { value: "default", label: "Default icon", src: "/app-icons/default.png" },
  { value: "icon", label: "Icon", src: "/app-icons/icon.png" },
] as const satisfies ReadonlyArray<{
  value: DesktopAppIcon;
  label: string;
  src: string;
}>;

export function AppIconPicker({
  value,
  onValueChange,
}: {
  readonly value: DesktopAppIcon;
  readonly onValueChange: (value: DesktopAppIcon) => void;
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label="App icon">
      {APP_ICON_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-label={option.label}
            aria-pressed={selected}
            className={cn(
              "relative size-16 rounded-[18px] border p-1.5 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-foreground bg-accent"
                : "border-border/70 bg-muted/30 hover:border-border hover:bg-muted/60",
            )}
            onClick={() => onValueChange(option.value)}
          >
            <img
              src={option.src}
              alt=""
              draggable={false}
              className="size-full rounded-[13px] object-cover"
            />
          </button>
        );
      })}
    </div>
  );
}
