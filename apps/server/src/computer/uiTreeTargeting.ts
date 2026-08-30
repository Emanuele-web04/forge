/**
 * Resolving a desktop target — a coordinate or a label — to the point that acts
 * on it.
 *
 * The matching itself is `@synara/shared/uiTreeTargeting`, shared with the iOS
 * family: exact label before substring, ambiguity refused rather than guessed.
 * What lives here is what the desktop specifically needs — a window scope, a
 * role compared verbatim, and an `onScreen` flag the perception source already
 * computed — plus the coordinate path, which has no accessibility tree at all.
 *
 * @module computer/uiTreeTargeting
 */
import type {
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerTarget,
  ComputerUiNode,
} from "@synara/contracts";
import {
  flattenUiTree,
  resolveUiTreeTarget,
  uiTreeActivationPoint,
  type UiTreeTargetSpec,
} from "@synara/shared/uiTreeTargeting";
import { clampTextToLength } from "./utf8Truncation.ts";

export interface ComputerTargetCandidate {
  readonly label: string;
  readonly role: string;
  readonly windowId: string | null;
  readonly onScreen: boolean;
  readonly frame: ComputerRect;
}

export interface ComputerTargetMatch {
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

export type ComputerTargetErrorCode =
  | "computer_target_invalid"
  | "computer_target_not_found"
  | "computer_target_ambiguous"
  | "computer_target_offscreen"
  /** The named window is covered at the point and the desktop could not raise it. */
  | "computer_target_occluded"
  /** The desktop declined to deliver input to the named window, and sent none. */
  | "computer_target_refused";

/** How many near-misses to name; a whole desktop of labels is noise, not help. */
const MAX_REPORTED_CANDIDATES = 16;

export class ComputerTargetError extends Error {
  readonly code: ComputerTargetErrorCode;
  readonly candidates: readonly ComputerTargetCandidate[];
  readonly notFound: boolean;

  constructor(input: {
    readonly code: ComputerTargetErrorCode;
    readonly message: string;
    readonly candidates?: readonly ComputerTargetCandidate[];
    readonly notFound?: boolean;
  }) {
    const candidates = input.candidates ?? [];
    // Candidates go in the message, not only in the field beside it. This error
    // reaches the model through MCP tool results and WsRpcError, and only the
    // first of those carries the field, so a "no such label" that names the real
    // ones structurally is still a dead end everywhere else. The whole
    // refuse-rather-than-guess design depends on the caller being able to see
    // what it should have asked for.
    super(messageWithCandidates(input.message, candidates));
    this.name = "ComputerTargetError";
    this.code = input.code;
    this.candidates = candidates;
    this.notFound = input.notFound ?? input.code === "computer_target_not_found";
  }
}

export function resolveComputerPoint(
  target: ComputerTarget,
  screenSize: ComputerScreenSize,
): ComputerPoint {
  const hasX = typeof target.x === "number";
  const hasY = typeof target.y === "number";
  if (hasX !== hasY) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer coordinate targets must include both x and y.",
    });
  }
  if (!hasX || !hasY) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer actions require x/y coordinates or a labelled target.",
    });
  }
  const point = { x: target.x, y: target.y } as ComputerPoint;
  if (point.x < 0 || point.y < 0 || point.x >= screenSize.width || point.y >= screenSize.height) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target (${point.x}, ${point.y}) is outside the ${screenSize.width}x${screenSize.height} screen.`,
      candidates: [],
    });
  }
  return point;
}

export function resolveComputerSemanticTarget(
  root: ComputerUiNode,
  target: ComputerTarget,
): ComputerTargetMatch {
  const match = resolveUiTreeTarget({
    pool: flattenUiTree(root, childrenOf).filter((node) => matchesWindow(node, target.windowId)),
    query: { label: target.label, role: target.role },
    spec: computerTargetSpec(target),
  });
  if (!match.onScreen) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target ${describeTarget(target)} is off-screen; refusing to guess a click.`,
      candidates: candidateDescriptions([match.node]),
    });
  }
  return { node: match.node, point: activationPointForNode(match.node) };
}

