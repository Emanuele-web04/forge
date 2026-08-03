// FILE: DeviceBezel.tsx
// Purpose: Phone-shaped chassis that frames every device-pane state on a simulated screen.
// Layer: Device pane presentation primitive
// Exports: DeviceBezel, DEVICE_SCREEN_ASPECT_RATIO
//
// Pure CSS, no images. The chassis is the pane's container rather than a
// decoration around the video: setup checklists, boot spinners, and the live
// canvas all render on the screen, so the pane reads as one object instead of a
// rectangle with chrome stacked above and below it.

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** iPhone 17 Pro logical screen (1206 x 2622). Every state shares it so the frame never reflows. */
export const DEVICE_SCREEN_ASPECT_RATIO = 1206 / 2622;

/**
 * Side buttons are drawn as slivers that sit *outside* the chassis edge, the way
 * they protrude on hardware. They are decorative: the real controls live in the
 * rail below the bezel, where they can carry labels and shortcuts.
 */
function SideButtons() {
  const nub = "absolute w-[2.5px] rounded-full bg-gradient-to-b";
  // Matches the chassis edge so the nubs read as machined from the same piece.
  const metal = "from-white/22 via-white/10 to-white/[0.06]";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {/* Left: silent switch, then the two volume buttons. */}
      <span className={cn(nub, metal, "-left-[2px] top-[13%] h-[3.4%]")} />
      <span className={cn(nub, metal, "-left-[2px] top-[20%] h-[6.4%]")} />
      <span className={cn(nub, metal, "-left-[2px] top-[28.5%] h-[6.4%]")} />
      {/* Right: power. */}
      <span className={cn(nub, metal, "-right-[2px] top-[23%] h-[9%]")} />
    </div>
  );
}

export function DeviceBezel(props: {
  children: ReactNode;
  /** Rendered above the chassis, e.g. the agent-activity pill. */
  overlay?: ReactNode;
  className?: string;
  screenClassName?: string;
}) {
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col items-center gap-2", props.className)}>
      {props.overlay}
      {/*
        Two nested constraints keep the phone proportional in any pane shape:
        this box fills the space and clamps its own width to whatever the
        available height allows at the phone's aspect ratio, and the chassis
        below then fills that box. Clamping only one axis would squash the
        device the moment the other became the tighter bound.
      */}
      <div className="flex min-h-0 w-full flex-1 justify-center" style={{ containerType: "size" }}>
        <div
          className={cn(
            "relative h-full max-h-full",
            // The titanium read: a light top edge falling to near-black, with a
            // hairline highlight ring standing in for the polished chamfer.
            "rounded-[13.5%/6.2%] bg-gradient-to-b from-neutral-500 via-neutral-800 to-neutral-900",
            "p-[1.6%] shadow-[0_1px_0_0_rgba(255,255,255,0.14)_inset,0_18px_40px_-18px_rgba(0,0,0,0.9)]",
          )}
          style={{
            aspectRatio: DEVICE_SCREEN_ASPECT_RATIO,
            // Height is the driver; the width term caps it so the derived width
            // still fits, and stopping short of the full pane width leaves the
            // device sitting *in* the pane rather than wedged against its edges.
            height: `min(100cqh, calc(84cqw / ${DEVICE_SCREEN_ASPECT_RATIO}))`,
          }}
        >
          <SideButtons />
          <div
            className={cn(
              // Screen corners are tighter than the chassis by exactly the bezel
              // width, which is what makes the frame look milled rather than drawn.
              "relative h-full w-full overflow-hidden rounded-[12.2%/5.6%] bg-[#08080a]",
              props.screenClassName,
            )}
          >
            {props.children}
          </div>
        </div>
      </div>
    </div>
  );
}
