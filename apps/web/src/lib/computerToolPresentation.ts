// FILE: computerToolPresentation.ts
// Purpose: Say what a desktop tool call actually does, in the words a person would use,
//          for the approval card and the transcript.
// Layer: Web UI logic
// Exports: COMPUTER_TOOL_TITLES, isComputerToolName, describeComputerToolCall
//
// Every browser tool has a curated presentation and every computer tool had
// none, so an approval for the most consequential thing Synara can do — moving a
// pointer on the user's own machine — read
// `mcp__synara__computer_click  x 812  y 344`, which is the raw wire call. The
// decision the user is being asked to make is "click *what*", and the answer is
// assembled here: verb, where, and which window, resolved from the window list
// the pane already receives rather than left as an opaque id.

import type { ComputerWindow } from "@synara/contracts";

/** The gateway's desktop tools, and the verb each one performs. */
export const COMPUTER_TOOL_TITLES = {
  computer_screenshot: "Take a screenshot",
  computer_get_state: "Read the screen",
  computer_get_screen_size: "Measure the screen",
  computer_list_windows: "List windows",
  computer_click: "Click",
  computer_double_click: "Double-click",
  computer_right_click: "Right-click",
  computer_move_cursor: "Move the cursor",
  computer_drag: "Drag",
  computer_scroll: "Scroll",
  computer_type_text: "Type",
  computer_press_key: "Press a key",
  computer_hotkey: "Press a shortcut",
  computer_set_value: "Set a field",
  computer_perform_action: "Activate a control",
  computer_launch_app: "Open an app",
  computer_read_clipboard: "Read the clipboard",
  computer_write_clipboard: "Write to the clipboard",
} as const;

export type ComputerToolName = keyof typeof COMPUTER_TOOL_TITLES;

/**
 * The bare tool name inside whatever wrapping a provider applied, or null.
 * Providers surface the same gateway tool as `computer_click`,
 * `mcp__synara__computer_click`, and other permutations, so identity is
 * recovered from the suffix rather than matched exactly.
 */
export function computerToolName(candidate: string | null | undefined): ComputerToolName | null {
  if (!candidate) return null;
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  for (const name of Object.keys(COMPUTER_TOOL_TITLES) as ComputerToolName[]) {
    if (normalized === name || normalized.endsWith(`_${name}`)) return name;
  }
  return null;
}

export function isComputerToolName(candidate: string | null | undefined): boolean {
  return computerToolName(candidate) !== null;
}

