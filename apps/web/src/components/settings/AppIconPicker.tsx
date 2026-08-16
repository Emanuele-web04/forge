// FILE: AppIconPicker.tsx
// Purpose: Render the visual desktop app-icon choices used by Appearance settings.
// Layer: Settings UI component

import type { DesktopAppIcon } from "@synara/contracts";
import { cn, isMacPlatform } from "~/lib/utils";

interface AppIconOption {
  readonly label: string;
  readonly src: string;
}

const APP_ICON_OPTIONS = {
  default: { label: "Default icon", src: "/app-icons/default.png" },
  icon: { label: "Icon", src: "/app-icons/icon-group-600-macos.png" },
  dark: { label: "Dark icon", src: "/app-icons/dark.png" },
} as const satisfies Record<DesktopAppIcon, AppIconOption>;

const MAC_DESKTOP_APP_ICONS = ["default", "icon", "dark"] as const;
const OTHER_DESKTOP_APP_ICONS = ["default", "icon"] as const;

export function desktopAppIconsForPlatform(platform: string): ReadonlyArray<DesktopAppIcon> {
  return isMacPlatform(platform) ? MAC_DESKTOP_APP_ICONS : OTHER_DESKTOP_APP_ICONS;
}

export function AppIconPicker({
  platform,
  value,
  onValueChange,
}: {
  readonly platform: string;
  readonly value: DesktopAppIcon;
  readonly onValueChange: (value: DesktopAppIcon) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="App icon">
      {desktopAppIconsForPlatform(platform).map((icon) => {
        const option = APP_ICON_OPTIONS[icon];
        const selected = value === icon;
        return (
          <button
            key={icon}
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
            onClick={() => onValueChange(icon)}
          >
            <img src={option.src} alt="" draggable={false} className="size-10 object-contain" />
          </button>
        );
      })}
    </div>
  );
}
