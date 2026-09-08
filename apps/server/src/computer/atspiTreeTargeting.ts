import {
  COMPUTER_TEXT_MAX_LENGTH,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerUiNode,
  type ComputerWindow,
  type ComputerWindowId,
} from "@synara/contracts";

import { requireWindowBounds } from "./computerGeometry.ts";
import { clampTextToLength } from "./utf8Truncation.ts";

/**
 * The bounds `ComputerUiNode` is encoded against. An accessible name is whatever
 * the application put there — a toolkit that labels a paragraph widget with its
 * entire text, or a document title that is a full sentence per line — and
 * nothing between the toolkit and the schema caps it. Copying one through
 * verbatim fails the encode of the whole tree, which takes `computer.getState`
 * down over a single oversized label somewhere on the desktop.
 *
 * Mirrored rather than imported because the contracts package exports the text
 * bound and keeps the label one private; they are checked against each other in
 * this module's tests.
 */
const NODE_ROLE_MAX_LENGTH = 128;
const NODE_LABEL_MAX_LENGTH = 1_024;
const NODE_TEXT_MAX_LENGTH = COMPUTER_TEXT_MAX_LENGTH;

/** The small, serializable subset returned by the AT-SPI helper. */
export interface AtspiRawNode {
  readonly role: string;
  readonly label: string | null;
  readonly value: string | null;
  readonly description: string | null;
  /** AT-SPI reports these extents in the client coordinate space on Wayland. */
  readonly frame: ComputerRect;
  readonly activationPoint?: ComputerPoint | null;
  /** Child-index path from the window root, as the helper walked the tree. */
  readonly path?: readonly number[];
  /** The accessible exposes the `EditableText` interface. */
  readonly editable?: boolean;
  readonly children: readonly AtspiRawNode[];
}

/** Everything the helper needs to re-resolve one node for a semantic write. */
export interface AtspiNodeAddress {
  readonly windowId: ComputerWindowId;
  readonly path: readonly number[];
}

export interface AtspiClientSize {
  readonly width: number;
  readonly height: number;
}

export interface AtspiWindowTree {
  readonly windowId: ComputerWindowId;
  readonly clientSize: AtspiClientSize;
  readonly root: AtspiRawNode;
}

export interface DecorationOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * Derive the frame-to-client decoration offset used by the Phase 0 probe.
 *
 * Plasma's Wayland AT-SPI implementation reports widget extents relative to
 * the client surface. The observed frame has equal four-pixel side/bottom
 * borders and a 34-pixel title bar, so the horizontal difference is split
 * across both sides and the remaining vertical difference is the title bar.
 */
export function decorationOffsetForClientSize(
  frame: Pick<ComputerRect, "width" | "height">,
  client: AtspiClientSize,
): DecorationOffset {
  const horizontalDifference = Math.max(0, frame.width - client.width);
  const verticalDifference = Math.max(0, frame.height - client.height);
  const sideBorder = horizontalDifference / 2;
  return {
    x: sideBorder,
    y: Math.max(0, verticalDifference - sideBorder),
  };
}

/**
 * Fuse one helper tree with the frame bounds supplied by the KWin plugin.
 * Every descendant receives the owning window id so semantic targeting can
 * constrain matches without guessing which application owns a control.
 */
export function fuseAtspiWindowTree(input: {
  readonly window: Pick<ComputerWindow, "id" | "bounds">;
  readonly tree: AtspiWindowTree;
  readonly screenSize?: ComputerScreenSize;
}): ComputerUiNode {
  // A fused node's frame is desktop-absolute, so the window's own origin is the
  // one input this cannot do without: without it every AT-SPI coordinate would
  // be frame-relative while claiming to be a desktop coordinate, which is the
  // clamp bug the Tier 1 runs already produced once.
  const bounds = requireWindowBounds(input.window, "accessibility-tree targeting");
  const offset = decorationOffsetForClientSize(bounds, input.tree.clientSize);
  return fuseNode(input.tree.root, {
    windowId: input.window.id,
    origin: {
      x: bounds.x + offset.x,
      y: bounds.y + offset.y,
    },
    ...(input.screenSize ? { screenSize: input.screenSize } : {}),
  });
}