export interface ComputerToolCallDescription {
  readonly tool: ComputerToolName;
  /** One line: verb, target, window. Never the raw arguments. */
  readonly summary: string;
  /** The arguments worth showing, already named and formatted. */
  readonly params: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/**
 * "Click at (812, 344) in Safari — Google".
 *
 * `windows` is the live window list, used only to turn an opaque `window_id`
 * into the app and title a person recognises. Without a match the id is dropped
 * rather than printed: an id tells the user nothing they can check against what
 * is on their screen.
 */
export function describeComputerToolCall(input: {
  readonly toolName: string | null | undefined;
  readonly args: Readonly<Record<string, unknown>> | undefined;
  readonly windows?: readonly ComputerWindow[] | undefined;
}): ComputerToolCallDescription | null {
  const tool = computerToolName(input.toolName);
  if (tool === null) return null;
  const args = input.args ?? {};
  const verb = COMPUTER_TOOL_TITLES[tool];
  const where = describeTarget(args, input.windows);
  const what = describePayload(tool, args);

  const summary = [verb, what, where].filter((part) => part.length > 0).join(" ");
  return { tool, summary, params: describeParams(tool, args, input.windows) };
}

/** "at (812, 344) in Safari — Google", "on “Save” in Notes", or "". */
function describeTarget(
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
): string {
  const parts: string[] = [];
  const label = readString(args.label);
  const x = readNumber(args.x);
  const y = readNumber(args.y);
  if (label) {
    parts.push(`on “${label}”`);
  } else if (x !== null && y !== null) {
    parts.push(`at (${x}, ${y})`);
  }
  const window = resolveWindow(args.window_id, windows);
  if (window) parts.push(`in ${window}`);
  return parts.join(" ");
}

/** The thing being typed, pressed, or scrolled — the part that is not a target. */
function describePayload(tool: ComputerToolName, args: Readonly<Record<string, unknown>>): string {
  if (tool === "computer_type_text" || tool === "computer_set_value") {
    const text = readString(args.text) ?? readString(args.value);
    return text === null ? "" : `“${truncate(text, 60)}”`;
  }
  if (tool === "computer_write_clipboard") {
    const text = readString(args.text) ?? readString(args.value);
    return text === null ? "" : `“${truncate(text, 60)}”`;
  }
  if (tool === "computer_press_key") {
    const key = readString(args.key);
    return key === null ? "" : `${key}`;
  }
  if (tool === "computer_hotkey") {
    const keys = readStringArray(args.keys);
    return keys.length > 0 ? keys.join("+") : "";
  }
  if (tool === "computer_scroll") {
    const dx = readNumber(args.delta_x) ?? 0;
    const dy = readNumber(args.delta_y) ?? 0;
    if (dy !== 0) return dy > 0 ? "down" : "up";
    if (dx !== 0) return dx > 0 ? "right" : "left";
    return "";
  }
  if (tool === "computer_launch_app") {
    const app = readString(args.app) ?? readString(args.name) ?? readString(args.bundle_id);
    return app ?? "";
  }
  return "";
}

/**
 * The argument rows, named for a reader rather than for the wire. A coordinate
 * pair is one row, not two, because it is one fact.
 */
function describeParams(
  tool: ComputerToolName,
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  const rows: Array<{ name: string; value: string }> = [];
  const x = readNumber(args.x);
  const y = readNumber(args.y);
  if (x !== null && y !== null) rows.push({ name: "Position", value: `${x}, ${y}` });
  const label = readString(args.label);
  if (label) rows.push({ name: "Target", value: label });
  const role = readString(args.role);
  if (role) rows.push({ name: "Role", value: role });
  const window = resolveWindow(args.window_id, windows);
  if (window) rows.push({ name: "Window", value: window });
  const text = readString(args.text) ?? readString(args.value);
  if (text !== null && text.length > 0) {
    rows.push({
      // The clipboard is not a text field, and calling both "Text" is how a
      // clipboard write reads as typing into whatever has focus.
      name: tool === "computer_write_clipboard" ? "Clipboard" : "Text",
      value: truncate(text, 200),
    });
  }
  const key = readString(args.key);
  if (key) rows.push({ name: "Key", value: key });
  const keys = readStringArray(args.keys);
  if (keys.length > 0) rows.push({ name: "Shortcut", value: keys.join("+") });
  const dx = readNumber(args.delta_x);
  const dy = readNumber(args.delta_y);
  if (dx !== null || dy !== null) {
    rows.push({ name: "Scroll", value: `${dx ?? 0}, ${dy ?? 0}` });
  }
  const action = readString(args.action);
  if (action) rows.push({ name: "Action", value: action });
  const app = readString(args.app) ?? readString(args.name) ?? readString(args.bundle_id);
  if (app) rows.push({ name: "App", value: app });
  return rows;
}

function resolveWindow(
  windowId: unknown,
  windows: readonly ComputerWindow[] | undefined,
): string | null {
  const id = readString(windowId);
  if (!id || !windows) return null;
  const match = windows.find((window) => window.id === id);
  if (!match) return null;
  const app = match.appName?.trim();
  const title = match.title?.trim();
  if (app && title && title !== app) return `${app} — ${truncate(title, 48)}`;
  return app || (title ? truncate(title, 48) : null);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
