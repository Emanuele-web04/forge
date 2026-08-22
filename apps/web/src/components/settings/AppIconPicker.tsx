// FILE: AppIconPicker.tsx
// Purpose: Render the visual desktop app-icon choices used by Appearance settings.
// Layer: Settings UI component

import { useState } from "react";

import type { DesktopAppIcon } from "@synara/contracts";
import { Spinner } from "~/components/ui/spinner";
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
  readonly onValueChange: (value: DesktopAppIcon) => void | Promise<void>;
}) {
  const [pendingIcon, setPendingIcon] = useState<DesktopAppIcon | null>(null);
  const busy = pendingIcon !== null;

  return (
    <div className="flex items-center gap-1" role="group" aria-label="App icon" aria-busy={busy}>
      {desktopAppIconsForPlatform(platform).map((icon) => {
        const option = APP_ICON_OPTIONS[icon];
        const selected = value === icon;
        const applying = pendingIcon === icon;
        return (
          <button
            key={icon}
            type="button"
            title={option.label}
            aria-label={option.label}
            aria-pressed={selected}
            disabled={busy}
            className={cn(
              // Same selection language as ThemeModePicker: the artwork is the whole
              // control, so no filled tile — just a stroke that appears when selected.
              "relative grid place-items-center rounded-[14px] border-2 p-[3px] transition-colors motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none",
              selected || applying
                ? "border-foreground"
                : "border-transparent hover:border-foreground/25",
            )}
            onClick={() => {
              if (busy) return;
              setPendingIcon(icon);
              void (async () => {
                try {
                  await onValueChange(icon);
                } catch {
                  // Native preference synchronization owns rollback. The picker
                  // only owns its transient loading state.
                } finally {
                  setPendingIcon((current) => (current === icon ? null : current));
                }
              })();
            }}
          >
            <img
              src={option.src}
              alt=""
              draggable={false}
              className={cn("size-10 object-contain", applying && "opacity-40")}
            />
            {applying ? (
              <Spinner
                aria-label="Updating app icon"
                className="absolute size-4 text-foreground motion-reduce:animate-none"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
