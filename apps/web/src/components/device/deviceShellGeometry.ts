// FILE: deviceShellGeometry.ts
// Purpose: Derive the drawn phone chassis (radii, bezel, Dynamic Island, side buttons) from a device's real point size.
// Layer: Device pane presentation logic
// Exports: resolveDeviceShellMetrics, deviceShellClass, DEVICE_SHELL_FALLBACK_POINT_SIZE
// Depends on: nothing — pure arithmetic, no DOM, no React.
//
// The chassis is drawn in CSS rather than composited from Apple's bezel
// artwork. Apple licenses those images for marketing use, requires them to be
// used unmodified, and explicitly forbids building buttons out of them — and a
// fixed image is one device, while this pane has to frame anything from an
// iPhone SE to a 13" iPad. Everything below is therefore expressed as a
// fraction of the device's own point size so one shell fits every aspect.

/**
 * The three hardware shapes worth drawing differently. The class decides the
 * corner radius, whether there is a Dynamic Island, and where the side buttons
 * sit — every other dimension is interpolated from the point size.
 */
export type DeviceShellClass =
  /** Edge-to-edge iPhone: big radius, Dynamic Island, uniform hairline bezel. */
  | "modern-phone"
  /** Home-button iPhone (SE): small radius, no island, deep forehead and chin. */
  | "classic-phone"
  /** iPad: modest radius, no island, wider bezel all round. */
  | "tablet";

/** iPhone 17 Pro, used until the helper reports the attached device's real geometry. */
export const DEVICE_SHELL_FALLBACK_POINT_SIZE = { width: 402, height: 874 } as const;

/**
 * Below this the device is a phone; at or above it a tablet. iPhone point
 * widths top out at 440 (Pro Max) and the smallest iPad is 744, so the gap is
 * wide enough that no shipping device sits near the boundary.
 */
const TABLET_MIN_POINT_WIDTH = 600;

/**
 * Every edge-to-edge iPhone is at least this tall relative to its width
 * (iPhone 17 Pro is 2.17); the last home-button iPhone, the SE, is 1.78. The
 * ratio is what gates the Dynamic Island, so an iPad — 1.44 — can never get one.
 */
const MODERN_PHONE_MIN_ASPECT = 1.95;

export function deviceShellClass(pointWidth: number, pointHeight: number): DeviceShellClass {
  if (pointWidth >= TABLET_MIN_POINT_WIDTH) return "tablet";
  return pointHeight / pointWidth >= MODERN_PHONE_MIN_ASPECT ? "modern-phone" : "classic-phone";
}

/**
 * A radius expressed twice: once against the box's width and once against its
 * height. CSS percentage radii are elliptical, so a single percentage on a
 * 1:2.2 box draws a stretched corner; the `Rx% / Ry%` pair is what makes the
 * corner actually circular.
 */
export interface DeviceShellRadius {
  readonly xPercent: number;
  readonly yPercent: number;
}

export interface DeviceShellButton {
  readonly id: "action" | "volume-up" | "volume-down" | "power";
  readonly edge: "left" | "right";
  /** Distance from the top of the chassis to the button's top, as a % of chassis height. */
  readonly topPercent: number;
  /** Button length as a % of chassis height. */
  readonly heightPercent: number;
}

export interface DeviceShellMetrics {
  readonly shellClass: DeviceShellClass;
  /** Screen width / height. Drives the chassis `aspect-ratio` so nothing is squashed. */
  readonly screenAspectRatio: number;
  /** Chassis width / height, including the bezel on all four sides. */
  readonly chassisAspectRatio: number;
  /** Bezel thickness as a % of the chassis's own width, for symmetric padding. */
  readonly bezelInsetPercent: { readonly x: number; readonly y: number };
  readonly chassisRadius: DeviceShellRadius;
  readonly screenRadius: DeviceShellRadius;
  /** Null for anything that is not an edge-to-edge iPhone. */
  readonly dynamicIsland: {
    readonly widthPercent: number;
    readonly heightPercent: number;
    readonly topPercent: number;
  } | null;
  readonly buttons: readonly DeviceShellButton[];
}

interface ShellProfile {
  /** Screen corner radius as a fraction of screen width. */
  readonly screenRadiusRatio: number;
  /** Bezel thickness on the left and right, as a fraction of screen width. */
  readonly sideBezelRatio: number;
  /** Bezel thickness top and bottom, as a fraction of screen width. */
  readonly endBezelRatio: number;
}

/**
 * Measured off Apple's published dimensions and normalised to screen width:
 * the iPhone 17 Pro's 55pt screen radius over its 402pt width is 0.137, and
 * its ~4pt border is 0.010. The SE's chin and forehead are what make its
 * profile asymmetric.
 */
