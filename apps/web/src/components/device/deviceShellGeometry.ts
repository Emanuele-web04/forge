// FILE: deviceShellGeometry.ts
// Purpose: Derive the drawn phone chassis (radii, bezel, Dynamic Island, side buttons) from a device's real point size, in either orientation.
// Layer: Device pane presentation logic
// Exports: resolveDeviceShellMetrics, deviceShellClass, fitDeviceShellSize, DEVICE_SHELL_FALLBACK_POINT_SIZE
// Depends on: nothing — pure arithmetic, no DOM, no React.
//
// The chassis is drawn in CSS rather than composited from Apple's bezel
// artwork. Apple licenses those images for marketing use, requires them to be
// used unmodified, and explicitly forbids building buttons out of them — and a
// fixed image is one device, while this pane has to frame anything from an
// iPhone SE to a 13" iPad. Everything below is therefore expressed as a
// fraction of the device's own point size so one shell fits every aspect.
//
// Landscape is a true 90° turn of the same hardware, not a second set of
// numbers: the point size is normalised to portrait, the chassis is measured
// there, and the result is rotated as a final step. Every dimension the
// component consumes is already expressed against the box it will actually be
// drawn in, because CSS percentages do not agree on which axis they resolve
// against — `padding-block: 2%` resolves against *width*, which is exactly what
// squashed the first landscape build into a letterboxed slab.

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

/** Which physical edge of the drawn chassis something sits on. */
export type DeviceShellEdge = "top" | "right" | "bottom" | "left";

export interface DeviceShellButton {
  readonly id: "action" | "volume-up" | "volume-down" | "power";
  readonly edge: DeviceShellEdge;
  /**
   * Distance from the start of that edge — its top for a vertical edge, its
   * left for a horizontal one — as a % of the chassis dimension the edge runs
   * along.
   */
  readonly offsetPercent: number;
  /** Button length along the edge, as a % of that same dimension. */
  readonly lengthPercent: number;
}

/**
 * The Dynamic Island, positioned against the *screen* rather than the chassis.
 * Stated relative to the edge it hugs so the same three numbers survive
 * rotation: turning the device only changes which edge that is.
 */
export interface DeviceShellIsland {
  readonly edge: DeviceShellEdge;
  /** Gap between the island and its edge, as a % of the screen dimension across that edge. */
  readonly insetPercent: number;
  /** Island size along the edge, as a % of the screen dimension the edge runs along. */
  readonly lengthPercent: number;
  /** Island size across the edge, as a % of the screen dimension across it. */
  readonly thicknessPercent: number;
}