/** Combine multiple fused window trees into the root consumed by uiTreeTargeting. */
export function fuseAtspiTrees(input: {
  readonly windows: readonly ComputerWindow[];
  readonly trees: readonly AtspiWindowTree[];
  readonly screenSize: ComputerScreenSize;
}): ComputerUiNode {
  const windowsById = new Map(input.windows.map((window) => [window.id, window]));
  const children: ComputerUiNode[] = [];
  for (const tree of input.trees) {
    const window = windowsById.get(tree.windowId);
    if (!window || !window.visible || window.minimized) continue;
    children.push(fuseAtspiWindowTree({ window, tree, screenSize: input.screenSize }));
  }
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "AT-SPI desktop",
    frame: { x: 0, y: 0, width: input.screenSize.width, height: input.screenSize.height },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children,
  };
}

/**
 * The address of a node a semantic text write may target, or `undefined` when
 * the perception source cannot address it: a node with no editable-text
 * interface, no child-index path, or no owning window has to be typed into.
 */
export function atspiTextWriteAddress(node: ComputerUiNode): AtspiNodeAddress | undefined {
  if (node.editable !== true || node.windowId === null || node.windowId === undefined) {
    return undefined;
  }
  const path = node.nodePath;
  if (!path || !path.every((index) => Number.isInteger(index) && index >= 0)) return undefined;
  return { windowId: node.windowId, path: [...path] };
}

export function describeComputerUiTree(root: ComputerUiNode): string {
  const lines: string[] = [];
  const visit = (node: ComputerUiNode, depth: number): void => {
    const label = node.label ?? node.description ?? "(unlabelled)";
    lines.push(
      `${"  ".repeat(depth)}${node.role}: ${label}${node.value ? ` = ${node.value}` : ""}`,
    );
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines.join("\n");
}

function fuseNode(
  node: AtspiRawNode,
  input: {
    readonly windowId: ComputerWindowId;
    readonly origin: ComputerPoint;
    readonly screenSize?: ComputerScreenSize;
  },
): ComputerUiNode {
  const frame = {
    x: input.origin.x + node.frame.x,
    y: input.origin.y + node.frame.y,
    width: node.frame.width,
    height: node.frame.height,
  } satisfies ComputerRect;
  const activationPoint = node.activationPoint
    ? {
        x: input.origin.x + node.activationPoint.x,
        y: input.origin.y + node.activationPoint.y,
      }
    : null;
  return {
    role: clampNodeText(node.role, NODE_ROLE_MAX_LENGTH),
    label: clampNullableNodeText(node.label, NODE_LABEL_MAX_LENGTH),
    value: clampNullableNodeText(node.value, NODE_TEXT_MAX_LENGTH),
    description: clampNullableNodeText(node.description, NODE_TEXT_MAX_LENGTH),
    frame,
    activationPoint,
    onScreen: isOnScreen(frame, input.screenSize),
    windowId: input.windowId,
    ...(node.path ? { nodePath: [...node.path] } : {}),
    ...(node.editable === true ? { editable: true } : {}),
    children: node.children.map((child) => fuseNode(child, input)),
  };
}

/**
 * `text` cut to `maxLength` characters with a marker in place of the tail.
 *
 * Kept as this module's name for the shared surrogate-safe clamp, because every
 * caller here is talking about a UI node's text.
 */
export function clampNodeText(text: string, maxLength: number): string {
  return clampTextToLength(text, maxLength);
}

function clampNullableNodeText(text: string | null | undefined, maxLength: number): string | null {
  return text === null || text === undefined ? null : clampNodeText(text, maxLength);
}

function isOnScreen(frame: ComputerRect, screenSize: ComputerScreenSize | undefined): boolean {
  if (!screenSize) return true;
  return (
    frame.x < screenSize.width &&
    frame.y < screenSize.height &&
    frame.x + frame.width > 0 &&
    frame.y + frame.height > 0
  );
}
