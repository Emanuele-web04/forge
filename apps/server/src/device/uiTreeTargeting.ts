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
}

export class DeviceUiTargetError extends Error {
  /** Candidate descriptions, so the agent can retry with a real label. */
  readonly candidates: readonly string[];

  constructor(message: string, candidates: readonly string[] = []) {
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
 * Find the one node a label refers to and the point that taps it.
 *
 * Exact label matches win outright: a screen with both "Developer" and
 * "Developer Mode" must not be ambiguous when the caller said "Developer".
 * Only when nothing matches exactly does this fall back to substring.
 */
export function resolveTapTarget(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch {
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
        `Scroll with device_swipe to bring it on screen, or call device_describe_ui and use a label listed there.`,
      labelled.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
    );
  }

  // An off-screen match is a scroll away, not a tap away: its frame is real
  // but outside the display, so tapping it would hit something else entirely.
  const visible = matches.filter((node) => isOnScreen(node, root));
  if (visible.length === 0) {
    throw new DeviceUiTargetError(
      `Element ${JSON.stringify(target.label)} is in the tree but scrolled off screen. ` +
        `Scroll it into view with device_swipe, then tap it.`,
      matches.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
    );
  }

  if (visible.length > 1) {
    throw new DeviceUiTargetError(
      `${visible.length} elements match ${JSON.stringify(target.label)}. ` +
        `Pass role to narrow it, or tap explicit coordinates from device_describe_ui.`,
      visible.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
    );
  }

  const node = visible[0] as DeviceUiNode;
  return { point: tapPointForNode(node), node };
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
