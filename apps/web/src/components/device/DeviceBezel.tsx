// FILE: DeviceBezel.tsx
// Purpose: Phone-shaped chassis that frames every device-pane state, with working hardware buttons.
// Layer: Device pane presentation primitive
// Exports: DeviceBezel
// Depends on: deviceShellGeometry for every dimension, device contracts for the button names.
//
// Pure CSS, no images. Two reasons the shell is drawn rather than composited
// from Apple's bezel artwork: those images are licensed for marketing use, must
// be used unmodified, and explicitly may not be turned into buttons — which is
// exactly what the side rails below are — and a fixed image is one device,
// while this pane frames anything from an iPhone SE to a 13" iPad. Every
// dimension comes from the attached device's own point size (see
// deviceShellGeometry), so one shell fits every aspect.
//
// The chassis is also the pane's container rather than a decoration around the
// video: setup checklists, boot spinners, and the live canvas all render on the
// screen, so the pane reads as one object instead of a rectangle with chrome
// stacked above and below it.

import type { DeviceHardwareButton } from "@synara/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  DEVICE_SHELL_FALLBACK_POINT_SIZE,
  deviceShellRadiusValue,
  resolveDeviceShellMetrics,
  type DeviceShellButton,
  type DeviceShellMetrics,
} from "./deviceShellGeometry";

/** Which contract button each drawn sliver presses, and how it names itself. */
const SHELL_BUTTON_ACTIONS: Record<
  DeviceShellButton["id"],
  { readonly label: string; readonly button: DeviceHardwareButton | null }
> = {
  // The action button (the ring/silent switch's replacement) maps to nothing
  // the helper can inject, so it stays decorative rather than shipping a
  // control that does nothing when pressed.
  action: { label: "Action button", button: null },
  "volume-up": { label: "Volume up", button: "volume-up" },
  "volume-down": { label: "Volume down", button: "volume-down" },
  power: { label: "Lock", button: "lock" },
};

/**
 * One side button, drawn as a sliver protruding from the chassis edge the way
 * it does on hardware.
 *
 * These are real buttons, not decoration: Simulator.app's side buttons are
 * clickable and so are these. That is also why they carry an accessible name, a
 * focus ring, and a pressed state — a control that looks like hardware still
 * has to behave like a control.
 */
