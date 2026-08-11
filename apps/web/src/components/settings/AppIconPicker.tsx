// FILE: AppIconPicker.tsx
// Purpose: Render the visual desktop app-icon choices used by Appearance settings.
// Layer: Settings UI component

import type { DesktopAppIcon } from "@synara/contracts";
import { cn } from "~/lib/utils";

const APP_ICON_OPTIONS = [
  { value: "default", label: "Default icon", src: "/app-icons/default.png" },
  { value: "icon", label: "Icon", src: "/app-icons/icon-group-600-macos.png" },
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
    <div className="flex items-center gap-1" role="group" aria-label="App icon">
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
              // Same selection language as ThemeModePicker: the artwork is the whole
              // control, so no filled tile — just a stroke that appears when selected.
              "grid place-items-center rounded-[14px] border-2 p-[3px] transition-colors motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              selected ? "border-foreground" : "border-transparent hover:border-foreground/25",
            )}
            onClick={() => onValueChange(option.value)}
          >
            <img src={option.src} alt="" draggable={false} className="size-10 object-contain" />
          </button>
        );
      })}
    </div>
  );
}