const SHELL_PROFILES: Record<DeviceShellClass, ShellProfile> = {
  "modern-phone": { screenRadiusRatio: 0.137, sideBezelRatio: 0.028, endBezelRatio: 0.028 },
  "classic-phone": { screenRadiusRatio: 0.02, sideBezelRatio: 0.035, endBezelRatio: 0.155 },
  tablet: { screenRadiusRatio: 0.06, sideBezelRatio: 0.045, endBezelRatio: 0.045 },
};

/** Dynamic Island on the 17 Pro: 126x37pt, 11pt below the top of the screen. */
const ISLAND_WIDTH_RATIO = 126 / 402;
const ISLAND_HEIGHT_RATIO = 37 / 402;
const ISLAND_TOP_RATIO = 11 / 402;

/**
 * Side-button placement, in fractions of the *chassis* height measured from its
 * top edge. Phones follow the hardware: action button, then the volume pair on
 * the left, power on the right and slightly lower.
 *
 * The tablet row is a deliberate approximation — an iPad's power button is on
 * the top edge, which this shell has no way to draw — so it is placed at the
 * top of the right rail above the volume pair, where it at least reads as the
 * same control.
 */
const BUTTON_LAYOUTS: Record<DeviceShellClass, readonly DeviceShellButton[]> = {
  "modern-phone": [
    { id: "action", edge: "left", topPercent: 13.2, heightPercent: 3.4 },
    { id: "volume-up", edge: "left", topPercent: 19.6, heightPercent: 6.6 },
    { id: "volume-down", edge: "left", topPercent: 28.0, heightPercent: 6.6 },
    { id: "power", edge: "right", topPercent: 22.4, heightPercent: 9.4 },
  ],
  "classic-phone": [
    { id: "action", edge: "left", topPercent: 20.5, heightPercent: 3.0 },
    { id: "volume-up", edge: "left", topPercent: 26.0, heightPercent: 5.4 },
    { id: "volume-down", edge: "left", topPercent: 33.0, heightPercent: 5.4 },
    { id: "power", edge: "right", topPercent: 24.0, heightPercent: 8.0 },
  ],
  tablet: [
    { id: "power", edge: "right", topPercent: 6.0, heightPercent: 4.6 },
    { id: "volume-up", edge: "right", topPercent: 13.0, heightPercent: 4.2 },
    { id: "volume-down", edge: "right", topPercent: 18.4, heightPercent: 4.2 },
  ],
};

function radiusPercent(radius: number, width: number, height: number): DeviceShellRadius {
  return { xPercent: (radius / width) * 100, yPercent: (radius / height) * 100 };
}

function usablePointSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ...DEVICE_SHELL_FALLBACK_POINT_SIZE };
  }
  // Landscape geometry describes the same hardware rotated; the chassis is
  // always drawn upright and the *view* is what rotates, so normalise here
  // rather than growing a second set of profiles.
  return width > height ? { width: height, height: width } : { width, height };
}

/**
 * Everything the chassis needs, derived from the device's screen in points.
 *
 * Point size rather than frame pixels: the frame is 3x on a phone and 2x on an
 * iPad, so pixel dimensions would put an iPad and a phone in the same size
 * bracket and pick the wrong shell for one of them.
 */
export function resolveDeviceShellMetrics(input: {
  readonly pointWidth: number;
  readonly pointHeight: number;
}): DeviceShellMetrics {
  const { width, height } = usablePointSize(input.pointWidth, input.pointHeight);
  const shellClass = deviceShellClass(width, height);
  const profile = SHELL_PROFILES[shellClass];

  const sideBezel = width * profile.sideBezelRatio;
  const endBezel = width * profile.endBezelRatio;
  const chassisWidth = width + sideBezel * 2;
  const chassisHeight = height + endBezel * 2;

  const screenRadius = width * profile.screenRadiusRatio;
  // Concentric, not merely rounded: an outer radius equal to the inner one plus
  // the bezel keeps the two curves a constant distance apart, which is the
  // whole reason a real chassis looks milled rather than drawn.
  const chassisRadius = screenRadius + Math.min(sideBezel, endBezel);

  return {
    shellClass,
    screenAspectRatio: width / height,
    chassisAspectRatio: chassisWidth / chassisHeight,
    bezelInsetPercent: {
      x: (sideBezel / chassisWidth) * 100,
      y: (endBezel / chassisHeight) * 100,
    },
    chassisRadius: radiusPercent(chassisRadius, chassisWidth, chassisHeight),
    screenRadius: radiusPercent(screenRadius, width, height),
    dynamicIsland:
      shellClass === "modern-phone"
        ? {
            widthPercent: ISLAND_WIDTH_RATIO * 100,
            heightPercent: ((width * ISLAND_HEIGHT_RATIO) / height) * 100,
            topPercent: ((width * ISLAND_TOP_RATIO) / height) * 100,
          }
        : null,
    buttons: BUTTON_LAYOUTS[shellClass],
  };
}

/** CSS `border-radius` shorthand for a radius pair. */
export function deviceShellRadiusValue(radius: DeviceShellRadius): string {
  return `${radius.xPercent}% / ${radius.yPercent}%`;
}