function ShellButton(props: {
  spec: DeviceShellButton;
  disabled: boolean;
  onPress: (button: DeviceHardwareButton) => void;
}) {
  const { spec } = props;
  const action = SHELL_BUTTON_ACTIONS[spec.id];

  // The sliver protrudes past the chassis onto the pane's own background, which
  // is light in the default theme. Machined titanium rather than a white
  // overlay for exactly that reason: a translucent highlight reads as metal
  // against the dark chassis and disappears entirely against the pane.
  const metal = cn(
    "pointer-events-none absolute inset-y-0 w-[3.5px] rounded-full",
    "bg-[linear-gradient(180deg,#7c828a_0%,#4c5158_28%,#3a3e44_72%,#5e646c_100%)]",
    "shadow-[0_0_2px_0_rgba(0,0,0,0.45)]",
  );

  // Position and length come from the geometry; the box is wider than the
  // visible sliver so there is something to actually hit. 3.5px of hardware is
  // a fine thing to look at and a miserable thing to click.
  const position = {
    top: `${spec.topPercent}%`,
    height: `${spec.heightPercent}%`,
    ...(spec.edge === "left" ? { left: "-6px" } : { right: "-6px" }),
  };

  if (!action.button) {
    return (
      <span aria-hidden className="absolute w-[3.5px]" style={position}>
        <span className={metal} />
      </span>
    );
  }

  const button = action.button;
  return (
    <button
      type="button"
      aria-label={action.label}
      disabled={props.disabled}
      onClick={() => props.onPress(button)}
      className={cn(
        "group absolute flex w-[10px] cursor-pointer items-stretch justify-center rounded-full outline-none",
        "transition-transform duration-220 motion-reduce:transition-none",
        // Pressing translates the sliver into the chassis, which is the one
        // affordance that reads as "button" on a shape this small.
        spec.edge === "left" ? "active:translate-x-[1.5px]" : "active:-translate-x-[1.5px]",
        "focus-visible:ring-2 focus-visible:ring-ring/80",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
      style={position}
    >
      <span
        className={cn(
          metal,
          "inset-x-auto left-1/2 -translate-x-1/2",
          "transition-[filter] duration-220 motion-reduce:transition-none",
          "group-hover:brightness-150 group-active:brightness-125",
        )}
      />
    </button>
  );
}

export function DeviceBezel(props: {
  children: ReactNode;
  className?: string;
  screenClassName?: string;
  /**
   * The attached device's screen in points. Absent before a device is attached,
   * where the fallback keeps the pane's empty state on the same shape it will
   * have once a phone arrives — the bezel must never resize between states.
   */
  pointSize?: { readonly width: number; readonly height: number } | null;
  /** Quarter-turns applied to the *view*; the chassis follows so it reads as the device turning. */
  landscape?: boolean;
  buttonsDisabled?: boolean;
  onPressButton?: (button: DeviceHardwareButton) => void;
}) {
  const pointSize = props.pointSize ?? DEVICE_SHELL_FALLBACK_POINT_SIZE;
  const metrics: DeviceShellMetrics = resolveDeviceShellMetrics({
    pointWidth: pointSize.width,
    pointHeight: pointSize.height,
  });
  const onPressButton = props.onPressButton;
  const landscape = props.landscape ?? false;
  // Rotating the chassis element itself would take its bounding box with it and
  // break every percentage below, so landscape swaps the aspect instead and the
  // screen's contents rotate inside it.
  const chassisAspect = landscape ? 1 / metrics.chassisAspectRatio : metrics.chassisAspectRatio;

  return (
    // No conditional siblings here, by design. The chassis is the only child, so
    // nothing that mounts or unmounts around it (status pills, notices) can
    // shift the device — an earlier revision put a badge above it and the phone
    // visibly jumped 30px every time an agent started or finished a tool call.
    <div className={cn("flex min-h-0 min-w-0 flex-col items-center", props.className)}>
      {/*
        Two nested constraints keep the phone proportional in any pane shape:
        this box fills the space and clamps its own width to whatever the
        available height allows at the phone's aspect ratio, and the chassis
        below then fills that box. Clamping only one axis would squash the
        device the moment the other became the tighter bound.
      */}
      <div
        className="flex min-h-0 w-full flex-1 items-center justify-center"
        style={{ containerType: "size" }}
      >
        <div
          className={cn(
            "relative h-full max-h-full",
            // Titanium: a cool highlight along the top edge falling through a
            // near-black body, with a second highlight at the very bottom so
            // the chassis reads as a rounded solid rather than a flat fill.
            "bg-[linear-gradient(180deg,#9aa0a6_0%,#5c6067_2.5%,#2f3237_9%,#1b1d21_34%,#17191c_66%,#26292e_92%,#494d54_100%)]",
            // Inner hairline stands in for the polished chamfer; the outer
            // shadow lifts the device off the pane surface.
            "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.16),inset_0_1px_1px_0_rgba(255,255,255,0.22),0_2px_4px_-1px_rgba(0,0,0,0.5),0_24px_48px_-20px_rgba(0,0,0,0.95)]",
          )}
          style={{
            aspectRatio: chassisAspect,
            borderRadius: deviceShellRadiusValue(metrics.chassisRadius),
            paddingInline: `${metrics.bezelInsetPercent.x}%`,
            paddingBlock: `${metrics.bezelInsetPercent.y}%`,
            // Height is the driver; the width term caps it so the derived width
            // still fits, and stopping short of the full pane width leaves the
            // device sitting *in* the pane rather than wedged against its edges.
            height: `min(100cqh, calc(84cqw / ${chassisAspect}))`,
          }}
        >
          {metrics.buttons.map((spec) => (
            <ShellButton
              key={spec.id}
              spec={spec}
              disabled={props.buttonsDisabled ?? onPressButton === undefined}
              onPress={(button) => onPressButton?.(button)}
            />
          ))}

          <div
            className={cn("relative h-full w-full overflow-hidden bg-black", props.screenClassName)}
            // A size container so the screen's contents can address its own
            // box in cq units — which is how a portrait canvas is sized and
            // turned into a landscape screen without measuring anything in JS.
            style={{
              borderRadius: deviceShellRadiusValue(metrics.screenRadius),
              containerType: "size",
            }}
          >
            {props.children}
            {/*
              Drawn last so it sits over the video the way the real cutout sits
              over the display. Gated on the shell class, so an iPad or an SE
              never grows an island it does not have.
            */}
            {metrics.dynamicIsland && !landscape ? (
              <span
                aria-hidden
                className="-translate-x-1/2 pointer-events-none absolute left-1/2 rounded-full bg-black"
                style={{
                  top: `${metrics.dynamicIsland.topPercent}%`,
                  width: `${metrics.dynamicIsland.widthPercent}%`,
                  height: `${metrics.dynamicIsland.heightPercent}%`,
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
