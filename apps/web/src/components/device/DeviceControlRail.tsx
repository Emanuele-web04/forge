// FILE: DeviceControlRail.tsx
// Purpose: Compact icon rail of hardware buttons below the phone bezel.
// Layer: Device pane presentation
// Exports: DeviceControlRail, DEVICE_RAIL_ITEMS

import type { DeviceHardwareButton } from "@synara/contracts";

import {
  CameraIcon,
  DeviceHomeIcon,
  DeviceLockIcon,
  DeviceVolumeDownIcon,
  DeviceVolumeUpIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface DeviceRailItem {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly Icon: LucideIcon;
  /** Absent for the screenshot action, which is not a hardware button. */
  readonly button?: DeviceHardwareButton;
}

/**
 * Grouped the way the hardware is: the two buttons that change what is on
 * screen, then the volume pair, then capture. A thin divider marks each seam.
 *
 * `rotate` is absent by design — it is a Simulator.app window command with no
 * HID usage and no simctl equivalent, so the backend cannot perform it.
 */
export interface DeviceRailGroup {
  readonly id: string;
  readonly items: readonly DeviceRailItem[];
}

export const DEVICE_RAIL_GROUPS: readonly DeviceRailGroup[] = [
  {
    id: "screen",
    items: [
      { id: "home", label: "Home", shortcut: "⌘⇧H", Icon: DeviceHomeIcon, button: "home" },
      { id: "lock", label: "Lock", shortcut: "⌘L", Icon: DeviceLockIcon, button: "lock" },
    ],
  },
  {
    id: "volume",
    items: [
      {
        id: "volume-up",
        label: "Volume up",
        shortcut: "⌘↑",
        Icon: DeviceVolumeUpIcon,
        button: "volume-up",
      },
      {
        id: "volume-down",
        label: "Volume down",
        shortcut: "⌘↓",
        Icon: DeviceVolumeDownIcon,
        button: "volume-down",
      },
    ],
  },
  {
    id: "capture",
    items: [{ id: "screenshot", label: "Save screenshot", Icon: CameraIcon }],
  },
];

/**
 * The rail's own height, exported so the panel can reserve a matching spacer
 * above the bezel and keep the *phone* optically centered rather than the
 * phone-plus-rail group. Buttons are size-7 (1.75rem) inside py-2 (0.5rem).
 */
export const DEVICE_RAIL_HEIGHT_CLASS = "h-[2.75rem] shrink-0";

export function DeviceControlRail(props: {
  disabled: boolean;
  onPressButton: (button: DeviceHardwareButton) => void;
  onScreenshot: () => void;
}) {
  return (
    <div className={cn("flex items-center justify-center gap-1", DEVICE_RAIL_HEIGHT_CLASS)}>
      {DEVICE_RAIL_GROUPS.map((group, groupIndex) => (
        <div key={group.id} className="flex items-center gap-0.5">
          {groupIndex > 0 ? (
            <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border" />
          ) : null}
          {group.items.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    disabled={props.disabled}
                    aria-label={item.label}
                    onClick={() =>
                      item.button ? props.onPressButton(item.button) : props.onScreenshot()
                    }
                    className={cn(
                      "flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none",
                      "transition-colors duration-220 motion-reduce:transition-none",
                      "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
                      "focus-visible:ring-1 focus-visible:ring-ring/60",
                      "disabled:pointer-events-none disabled:opacity-40",
                    )}
                  >
                    <item.Icon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top" sideOffset={6}>
                {item.shortcut ? `${item.label}  ${item.shortcut}` : item.label}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ))}
    </div>
  );
}
