// FILE: DeviceControlRail.tsx
// Purpose: Slim icon toolbar of device actions below the phone bezel.
// Layer: Device pane presentation
// Exports: DeviceControlRail, DEVICE_RAIL_HEIGHT_CLASS, DEVICE_RAIL_GROUPS
//
// The rail carries the actions that have no home on the hardware itself:
// lock and volume moved onto the drawn side buttons of the bezel, where the
// real ones are, leaving this row for Home, capture, and the two session
// actions.

import {
  DeviceDetachIcon,
  DeviceHomeIcon,
  DevicePowerIcon,
  DeviceRecordIcon,
  DeviceRecordStopIcon,
  DeviceRotateIcon,
  DeviceShutterIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type DeviceRailAction = "home" | "screenshot" | "record" | "rotate" | "shutdown" | "detach";

export interface DeviceRailItem {
  readonly id: DeviceRailAction;
  readonly label: string;
  readonly shortcut?: string;
  readonly Icon: LucideIcon;
}

export interface DeviceRailGroup {
  readonly id: string;
  readonly items: readonly DeviceRailItem[];
}

/**
 * Grouped by what the action touches: what the device is showing, what leaves
 * the device as a file, and what ends the session. A thin divider marks each seam.
 *
 * Rotate turns the pane's picture, not the guest: CoreSimulator exposes no
 * orientation API, so the app inside keeps rendering portrait. The control is
 * still worth having — it is how you look at a landscape layout — and it is
 * named for what it actually turns.
 */
export const DEVICE_RAIL_GROUPS: readonly DeviceRailGroup[] = [
  {
    id: "screen",
    items: [
      { id: "home", label: "Home", shortcut: "⌘⇧H", Icon: DeviceHomeIcon },
      { id: "rotate", label: "Rotate view", Icon: DeviceRotateIcon },
    ],
  },
  {
    id: "capture",
    items: [
      { id: "screenshot", label: "Save screenshot", Icon: DeviceShutterIcon },
      { id: "record", label: "Record video", Icon: DeviceRecordIcon },
    ],
  },
  {
    id: "session",
    items: [
      { id: "shutdown", label: "Shut down simulator", Icon: DevicePowerIcon },
      { id: "detach", label: "Detach simulator", Icon: DeviceDetachIcon },
    ],
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
  recording: boolean;
  /** Rotation is a view transform, so it stays available mid-capture. */
  landscape: boolean;
  onAction: (action: DeviceRailAction) => void;
}) {
  return (
    <div className={cn("flex items-center justify-center gap-1", DEVICE_RAIL_HEIGHT_CLASS)}>
      {DEVICE_RAIL_GROUPS.map((group, groupIndex) => (
        <div key={group.id} className="flex items-center gap-0.5">
          {groupIndex > 0 ? (
            <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border" />
          ) : null}
          {group.items.map((item) => {
            const isRecordStop = item.id === "record" && props.recording;
            const Icon = isRecordStop ? DeviceRecordStopIcon : item.Icon;
            const label = isRecordStop ? "Stop recording" : item.label;
            const pressed =
              item.id === "record"
                ? props.recording
                : item.id === "rotate"
                  ? props.landscape
                  : null;

            return (
              <Tooltip key={item.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      disabled={props.disabled}
                      aria-label={label}
                      {...(pressed === null ? {} : { "aria-pressed": pressed })}
                      onClick={() => props.onAction(item.id)}
                      className={cn(
                        "flex size-7 cursor-pointer items-center justify-center rounded-md outline-none",
                        "transition-colors duration-220 motion-reduce:transition-none",
                        "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
                        "focus-visible:ring-1 focus-visible:ring-ring/60",
                        "disabled:pointer-events-none disabled:opacity-40",
                        // A recording in progress is the one state worth
                        // colouring: it keeps costing disk until it is stopped.
                        isRecordStop
                          ? "bg-destructive/12 text-destructive hover:bg-destructive/20 hover:text-destructive"
                          : pressed
                            ? "bg-[var(--color-background-button-secondary-hover)] text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="top" sideOffset={6}>
                  {item.shortcut ? `${label}  ${item.shortcut}` : label}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </div>
  );
}