export interface DeviceShellMetrics {
  readonly shellClass: DeviceShellClass;
  readonly landscape: boolean;
  /** Screen width / height as drawn. Portrait for an upright phone, its reciprocal turned. */
  readonly screenAspectRatio: number;
  /** Chassis width / height as drawn, including the bezel on all four sides. */
  readonly chassisAspectRatio: number;
  /**
   * Bezel thickness as an inset on the screen: `x` is a % of the chassis's
   * width, `y` a % of its height. Two axes rather than one number because the
   * bezel is only square in points — on a chassis that is twice as tall as it
   * is wide, one percentage cannot describe both.
   */
  readonly bezelInsetPercent: { readonly x: number; readonly y: number };
  readonly chassisRadius: DeviceShellRadius;
  readonly screenRadius: DeviceShellRadius;
  /** Null for anything that is not an edge-to-edge iPhone. */
  readonly dynamicIsland: DeviceShellIsland | null;
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
 * Side-button placement in the upright device, as fractions of the *chassis*
 * height measured from its top edge. Phones follow the hardware: action button,
 * then the volume pair on the left, power on the right and slightly lower.
 *
 * The tablet row is a deliberate approximation — an iPad's power button is on
 * the top edge, which this shell has no way to draw — so it is placed at the
 * top of the right rail above the volume pair, where it at least reads as the
 * same control.
 */
const BUTTON_LAYOUTS: Record<DeviceShellClass, readonly DeviceShellButton[]> = {
  "modern-phone": [
    { id: "action", edge: "left", offsetPercent: 13.2, lengthPercent: 3.4 },
    { id: "volume-up", edge: "left", offsetPercent: 19.6, lengthPercent: 6.6 },
    { id: "volume-down", edge: "left", offsetPercent: 28.0, lengthPercent: 6.6 },
    { id: "power", edge: "right", offsetPercent: 22.4, lengthPercent: 9.4 },
  ],
  "classic-phone": [
    { id: "action", edge: "left", offsetPercent: 20.5, lengthPercent: 3.0 },
    { id: "volume-up", edge: "left", offsetPercent: 26.0, lengthPercent: 5.4 },
    { id: "volume-down", edge: "left", offsetPercent: 33.0, lengthPercent: 5.4 },
    { id: "power", edge: "right", offsetPercent: 24.0, lengthPercent: 8.0 },
  ],
  tablet: [
    { id: "power", edge: "right", offsetPercent: 6.0, lengthPercent: 4.6 },
    { id: "volume-up", edge: "right", offsetPercent: 13.0, lengthPercent: 4.2 },
    { id: "volume-down", edge: "right", offsetPercent: 18.4, lengthPercent: 4.2 },
  ],
};

/**
 * Where each edge lands after the quarter turn the pane applies to the view.
 * The rotation is clockwise, so what was the top of the phone ends up on the
 * right — which is why the volume rocker leaves the left edge for the top one
 * and the Dynamic Island leaves the top edge for the right one.
 */
const ROTATED_EDGE: Record<DeviceShellEdge, DeviceShellEdge> = {
  left: "top",
  top: "right",
  right: "bottom",
  bottom: "left",
};

/**
 * A quarter turn also reverses the direction each edge is measured in: the
 * button nearest the top of an upright phone is the one nearest the *right*
 * once it is lying down.
 *
 * The percentages themselves carry over untouched, because the landscape
 * chassis is the portrait one transposed — its width is the portrait height, so
 * a fraction of one is the same fraction of the other.
 */
function rotateButton(button: DeviceShellButton): DeviceShellButton {
  return {
    id: button.id,
    edge: ROTATED_EDGE[button.edge],
    offsetPercent: 100 - button.offsetPercent - button.lengthPercent,
    lengthPercent: button.lengthPercent,
  };
}

function radiusPercent(radius: number, width: number, height: number): DeviceShellRadius {
  return { xPercent: (radius / width) * 100, yPercent: (radius / height) * 100 };
}

function usablePointSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ...DEVICE_SHELL_FALLBACK_POINT_SIZE };
  }
  // A device reporting landscape points is the same hardware turned, and the
  // pane drives orientation from its own rotate control, so normalise to
  // upright here rather than growing a second set of profiles.
  return width > height ? { width: height, height: width } : { width, height };
}

/**
 * Everything the chassis needs, derived from the device's screen in points and
 * the orientation it is being drawn in.
 *
 * Point size rather than frame pixels: the frame is 3x on a phone and 2x on an
 * iPad, so pixel dimensions would put an iPad and a phone in the same size
 * bracket and pick the wrong shell for one of them.
 */
