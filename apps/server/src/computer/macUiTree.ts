/**
 * Parsing the macOS helper's accessibility forest into a `ComputerUiNode`.
 *
 * The helper walks the AX tree of every on-screen window and emits nodes whose
 * `frame`/`activationPoint` are in **global** top-left screen coordinates — the
 * same space `CGWindowList` and the pointer path use — because macOS AX,
 * `CGWindow` bounds, and `CGEvent` all share one coordinate system with no
 * conversion (only AppKit needs the Y-flip, which the helper does before it
 * emits). This module shifts that forest into the agent's 0-based space and
 * clamps every free-form string to its contract bound, so one window labelling a
 * widget with a paragraph of text cannot fail the schema encode of the whole
 * `computer.getState` payload.
 *
 * It is the macOS analog of `fuseAtspiTrees`, but without the Plasma
 * decoration-offset arithmetic that path needs: AX already reports desktop
 * coordinates here, so there is nothing to re-anchor, only to translate.
 *
 * @module computer/macUiTree
 */
import {
  COMPUTER_LABEL_MAX_LENGTH,
  COMPUTER_TEXT_MAX_LENGTH,
  type ComputerPoint,
  type ComputerScreenSize,
  type ComputerUiNode,
  type ComputerWindowId,
} from "@synara/contracts";

import { asFiniteNumber, asRecord, asString, parseComputerRect } from "./computerGeometry.ts";
import { clampNodeText } from "./uiTreeText.ts";

const NODE_ROLE_MAX_LENGTH = 128;
/** Matches the schema's `nodePath` depth cap so a write address stays addressable. */
const NODE_PATH_MAX_DEPTH = 64;
/** A hard ceiling on children per node, well under the schema's, to bound a runaway tree. */
const NODE_CHILDREN_MAX = 2_048;

function clampNullable(text: string | null | undefined, maxLength: number): string | null {
  return text === null || text === undefined ? null : clampNodeText(text, maxLength);
}

function parsePath(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const path: number[] = [];
  for (const entry of value.slice(0, NODE_PATH_MAX_DEPTH)) {
    const index = asFiniteNumber(entry);
    if (index === undefined || index < 0 || !Number.isInteger(index)) return undefined;
    path.push(index);
  }
  return path;
}

function isOnScreen(
  frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  screenSize: ComputerScreenSize | undefined,
): boolean {
  if (frame.width <= 0 || frame.height <= 0) return false;
  if (!screenSize) return true;
  return (
    frame.x < screenSize.width &&
    frame.y < screenSize.height &&
    frame.x + frame.width > 0 &&
    frame.y + frame.height > 0
  );
}

function parseNode(
  value: unknown,
  origin: ComputerPoint,
  screenSize: ComputerScreenSize | undefined,
  windowIdFromParent: ComputerWindowId | null,
  depth: number,
): ComputerUiNode | undefined {
  if (depth > NODE_PATH_MAX_DEPTH) return undefined;
  const record = asRecord(value);
  const rawFrame = parseComputerRect(record.frame);
  if (!rawFrame) return undefined;
  // Global → agent space, the one translation this whole module exists to do.
  const frame = {
    x: rawFrame.x - origin.x,
    y: rawFrame.y - origin.y,
    width: rawFrame.width,
    height: rawFrame.height,
  };
  const rawWindowId = asString(record.windowId);
  const windowId = (rawWindowId ? rawWindowId : windowIdFromParent) as ComputerWindowId | null;
  const rawActivation = record.activationPoint;
  let activationPoint: ComputerPoint | null = null;
  if (rawActivation !== null && rawActivation !== undefined) {
    const activationRecord = asRecord(rawActivation);
    const ax = asFiniteNumber(activationRecord.x);
    const ay = asFiniteNumber(activationRecord.y);
    if (ax !== undefined && ay !== undefined) {
      activationPoint = { x: ax - origin.x, y: ay - origin.y };
    }
  }
  const path = parsePath(record.nodePath ?? record.path);
  const rawChildren = Array.isArray(record.children) ? record.children : [];
  const children: ComputerUiNode[] = [];
  for (const child of rawChildren.slice(0, NODE_CHILDREN_MAX)) {
    const parsed = parseNode(child, origin, screenSize, windowId, depth + 1);
    if (parsed) children.push(parsed);
  }
  return {
    role: clampNodeText(asString(record.role) ?? "unknown", NODE_ROLE_MAX_LENGTH),
    label: clampNullable(asString(record.label), COMPUTER_LABEL_MAX_LENGTH),
    value: clampNullable(asString(record.value), COMPUTER_TEXT_MAX_LENGTH),
    description: clampNullable(asString(record.description), COMPUTER_TEXT_MAX_LENGTH),
    frame,
    activationPoint,
    onScreen: record.onScreen === false ? false : isOnScreen(frame, screenSize),
    windowId,
    ...(path ? { nodePath: [...path] } : {}),
    ...(record.accessibilityRoot === "menu-bar" || record.accessibilityRoot === "menu-bar-extra"
      ? { accessibilityRoot: record.accessibilityRoot }
      : {}),
    ...(record.editable === true ? { editable: true } : {}),
    // The helper marks a node whose walk hit its budget. Dropping it here left
    // the agent unable to tell a partial subtree from a complete one.
    ...(record.truncated === true ? { truncated: true } : {}),
    children,
  };
}

/**
 * The desktop root the helper emitted, in agent space and clamped. Returns
 * `undefined` when the payload carries no usable root, which the backend treats
 * the same way the KWin path treats an absent AT-SPI tree: perception degrades
 * to windows-only rather than failing the state.
 */
export function parseMacUiForest(
  payload: unknown,
  screenSize: ComputerScreenSize | undefined,
  origin: ComputerPoint,
): ComputerUiNode | undefined {
  // The helper always wraps the desktop node in `root` (Accessibility.swift);
  // an unwrapped payload was never a shape it could send, and accepting one
  // meant a malformed reply got parsed as a node instead of degrading.
  return parseNode(asRecord(payload).root, origin, screenSize, null, 0);
}
