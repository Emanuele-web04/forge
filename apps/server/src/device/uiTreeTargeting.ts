/**
 * Resolving an accessibility node to the point that actually taps it.
 *
 * Agents are bad at coordinate arithmetic and worse at knowing which
 * coordinate of a node is the live one, so this module is the single place
 * that answers "where do I tap to hit the thing called X". Both the MCP
 * `device_tap` tool and any future caller go through it rather than each
 * re-deriving a centre point from a frame.
 *
 * Two rules carry most of the value:
 *
 * - The tap point is the node's `activationPoint` when it has one. UIKit
 *   merges a settings row and the control inside it into one element whose
 *   frame spans the row, so the frame centre of a switch row is dead space.
 * - A match that is scrolled out of view is refused rather than tapped. Its
 *   frame is still in the tree with off-screen coordinates, and tapping it
 *   would hit whatever happens to be at that position instead.
 *
 * @module device/uiTreeTargeting
 */
import type { DeviceUiNode, DeviceUiPoint } from "@synara/contracts";

/** What the caller asked for. At least a label; role narrows an ambiguous one. */
export interface DeviceUiTarget {
  readonly label: string;
  readonly role?: string | undefined;
}

export interface DeviceUiTargetMatch {
  readonly point: DeviceUiPoint;
  readonly node: DeviceUiNode;
  /** False when the match is in the tree but scrolled out of the display. */
  readonly onScreen: boolean;
}

export class DeviceUiTargetError extends Error {
  /** Candidate descriptions, so the agent can retry with a real label. */
  readonly candidates: readonly string[];
  /**
   * True when nothing matched the label at all.
   *
   * Distinguished from an ambiguous or off-screen match because long lists are
   * virtualized: UIKit only materializes the rows near the viewport, so a row
   * further down is genuinely absent from the tree until scrolling reaches it.
   * A scroll loop must keep looking; an ambiguity must not be retried.
   */
  readonly notFound: boolean;

  constructor(message: string, candidates: readonly string[] = [], notFound = false) {
    // Candidates go in the message, not just a field: every transport between
    // here and the agent (MCP tool errors, WsRpcError) carries only the
    // message, and a "no such label" with no list of real ones is a dead end.
    const listed =
      candidates.length === 0
        ? message
        : `${message} Elements on screen: ${candidates.join("; ")}.`;
    super(listed);
    this.name = "DeviceUiTargetError";
    this.candidates = candidates;
    this.notFound = notFound;
  }
}

/** How many near-misses to name; a whole screen of labels is noise, not help. */
const MAX_REPORTED_CANDIDATES = 12;