export function resolveDeviceShellMetrics(input: {
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly landscape?: boolean;
}): DeviceShellMetrics {
  const { width, height } = usablePointSize(input.pointWidth, input.pointHeight);
  const landscape = input.landscape ?? false;
  const shellClass = deviceShellClass(width, height);
  const profile = SHELL_PROFILES[shellClass];

  const sideBezel = width * profile.sideBezelRatio;
  const endBezel = width * profile.endBezelRatio;
  const uprightChassis = { width: width + sideBezel * 2, height: height + endBezel * 2 };

  const screenRadius = width * profile.screenRadiusRatio;
  // Concentric, not merely rounded: an outer radius equal to the inner one plus
  // the bezel keeps the two curves a constant distance apart, which is the
  // whole reason a real chassis looks milled rather than drawn.
  const chassisRadius = screenRadius + Math.min(sideBezel, endBezel);

  // Transposing rather than recomputing is the point: a turned phone is the
  // same milled object, so its chassis thickness, radii and screen are
  // identical and only the axis they are measured against changes.
  const screen = landscape ? { width: height, height: width } : { width, height };
  const chassis = landscape
    ? { width: uprightChassis.height, height: uprightChassis.width }
    : uprightChassis;
  const bezel = landscape ? { x: endBezel, y: sideBezel } : { x: sideBezel, y: endBezel };

  return {
    shellClass,
    landscape,
    screenAspectRatio: screen.width / screen.height,
    chassisAspectRatio: chassis.width / chassis.height,
    bezelInsetPercent: {
      x: (bezel.x / chassis.width) * 100,
      y: (bezel.y / chassis.height) * 100,
    },
    chassisRadius: radiusPercent(chassisRadius, chassis.width, chassis.height),
    screenRadius: radiusPercent(screenRadius, screen.width, screen.height),
    dynamicIsland:
      shellClass === "modern-phone"
        ? {
            edge: landscape ? "right" : "top",
            // Measured across the short axis of the screen either way, which in
            // the upright device is its width.
            insetPercent: ((width * ISLAND_TOP_RATIO) / height) * 100,
            lengthPercent: ISLAND_WIDTH_RATIO * 100,
            thicknessPercent: ((width * ISLAND_HEIGHT_RATIO) / height) * 100,
          }
        : null,
    buttons: landscape ? BUTTON_LAYOUTS[shellClass].map(rotateButton) : BUTTON_LAYOUTS[shellClass],
  };
}

/**
 * Breathing room left around the device inside its pane. Filling the pane
 * exactly would wedge the chassis against the edges and clip the side buttons,
 * which protrude past it.
 */
export const DEVICE_SHELL_FIT_MARGIN = 0.94;

/**
 * The largest chassis of the given aspect that fits the available box.
 *
 * Both axes are constraints, not one: a portrait phone in a tall pane is bound
 * by width, the same phone turned is bound by height, and taking only one of
 * them is what left the landscape device floating in a third of the space it
 * had.
 */
export function fitDeviceShellSize(
  available: { readonly width: number; readonly height: number },
  chassisAspectRatio: number,
  margin: number = DEVICE_SHELL_FIT_MARGIN,
): { readonly width: number; readonly height: number } {
  if (
    !Number.isFinite(available.width) ||
    !Number.isFinite(available.height) ||
    !Number.isFinite(chassisAspectRatio) ||
    available.width <= 0 ||
    available.height <= 0 ||
    chassisAspectRatio <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const width = Math.min(available.width * margin, available.height * margin * chassisAspectRatio);
  return { width, height: width / chassisAspectRatio };
}

/**
 * The same fit as a CSS length, resolved by the browser against the pane's size
 * container. Kept next to `fitDeviceShellSize` so the two can never drift; the
 * component uses this one so a pane resize costs no JS at all.
 */
export function deviceShellFitWidth(
  chassisAspectRatio: number,
  margin: number = DEVICE_SHELL_FIT_MARGIN,
): string {
  const percent = margin * 100;
  // The height term is folded into its own coefficient rather than written as
  // `Ncqh * ratio`. A length multiplied by a bare number is not a valid CSS
  // calculation in `min()`, so that form was dropped whole and the chassis fell
  // back to the width term alone — which is why a turned device sat in a third
  // of the height it had while the portrait one filled the pane.
  const heightPercent = percent * chassisAspectRatio;
  return `min(${percent}cqw, ${heightPercent}cqh)`;
}

/** CSS `border-radius` shorthand for a radius pair. */
export function deviceShellRadiusValue(radius: DeviceShellRadius): string {
  return `${radius.xPercent}% / ${radius.yPercent}%`;
}