/**
 * A bare window id names the window itself rather than a control in it — the
 * shape "scroll this window" arrives as. The match is the window's own node:
 * the first node carrying that id in document order, which is the window's
 * root. Returns undefined when the tree does not describe the window at all,
 * so the caller can fall back to the window list's geometry.
 */
export function resolveComputerWindowTarget(
  root: ComputerUiNode,
  windowId: string,
): ComputerTargetMatch | undefined {
  const node = flattenUiTree(root, childrenOf).find((candidate) => candidate.windowId === windowId);
  if (node === undefined) return undefined;
  if (!node.onScreen) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer window ${JSON.stringify(windowId)} is off-screen; refusing to guess a scroll point.`,
      candidates: candidateDescriptions([node]),
    });
  }
  return { node, point: activationPointForNode(node) };
}

/**
 * The desktop's half of the shared resolver.
 *
 * Three of these deliberately differ from the iOS family rather than having
 * drifted: a role is compared verbatim because AT-SPI role names are a fixed
 * vocabulary rather than free text, `onScreen` is trusted because the perception
 * source computed it against the real workspace rect, and labels keep their
 * surrounding space because nothing trims a label arriving over MCP and a match
 * that ignored the difference would act on a control the caller did not name.
 */
function computerTargetSpec(target: ComputerTarget): UiTreeTargetSpec<ComputerUiNode> {
  return {
    labelOf: matchableLabel,
    matchesRole: (node, role) => node.role === role,
    matchKey: (label) => label.toLocaleLowerCase(),
    // Promotion to "this is the label, exactly" is case-sensitive here while the
    // substring test is not, which is how the desktop family has always behaved.
    exactKey: (label) => label,
    isOnScreen: (node) => node.onScreen,
    preferOnScreen: false,
    noMatch: (pool) =>
      new ComputerTargetError({
        code: "computer_target_not_found",
        message: `No visible computer target matched ${describeTarget(target)}.`,
        candidates: candidateDescriptions(pool),
        notFound: true,
      }),
    ambiguous: (matches) =>
      new ComputerTargetError({
        code: "computer_target_ambiguous",
        message: `Computer target ${describeTarget(target)} matched more than one control.`,
        candidates: candidateDescriptions(matches),
      }),
  };
}

export function activationPointForNode(node: ComputerUiNode): ComputerPoint {
  return uiTreeActivationPoint(node);
}

export function candidateDescriptions(
  nodes: readonly ComputerUiNode[],
): readonly ComputerTargetCandidate[] {
  return nodes.slice(0, MAX_REPORTED_CANDIDATES).map((node) => ({
    label: node.label ?? node.description ?? "(unlabelled)",
    role: node.role,
    windowId: node.windowId,
    onScreen: node.onScreen,
    frame: node.frame,
  }));
}

export function computerTargetCandidates(root: ComputerUiNode): readonly ComputerTargetCandidate[] {
  return candidateDescriptions(flattenUiTree(root, childrenOf));
}

// ── Actionable-element digest ───────────────────────────────────────

/**
 * The roles that can be acted on semantically, across the two vocabularies the
 * desktop family speaks (AT-SPI's lowercase role names and macOS AX spellings).
 * Static text is deliberately absent: it fills the digest with lines nothing
 * can be done with.
 */
const ACTIONABLE_ROLES = new Set([
  // Buttons.
  "push button",
  "button",
  "toggle button",
  // Text entry.
  "entry",
  "text field",
  "text-field",
  "search field",
  // Stateful controls.
  "check box",
  "radio button",
  "combo box",
  "list box",
  "switch",
  "slider",
  "spin button",
  // Navigation.
  "link",
  "page tab",
  "menu item",
  "check menu item",
  "radio menu item",
]);

/** Longest element list one digest may carry before it reports incompleteness. */
const ELEMENT_DIGEST_MAX_LENGTH = 60;
/** Longest label or value one element may carry. */
const ELEMENT_TEXT_MAX_LENGTH = 80;

export interface ComputerActionableElement {
  readonly role: string;
  readonly label: string;
  /** Current contents of an editable control, truncated. Absent otherwise. */
  readonly value?: string;
  readonly windowId: string | null;
}

export interface ComputerActionableElements {
  readonly items: readonly ComputerActionableElement[];
  /**
   * False when the tree carried more actionable elements than fit. The caller
   * should say so — an element missing from a truncated digest still exists.
   */
  readonly complete: boolean;
}

/**
 * The labeled, on-screen, actionable elements of a UI tree — what a model
 * grounds on instead of estimating pixel coordinates from a screenshot.
 *
 * Only labeled elements are listed, because targeting is by label: an
 * unlabeled control cannot be addressed semantically, and listing it would
 * push the caller back toward coordinates. Off-screen elements are excluded
 * too — semantic resolution refuses off-screen targets, so naming them would
 * invite a refused action; scrolling brings them on screen and they appear in
 * the next digest. Duplicate labels are kept: two same-labeled controls is
 * real ambiguity the caller should see rather than have silently resolved.
 */
export function actionableElements(root: ComputerUiNode): ComputerActionableElements {
  const items: ComputerActionableElement[] = [];
  let overflow = false;
  const walk = (node: ComputerUiNode): void => {
    if (overflow) return;
    const collectible =
      ACTIONABLE_ROLES.has(node.role) &&
      node.onScreen &&
      node.windowId !== null &&
      matchableLabel(node) !== "";
    if (collectible && items.length < ELEMENT_DIGEST_MAX_LENGTH) {
      const label = clampTextToLength(matchableLabel(node), ELEMENT_TEXT_MAX_LENGTH);
      items.push({
        role: node.role,
        label,
        // An entry's empty value is real information — "this field is blank" —
        // so presence, not truthiness, decides.
        ...(node.value !== null && node.value !== undefined
          ? { value: clampTextToLength(node.value, 40) }
          : {}),
        windowId: node.windowId,
      });
    } else if (collectible && items.length >= ELEMENT_DIGEST_MAX_LENGTH) {
      // The list is full and something actionable did not fit: that has to be
      // said out loud, or the caller reads a truncated digest as the truth.
      overflow = true;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return { items, complete: !overflow };
}

export function describeTarget(target: ComputerTarget): string {
  const parts = [
    target.label ? `label=${JSON.stringify(target.label)}` : null,
    target.role ? `role=${JSON.stringify(target.role)}` : null,
    target.windowId ? `window=${JSON.stringify(target.windowId)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "the supplied coordinates";
}

const childrenOf = (node: ComputerUiNode): readonly ComputerUiNode[] => node.children;

/**
 * The text a label is matched against: an unlabelled control is still
 * addressable by whatever it describes itself as.
 *
 * Deliberately falls back to the empty string rather than to the
 * `"(unlabelled)"` placeholder a candidate listing shows, so that placeholder
 * never becomes a label the caller can accidentally match on.
 */
function matchableLabel(node: ComputerUiNode): string {
  return node.label ?? node.description ?? "";
}

function matchesWindow(node: ComputerUiNode, windowId: string | undefined): boolean {
  return windowId === undefined || node.windowId === windowId;
}

/** One candidate as a single line, short enough that sixteen of them still read. */
function describeCandidate(candidate: ComputerTargetCandidate): string {
  const window =
    candidate.windowId === null ? "" : ` in window ${JSON.stringify(candidate.windowId)}`;
  return `${candidate.role} ${JSON.stringify(candidate.label)}${window}`;
}

function messageWithCandidates(
  message: string,
  candidates: readonly ComputerTargetCandidate[],
): string {
  if (candidates.length === 0) return message;
  return `${message} Controls in the accessibility tree: ${candidates.map(describeCandidate).join("; ")}.`;
}
