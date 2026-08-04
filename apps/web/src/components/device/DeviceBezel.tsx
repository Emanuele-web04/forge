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
  deviceShellFitWidth,
  deviceShellRadiusValue,
  resolveDeviceShellMetrics,
  type DeviceShellButton,
  type DeviceShellEdge,
  type DeviceShellIsland,
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

/** Thickness of the drawn metal sliver, and of the larger box that catches the click. */
const BUTTON_SLIVER_PX = 3.5;
const BUTTON_HIT_PX = 10;
/** How far the sliver sits proud of the chassis, matching the hardware's protrusion. */
const BUTTON_PROTRUSION_PX = 6;

/** True for the two edges a button runs horizontally along. */
function isHorizontalEdge(edge: DeviceShellEdge): boolean {
  return edge === "top" || edge === "bottom";
}

/**
 * The sliver's own layout box, positioned on whichever edge the geometry put it
 * on. Both orientations are one expression rather than two branches, because
 * a landscape button is the same control on a different axis and the pair would
 * drift the first time one of them was tweaked.
 */
function buttonPosition(spec: DeviceShellButton): Record<string, string> {
  const along = { offset: `${spec.offsetPercent}%`, length: `${spec.lengthPercent}%` };
  const proud = `-${BUTTON_PROTRUSION_PX}px`;
  return isHorizontalEdge(spec.edge)
    ? { left: along.offset, width: along.length, [spec.edge]: proud }
    : { top: along.offset, height: along.length, [spec.edge]: proud };
}

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
  const horizontal = isHorizontalEdge(spec.edge);

  // The sliver protrudes past the chassis onto the pane's own background, which
  // is light in the default theme. Machined titanium rather than a white
  // overlay for exactly that reason: a translucent highlight reads as metal
  // against the dark chassis and disappears entirely against the pane. The
  // gradient runs across the sliver's short axis, so it turns with the device.
  const metal = cn(
    "pointer-events-none absolute rounded-full shadow-[0_0_2px_0_rgba(0,0,0,0.45)]",
    horizontal
      ? "inset-x-0 h-[3.5px] bg-[linear-gradient(90deg,#7c828a_0%,#4c5158_28%,#3a3e44_72%,#5e646c_100%)]"
      : "inset-y-0 w-[3.5px] bg-[linear-gradient(180deg,#7c828a_0%,#4c5158_28%,#3a3e44_72%,#5e646c_100%)]",
  );

  // Position and length come from the geometry; the box is thicker than the
  // visible sliver so there is something to actually hit. 3.5px of hardware is
  // a fine thing to look at and a miserable thing to click.
  const position = buttonPosition(spec);

  if (!action.button) {
    return (
      <span
        aria-hidden
        className="absolute"
        style={{
          ...position,
          ...(horizontal
            ? { height: `${BUTTON_SLIVER_PX}px` }
            : { width: `${BUTTON_SLIVER_PX}px` }),
        }}
      >
        <span className={metal} />
      </span>
    );
  }

  // Pressing translates the sliver into the chassis, which is the one
  // affordance that reads as "button" on a shape this small. The direction is
  // always inward, so it follows the edge the button ended up on.
  const pressIn: Record<DeviceShellEdge, string> = {
    left: "active:translate-x-[1.5px]",
    right: "active:-translate-x-[1.5px]",
    top: "active:translate-y-[1.5px]",
    bottom: "active:-translate-y-[1.5px]",
  };

  const button = action.button;
  return (
    <button
      type="button"
      aria-label={action.label}
      disabled={props.disabled}
      onClick={() => props.onPress(button)}
      className={cn(
        "group absolute flex cursor-pointer items-stretch justify-center rounded-full outline-none",
        "transition-transform duration-220 motion-reduce:transition-none",
        pressIn[spec.edge],
        "focus-visible:ring-2 focus-visible:ring-ring/80",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
      style={{
        ...position,
        ...(horizontal ? { height: `${BUTTON_HIT_PX}px` } : { width: `${BUTTON_HIT_PX}px` }),
      }}
    >
      <span
        className={cn(
          metal,
          horizontal
            ? "inset-y-auto top-1/2 -translate-y-1/2"
            : "inset-x-auto left-1/2 -translate-x-1/2",
          "transition-[filter] duration-220 motion-reduce:transition-none",
          "group-hover:brightness-150 group-active:brightness-125",
        )}
      />
    </button>
  );
}

/**
 * The Dynamic Island, drawn over the video the way the real cutout sits over
 * the display. Positioned from the edge the geometry names, so a turned device
 * carries its cutout around to the side rather than losing it.
 */
function ShellIsland(props: { island: DeviceShellIsland }) {
  const { island } = props;
  const horizontal = isHorizontalEdge(island.edge);
  const centered = horizontal
    ? { left: "50%", transform: "translateX(-50%)" }
    : { top: "50%", transform: "translateY(-50%)" };

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute rounded-full bg-black"
      style={{
        ...centered,
        [island.edge]: `${island.insetPercent}%`,
        ...(horizontal
          ? { width: `${island.lengthPercent}%`, height: `${island.thicknessPercent}%` }
          : { height: `${island.lengthPercent}%`, width: `${island.thicknessPercent}%` }),
      }}
    />
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
  const landscape = props.landscape ?? false;
  // Rotating the chassis element itself would take its bounding box with it and
  // break every percentage below, so the geometry hands back an already-turned
  // chassis and the screen's contents rotate inside it.
  const metrics: DeviceShellMetrics = resolveDeviceShellMetrics({
    pointWidth: pointSize.width,
    pointHeight: pointSize.height,
    landscape,
  });
  const onPressButton = props.onPressButton;

  return (
    // No conditional siblings here, by design. The chassis is the only child, so
    // nothing that mounts or unmounts around it (status pills, notices) can
    // shift the device — an earlier revision put a badge above it and the phone
    // visibly jumped 30px every time an agent started or finished a tool call.
    <div className={cn("flex min-h-0 min-w-0 flex-col items-center", props.className)}>
      {/*
        A size container so the chassis can measure itself against the pane in
        `cq` units and scale to fit without any JS measuring the box.
      */}
      <div
        className="flex min-h-0 w-full flex-1 items-center justify-center"
        style={{ containerType: "size" }}
      >
        <div
          className={cn(
            "relative",
            // Titanium: a cool highlight along the top edge falling through a
            // near-black body, with a second highlight at the very bottom so
            // the chassis reads as a rounded solid rather than a flat fill.
            "bg-[linear-gradient(180deg,#9aa0a6_0%,#5c6067_2.5%,#2f3237_9%,#1b1d21_34%,#17191c_66%,#26292e_92%,#494d54_100%)]",
            // Inner hairline stands in for the polished chamfer; the outer
            // shadow lifts the device off the pane surface.
            "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.16),inset_0_1px_1px_0_rgba(255,255,255,0.22),0_2px_4px_-1px_rgba(0,0,0,0.5),0_24px_48px_-20px_rgba(0,0,0,0.95)]",
          )}
          style={{
            aspectRatio: metrics.chassisAspectRatio,
            borderRadius: deviceShellRadiusValue(metrics.chassisRadius),
            // Width is the driver and the height term caps it, so whichever
            // axis is tighter wins. Taking only one of them is what left a
            // turned device floating in a third of the space it had.
            width: deviceShellFitWidth(metrics.chassisAspectRatio),
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

          {/*
            Inset rather than padded. A percentage `padding-block` resolves
            against the box's *width*, so on a landscape chassis the top and
            bottom bezels inflated to a share of the long axis and crushed the
            screen into a letterboxed slab. Insets resolve against their own
            axis, which is the only way to state a bezel that is square in
            points on a box that is not.
          */}
          <div
            className={cn("absolute overflow-hidden bg-black", props.screenClassName)}
            // A size container so the screen's contents can address its own
            // box in cq units — which is how a portrait canvas is sized and
            // turned into a landscape screen without measuring anything in JS.
            style={{
              left: `${metrics.bezelInsetPercent.x}%`,
              right: `${metrics.bezelInsetPercent.x}%`,
              top: `${metrics.bezelInsetPercent.y}%`,
              bottom: `${metrics.bezelInsetPercent.y}%`,
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
            {metrics.dynamicIsland ? <ShellIsland island={metrics.dynamicIsland} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