function flatten(root: DeviceUiNode): DeviceUiNode[] {
  const out: DeviceUiNode[] = [];
  const walk = (node: DeviceUiNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Every label currently rendered, used to tell a moving list from a stuck one. */
export function visibleLabels(root: DeviceUiNode): string[] {
  return flatten(root)
    .filter((node) => node.label !== null && node.label.length > 0)
    .map((node) => node.label as string);
}

/** Where a tap on this node lands: its own control point, else the frame centre. */
export function tapPointForNode(node: DeviceUiNode): DeviceUiPoint {
  if (node.activationPoint !== null) return node.activationPoint;
  return {
    x: node.frame.x + node.frame.width / 2,
    y: node.frame.y + node.frame.height / 2,
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesRole(node: DeviceUiNode, role: string): boolean {
  const wanted = normalize(role);
  return (
    normalize(node.role) === wanted || (node.subrole !== null && normalize(node.subrole) === wanted)
  );
}

/** A node is on screen when the point we would tap is inside the root's frame. */
function isOnScreen(node: DeviceUiNode, root: DeviceUiNode): boolean {
  const point = tapPointForNode(node);
  return (
    point.x >= root.frame.x &&
    point.x <= root.frame.x + root.frame.width &&
    point.y >= root.frame.y &&
    point.y <= root.frame.y + root.frame.height
  );
}

function describe(node: DeviceUiNode): string {
  const role = node.subrole === null ? node.role : `${node.role}/${node.subrole}`;
  const value = node.value === null ? "" : ` value=${JSON.stringify(node.value)}`;
  return `${role} ${JSON.stringify(node.label ?? "")}${value}`;
}

/**
 * Locate the one node a label refers to, whether or not it is on screen.
 *
 * Exact label matches win outright: a screen with both "Developer" and
 * "Developer Mode" must not be ambiguous when the caller said "Developer".
 * Only when nothing matches exactly does this fall back to substring.
 *
 * Ambiguity is judged among visible matches first. A list that repeats a
 * label down its length would otherwise be unresolvable, when in practice the
 * one on screen is the one meant.
 */
export function findTarget(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch {
  const wanted = normalize(target.label);
  if (wanted.length === 0) {
    throw new DeviceUiTargetError("A tap target needs a non-empty label.");
  }

  const labelled = flatten(root).filter((node) => node.label !== null && node.label.length > 0);
  const byRole =
    target.role === undefined
      ? labelled
      : labelled.filter((node) => matchesRole(node, target.role as string));

  const exact = byRole.filter((node) => normalize(node.label as string) === wanted);
  const matches =
    exact.length > 0
      ? exact
      : byRole.filter((node) => normalize(node.label as string).includes(wanted));

  if (matches.length === 0) {
    const roleNote = target.role === undefined ? "" : ` with role ${JSON.stringify(target.role)}`;
    throw new DeviceUiTargetError(
      `No element labelled ${JSON.stringify(target.label)}${roleNote} is in the accessibility tree. ` +
        `It may belong to a screen you have not opened yet; call device_describe_ui and use a label listed there.`,
      labelled.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
      true,
    );
  }

  const visible = matches.filter((node) => isOnScreen(node, root));
  const candidates = visible.length > 0 ? visible : matches;
  if (candidates.length > 1) {
    throw new DeviceUiTargetError(
      `${candidates.length} elements match ${JSON.stringify(target.label)}. ` +
        `Pass role to narrow it, or tap explicit coordinates from device_describe_ui.`,
      candidates.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
    );
  }

  const node = candidates[0] as DeviceUiNode;
  return { point: tapPointForNode(node), node, onScreen: visible.length > 0 };
}

/**
 * Find a node and insist it is tappable right now.
 *
 * Kept separate from `findTarget` for callers that will not scroll: an
 * off-screen frame is real but outside the display, so tapping it would hit
 * whatever currently occupies that position.
 */
export function resolveTapTarget(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch {
  const match = findTarget(root, target);
  if (!match.onScreen) {
    throw new DeviceUiTargetError(
      `Element ${JSON.stringify(target.label)} is in the tree but scrolled off screen. ` +
        `Scroll it into view first, then tap it.`,
      [describe(match.node)],
    );
  }
  return match;
}

/**
 * The band a target must land in to count as usable.
 *
 * Not the whole screen: a row sitting under the status bar or behind a home
 * indicator is technically visible and practically untappable, and a row at
 * the very edge tends to be half-clipped. The inset is a fraction of screen
 * height so it scales across devices.
 */
const SAFE_BAND_INSET_FRACTION = 0.12;

/** One swipe covers most of a screen, but not so much that it overshoots. */
const SCROLL_INCREMENT_FRACTION = 0.6;

/** Long enough to read as a drag rather than a flick, which would coast past. */
export const SCROLL_SWIPE_DURATION_MS = 400;

export interface DeviceScrollStep {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
}

/**
 * The swipe that moves a target toward the safe band, or null when it is
 * already there.
 *
 * Content moves opposite to the finger: to bring up something below the fold
 * the finger travels up, so the gesture always starts at the far side of the
 * screen from where it is heading.
 */
export function planScrollStep(node: DeviceUiNode, root: DeviceUiNode): DeviceScrollStep | null {
  const inset = root.frame.height * SAFE_BAND_INSET_FRACTION;
  const bandTop = root.frame.y + inset;
  const bandBottom = root.frame.y + root.frame.height - inset;
  const centre = node.frame.y + node.frame.height / 2;

  if (centre >= bandTop && centre <= bandBottom) return null;

  const increment = root.frame.height * SCROLL_INCREMENT_FRACTION;
  const midX = root.frame.x + root.frame.width / 2;
  const screenCentre = root.frame.y + root.frame.height / 2;
  // Never swipe further than the gap: a target just past the band should not
  // be flung to the other side of the screen and need a correcting swipe back.
  const distance = Math.min(increment, Math.abs(centre - screenCentre));
  const from = centre > bandBottom ? screenCentre + distance / 2 : screenCentre - distance / 2;
  const to = centre > bandBottom ? from - distance : from + distance;

  return { fromX: midX, fromY: from, toX: midX, toY: to, durationMs: SCROLL_SWIPE_DURATION_MS };
}

/** The two shapes a tap request can take, once validated. */
export type DeviceTapRequest =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "element"; readonly target: DeviceUiTarget };

/**
 * Decide whether a tap names a point or an element, rejecting the shapes that
 * are neither. The schema cannot express "x and y together, or label" on its
 * own, so the either/or lives here and both callers share it.
 */
export function readTapRequest(input: {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly label?: string | undefined;
  readonly role?: string | undefined;
}): DeviceTapRequest {
  const hasPoint = input.x !== undefined && input.y !== undefined;
  if (input.label !== undefined) {
    if (hasPoint) {
      throw new DeviceUiTargetError(
        "A tap takes either label (with optional role) or x and y, not both. " +
          "Pass label alone to let Synara resolve the element's own tap point.",
      );
    }
    return { kind: "element", target: { label: input.label, role: input.role } };
  }
  if (!hasPoint) {
    throw new DeviceUiTargetError(
      "A tap needs either label (with optional role) or both x and y. " +
        "Prefer label: Synara then resolves the element's own tap point from the accessibility tree.",
    );
  }
  return { kind: "point", x: input.x as number, y: input.y as number };
}
