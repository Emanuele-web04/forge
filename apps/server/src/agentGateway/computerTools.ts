import { cursorToolActivity } from "../computer/cursorActivity.ts";
import {
  assertDesktopOperationActive,
  desktopOperationSignal,
} from "../computer/DesktopOperationQueue.ts";
import { setTimeout as waitForComputer } from "node:timers/promises";
/** Agent-facing desktop perception and control tools. */
import { Effect } from "effect";

import {
  COMPUTER_DRAG_MAX_DURATION_MS,
  COMPUTER_HOTKEY_MAX_KEYS,
  COMPUTER_KEY_NAME_MAX_LENGTH,
  COMPUTER_MODIFIERS_MAX_ITEMS,
  COMPUTER_SEMANTIC_ACTION_MAX_LENGTH,
  COMPUTER_TEXT_MAX_LENGTH,
  COMPUTER_WAIT_MAX_MS,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerInputModifier,
  type ComputerPermission,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@synara/contracts";

import { actionableElements, ComputerTargetError } from "../computer/uiTreeTargeting.ts";
import { waitForControl } from "../computer/waitForControl.ts";
import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  ComputerBackendError,
  type ComputerAgentDialect,
  type ComputerCaptureRequest,
} from "../computer/ComputerBackend.ts";
import {
  computerSetupSignal,
  computerSetupToolNote,
  type ComputerSetupSignal,
} from "../computer/computerSetupSignal.ts";
import {
  ComputerLeaseError,
  ComputerManager,
  type ComputerActionObservation,
} from "../computer/ComputerManager.ts";
import {
  ScreenshotFrameRegistry,
  screenshotDeltaToDesktop,
  screenshotPointToDesktop,
  screenshotRectToDesktop,
} from "../computer/screenshotFrames.ts";
import { PROVIDERS_WITHOUT_APPROVAL_GATE } from "./approvalGate.ts";
import { DELIVERY_VERDICT_GUIDANCE } from "./computerGuidance.ts";
import {
  mcpToolResultError,
  mcpToolResultJson as formatToolResultJson,
  type McpToolCallResult,
} from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readBooleanArg,
  readNumberArg,
  readRecordArg,
  readStringArg,
  readStringArrayArg,
  readVerbatimStringArg,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

export const COMPUTER_CONTROL_CAPABILITY = "computer:control" as const;

/**
 * Re-exported so a caller reaching for the computer family's gate finds it, and
 * so nothing is tempted to declare a second copy. The set itself lives in
 * `approvalGate.ts`, shared with the device family — it used to be declared
 * once per family, and a provider added to one list and not the other was a
 * silent bypass.
 */
export { PROVIDERS_WITHOUT_APPROVAL_GATE };

export const COMPUTER_APPROVAL_REQUIRED_TOOLS = new Set([
  // The one read in this set on purpose: the clipboard is the human's, and it
  // can hold something they copied privately — a password manager entry, a
  // token — that is not otherwise visible to the agent. Reading it must never
  // be auto-approved the way perception tools are.
  "computer_read_clipboard",
  "computer_launch_app",
  "computer_click",
  "computer_double_click",
  "computer_triple_click",
  "computer_right_click",
  // `computer_move_cursor` is deliberately absent: it moves the agent's own
  // overlay, posts only mouse movement, and never aims the keyboard, so there is
  // nothing for a human to approve. It was gated when a hover still re-pointed
  // the keyboard at whatever it passed over.
  "computer_drag",
  "computer_scroll",
  "computer_type_text",
  "computer_press_key",
  "computer_hotkey",
  "computer_write_clipboard",
  "computer_set_value",
  "computer_perform_action",
  // The only tool whose whole effect is on what the human sees on their own
  // screen, which is exactly why it is gated.
  "computer_activate_window",
]);

export function computerToolRequiresApproval(name: string): boolean {
  return COMPUTER_APPROVAL_REQUIRED_TOOLS.has(name);
}

/** Computer tools are deferred and capability-gated. Providers with tool search
 * discover them when needed without preloading the schemas into coding turns. */
export interface AgentGatewayComputerToolsOptions {
  readonly manager: ComputerManager;
  readonly authorizeAction?: (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /**
   * Called when a tool call failed because the OS is withholding a privacy
   * grant Synara needs. The gateway turns it into one actionable chat card;
   * the tool result is returned unchanged either way, so this must not fail.
   */
  readonly onSetupRequired?: (input: {
    readonly toolName: string;
    /** The grants to name on the card; empty when the backend named none. */
    readonly missing: readonly ComputerPermission[];
    /**
     * How the backend's build is signed, when it knows. The card says nothing
     * about stale grants without it, and must not on a signed build.
     */
    readonly buildSignature?: ComputerBuildSignature;
    /** The app macOS holds responsible for the grants, when the desktop shell reported one. */
    readonly bundleId?: string;
    readonly context: ToolContext;
  }) => Effect.Effect<void>;
}

/**
 * What an observed action hands back: the result alone, for the actions the
 * gateway photographs afterwards, or a result that already carries its own
 * observation. `result` is the discriminator — a `ComputerActionResult` has no
 * such field.
 */
type ObservedActionOutcome =
  | ComputerActionResult
  | {
      readonly result: ComputerActionResult;
      readonly observation?: ComputerActionObservation;
    };

/**
 * The prose every computer tool used to repeat, said once.
 *
 * Eleven of these tools carried the same three or four paragraphs — how a
 * coordinate is read, what the post-action screenshot is, what a delivery
 * verdict means, where keys land — which is around twelve thousand characters
 * of identical text resident in every session that loads the family. MCP has
 * one place for exactly this: the server's `initialize.instructions`, delivered
 * once. Each tool now carries the short form and a pointer to the section,
 * which is enough for a model reading a single tool definition in isolation and
 * costs a line rather than a page.
 *
 * The sections are named so a description can point at one by name. Keep those
 * names in step with the pointers below.
 *
 * @see makeAgentGatewayComputerTools — the tool descriptions that reference these.
 */
export function computerToolInstructions(): string {
  return [
    "## Synara computer use",
    "",
    "These notes apply to every computer_* tool. The tool descriptions are the short form of them.",
    "",
    "### Pointing at the desktop",
    SCREENSHOT_FRAME_NOTE,
    POINTER_COORDINATE_NOTE,
    SEMANTIC_TARGETING_NOTE,
    "",
    "### The screenshot on every action",
    ACTION_SCREENSHOT_NOTE,
    "",
    "### Aiming the keyboard",
    KEYBOARD_TARGET_NOTE,
    "",
    "### Reading a delivery verdict",
    DELIVERY_NOTE,
    "",
    "### When a computer tool refuses",
    REFUSAL_NOTE,
    "A computer_input_paused refusal means input is suspended, while screenshots still work. Stop sending mutations, including activation or launch attempts. Tell the user which window needs attention and what remains. After the user returns it, call computer_get_state scoped to that window to check readiness before continuing. Resume from the current form contents; do not replay completed fields.",
    "",
    "### Form progress and handback",
    "When submission is forbidden, do not use Enter to finish a form dropdown: it can submit the form if the popup has closed. Prefer clicking the visible option. If using typeahead or arrows, leave the control with Tab or Escape and verify its value. A dropdown value write may be a no-op even when the accessibility API accepts it.",
    "Read the form before filling it and collect missing choices together when they determine later fields. Use computer_set_value for addressable fields and respect character limits. A successful delivery is not proof of the intended field's contents: check meaningful section boundaries and the final required values using the returned observations, without adding a screenshot after every keystroke. Read new state after revealing conditional fields. Never blindly repeat typing, paste, or checkbox toggles. At handback, distinguish verified values, attempted but unverified values, and missing fields, and preserve the user's submission boundary.",
  ].join("\n");
}

/**
 * One wording for how the model points at things, shared by every tool that
 * returns an image: it points into the picture it was given, in that picture's
 * own pixels, and the server does the geometry (see screenshotFrames.ts). The
 * model is never asked to turn a screenshot pixel into a desktop coordinate —
 * the harnesses behind the Codex app and Anthropic's computer tool do not ask
 * either, and the arithmetic that did (region + pixel / scale across offset,
 * downscaled captures) was where clicks went astray.
 */
const SCREENSHOT_FRAME_NOTE =
  "Every screenshot comes back with a screenshotId and its width and height in pixels; to point at something in it, pass x/y as pixel coordinates in that image, measured from its top-left corner, and the server maps them onto the desktop.";

/**
 * Both clipboard tools must say the same thing about ownership: the desktop has
 * one clipboard and the human is the other party using it.
 */
const SHARED_CLIPBOARD_NOTE =
  "The desktop has a single clipboard shared with the human user, not a private one for the agent.";

const POINTER_COORDINATE_NOTE =
  "x/y are pixel coordinates in a screenshot you received — by default the most recent one this conversation was given, otherwise the one named by screenshot_id — measured from that image's top-left corner. A window screenshot keeps input scoped to that window even if another app covers it. Never hide, minimize, activate, or rearrange the user's other windows to recover from an input error, including through shell commands or AppleScript. If input is refused, report the obstruction instead of changing targets. Never convert screenshot pixels into desktop coordinates yourself; the server does that. Point at what you can see: if you have not looked at the desktop yet, or a window has moved or resized since your last screenshot, take a new screenshot first.";

/** The short form each pointer tool carries in place of the paragraph above. */
const POINTER_COORDINATE_HINT =
  'x/y are pixels in a screenshot you were already given (the latest, or the one named by screenshot_id) — never desktop coordinates, and never converted by you. See "Pointing at the desktop" in this server\'s instructions.';

/**
 * The parity lever for visual grounding: when the model knows a control's
 * label from get_state, label-targeting resolves to that exact control, while
 * a pixel estimate from a downscaled screenshot can land a few points off.
 */
const SEMANTIC_TARGETING_NOTE =
  'Prefer "label" (plus optional "role") from the latest computer_get_state elements list over raw x/y whenever the control appears there.';

/**
 * Every mutating action carries its own after-screenshot so the model can act
 * on the result directly instead of spending a separate perception round trip
 * — the see-act loop is one model turn per action, not two.
 *
 * It says the observation is downscaled, and where to get more detail, because
 * an action screenshot spends a smaller pixel budget than a perception one: an
 * agent that cannot read a label in it must know the answer is one
 * `computer_screenshot` away rather than that the label is unreadable.
 */
const ACTION_SCREENSHOT_NOTE = `Every mutating computer tool returns a screenshot taken shortly after the action, zoomed to the window the action affected — the window it named, or the window under its coordinates — falling back to the whole workspace when neither identifies one, capped at ${COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION} pixels on its longest side so a typical application window comes back at full resolution. It becomes the screenshot your next x/y are measured in: read the next state from it and aim your next action at its pixels instead of making a separate screenshot call, and request another observation only when detail is unreadable or the expected page/content has not appeared. Pass include_screenshot: false on an action whose picture you will not read — an action in the middle of a chain in one response — and never on the last one, because skipping it and then calling computer_screenshot costs the extra round trip the attached screenshot exists to avoid. When the new capture and its coordinate mapping are identical to the latest screenshot delivered to this conversation, the result reports screenshotUnchanged instead of repeating the image: keep reading the previous one, which remains the screenshot your coordinates refer to. Unchanged means the pixels did not move, not that the action failed — the screen may not have settled yet, and Synara has already checked whether the action opened a new window and photographed that instead if it did — so use computer_wait with label and window_id for a known next control, or a fresh screenshot if accessibility is unavailable. Never blind-retry an action. After loading, scrolling, or rearranging controls, discard earlier coordinates; prefer a live label target, which is resolved again immediately before input. When the action closed its own target window, the result reports targetWindowClosed instead of a screenshot — the picture of a different window would not show your action's outcome.`;

/** The short form the action tools carry. */
const ACTION_SCREENSHOT_HINT =
  'The result carries a screenshot taken shortly after the action, zoomed to the window it affected; read your next coordinates from it. See "The screenshot on every action" in this server\'s instructions.';

const INCLUDE_ACTION_SCREENSHOT_PROPERTY = {
  include_screenshot: {
    type: "boolean",
    description:
      "Attach an observation, default true. Skip only intermediate actions. Never pass false on the last action before inspecting its result.",
  },
} as const;

const KEYBOARD_TARGET_NOTE =
  "Pass window_id to aim input at a specific window. On macOS this never raises or activates it. Otherwise keys go to the last aimed window. A click, drag, scroll, or explicit keyboard window_id aims the keyboard; computer_move_cursor only moves the agent cursor. With no target or a closed target, input is refused: aim first instead of retrying unchanged.";

/** The short form the keyboard tools carry. */
const KEYBOARD_TARGET_HINT =
  'Keys go where the agent seat is aimed: click into the window first, or pass window_id. A hover does not aim it. See "Aiming the keyboard" in this server\'s instructions.';

/** Delivery is judged from the result, never by replaying an action blindly. */
const DELIVERY_NOTE = DELIVERY_VERDICT_GUIDANCE;

/**
 * The refusals a model has to tell apart, because the right response to each is
 * different and two of them are not failures at all.
 *
 * `computer_human_active` in particular was documented nowhere: the agent gives
 * way when the person touches their own keyboard or mouse, which is the feature
 * working, and a model that reads it as a broken desktop stops instead of
 * waiting two seconds.
 */
const REFUSAL_NOTE =
  "A refusal names a code. computer_human_active means the person is using their keyboard or mouse right now and the agent deliberately gave way — it is the feature working, not a fault: wait a moment and send the same action again. computer_controlled_by_other_thread means another conversation holds the desktop; reading it still works, so re-plan or come back rather than fighting for it. computer_target_ambiguous means more than one control matched: read the candidates the error lists and narrow with role, with window_id, or by pointing at pixels, rather than repeating the same target. computer_target_not_found means the snapshot no longer shows it: take a fresh computer_get_state first. computer_target_offscreen means the coordinate is outside the window you scoped it to. ComputerApprovalRequired means this session cannot ask the user, so the action was refused before it ran: say so and do not retry it. A refusal reports that nothing was delivered, which is exactly what makes it safe to correct and send again — unlike an unverified delivery.";

/** The short form the input tools carry. */
const DELIVERY_HINT =
  'The result may carry delivery.verified; only "unconfirmed" is worth checking the screen over, and no verdict justifies a blind retry. See "Reading a delivery verdict" in this server\'s instructions.';

function keyboardTargetProperty(): Record<string, unknown> {
  return {
    window_id: {
      type: "string",
      description:
        "Window id to aim keyboard input at. Selects the agent keyboard target without activating another macOS app. Defaults to the last aimed window.",
    },
  };
}

/**
 * Modifiers held down for the whole gesture and released after it.
 *
 * Not expressible with computer_hotkey, which presses and releases: by the time
 * the click arrived nothing was held and the application saw a plain click. So
 * shift-click, cmd-click and ctrl-scroll had no reachable spelling at all.
 */
const MODIFIERS_PROPERTY = {
  modifiers: {
    type: "array",
    items: { type: "string", enum: ["ctrl", "alt", "shift", "meta"] },
    maxItems: COMPUTER_MODIFIERS_MAX_ITEMS,
    description:
      "Keys held during this gesture. On macOS, meta is Command. Omit for an unmodified gesture.",
  },
} as const;

function withActionScreenshotSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    properties: {
      ...(schema.properties as Record<string, unknown>),
      ...INCLUDE_ACTION_SCREENSHOT_PROPERTY,
      wait_for_label: {
        type: "string",
        description: "Wait up to 2s for this label in the affected window before capturing.",
      },
    },
  };
}

const SCREENSHOT_ID_PROPERTY = {
  screenshot_id: {
    type: "string",
    description: "Coordinate frame id. Defaults to this conversation's latest screenshot.",
  },
} as const;

const TARGET_PROPERTIES = {
  x: {
    type: "number",
    description: "X pixel from the screenshot's left edge.",
  },
  y: {
    type: "number",
    description: "Y pixel from the screenshot's top edge.",
  },
  ...SCREENSHOT_ID_PROPERTY,
  label: {
    type: "string",
    description: "Exact accessible label from computer_get_state, including whitespace.",
  },
  role: { type: "string", description: "Optional accessible role used to disambiguate a label." },
} as const;

/** Pointer targeting reveals the same window the input will reach. */
function targetProperties(): Record<string, unknown> {
  return {
    ...TARGET_PROPERTIES,
    window_id: {
      type: "string",
      description:
        "Optional window id from computer_list_windows. With a label it picks which window the label is resolved in. With x/y it scopes the coordinate to that window: input is routed to that window even if another window overlaps; macOS does not raise or activate it, and the click is refused if the coordinate is outside the window. For computer_scroll it is also a target on its own, scrolling the window itself.",
    },
  };
}

function approvalUnavailableResult(name: string): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: "ComputerApprovalRequired",
        message: `${name} requires explicit user approval, and this provider session has no approval gate. The action was refused before it ran.`,
      },
    }),
    isError: true,
  };
}

/**
 * The refusal carries a code and `retryable` rather than only prose so a model
 * can tell "wait and try again" apart from the target and approval failures it
 * must fix before retrying.
 */
function leaseErrorResult(error: ComputerLeaseError): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: { code: error.code, message: error.message, retryable: error.retryable },
    }),
    isError: true,
  };
}

function targetErrorResult(error: ComputerTargetError): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        notFound: error.notFound,
        candidates: error.candidates,
      },
    }),
    isError: true,
  };
}

/**
 * Whether a target was actually given, decided by what survived reading rather
 * than by which keys the model happened to emit. Models routinely spell an
 * omitted optional field as an explicit `null`, and a key-presence test reads
 * `{"x": null}` as "has a target" and then hands the manager an empty target,
 * which is refused as `computer_target_invalid` — a hard failure for a request
 * that plainly meant "no target".
 */
function hasTargetFields(target: ComputerTarget): boolean {
  return Object.keys(target).length > 0;
}

/** Accepts both spellings, because models emit the camelCase one either way. */
function readWindowIdArg(args: Record<string, unknown>): string | undefined {
  return readStringArg(args, "window_id") ?? readStringArg(args, "windowId");
}

function readScreenshotIdArg(args: Record<string, unknown>): string | undefined {
  return readStringArg(args, "screenshot_id") ?? readStringArg(args, "screenshotId");
}

/**
 * A target as the model wrote it: x/y still in screenshot pixels, plus the
 * screenshot they belong to. It becomes a `ComputerTarget` only once the
 * frame registry has turned the pixels into a desktop point.
 */
interface ScreenshotTarget extends ComputerTarget {
  readonly screenshotId?: string;
}

function readScreenshotTarget(args: Record<string, unknown>): ScreenshotTarget {
  const x = readNumberArg(args, "x");
  const y = readNumberArg(args, "y");
  const screenshotId = readScreenshotIdArg(args);
  // Verbatim, never trimmed: the targeters match a label exactly as given (see
  // uiTreeTargeting's `computerTargetSpec`), so trimming here silently
  // retargeted a caller that named "Save " at a different control called "Save".
  const label = readVerbatimStringArg(args, "label");
  const role = readStringArg(args, "role");
  const windowId = readWindowIdArg(args);
  return {
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(screenshotId !== undefined ? { screenshotId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
  };
}

function readNestedScreenshotTarget(args: Record<string, unknown>, name: string): ScreenshotTarget {
  const value = readRecordArg(args, name);
  if (!value) throw new ToolInputError(`Missing required argument "${name}".`);
  return readScreenshotTarget(value);
}

function readDelta(args: Record<string, unknown>, name: string): number {
  const value = readNumberArg(args, name);
  if (value === undefined) throw new ToolInputError(`Missing required argument "${name}".`);
  return value;
}

const DEFAULT_DRAG_DURATION_MS = 250;
/**
 * Clamped rather than refused: the caller's intent is clear, only the scale is
 * wrong.
 *
 * The contract's bound is enforced here as well as declared in the JSON Schema
 * because nothing validates MCP tool arguments against that schema before
 * dispatch: an unclamped `duration_ms` of 1e9 is a drag that holds the button —
 * and the exclusive desktop lease — for eleven days.
 */
function readDragDurationMs(args: Record<string, unknown>): number {
  const value = readNumberArg(args, "duration_ms");
  if (value === undefined) return DEFAULT_DRAG_DURATION_MS;
  return Math.min(COMPUTER_DRAG_MAX_DURATION_MS, Math.max(0, value));
}

function readRawRequiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new ToolInputError(`Argument "${name}" must be a string.`);
  return value;
}

function readRequiredText(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "text");
  if (value.length > COMPUTER_TEXT_MAX_LENGTH)
    throw new ToolInputError('Argument "text" is too long.');
  return value;
}

/**
 * The `computer_set_value` payload. Bounded like `readRequiredText` because
 * MCP arguments are never validated against the tool's JSON Schema: an
 * unbounded value that falls back to typed keystrokes would hold the exclusive
 * desktop lease — and the turn — for hours typing it out.
 */
function readSetValueValue(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "value");
  if (value.length > COMPUTER_TEXT_MAX_LENGTH)
    throw new ToolInputError('Argument "value" is too long.');
  return value;
}

/**
 * The hotkey chord. Every key becomes a press/release pair holding the seat,
 * so thousands of keys would hold it indefinitely; the bound is enforced here
 * rather than trusted to the JSON Schema for the same reason as above.
 */
function readHotkeyKeys(args: Record<string, unknown>): readonly string[] {
  const keys =
    readStringArrayArg(args, "keys") ??
    (() => {
      throw new ToolInputError('Missing required argument "keys".');
    })();
  if (keys.length > COMPUTER_HOTKEY_MAX_KEYS) {
    throw new ToolInputError(`Argument "keys" accepts at most ${COMPUTER_HOTKEY_MAX_KEYS} keys.`);
  }
  const oversized = keys.find((key) => key.length > COMPUTER_KEY_NAME_MAX_LENGTH);
  if (oversized !== undefined) {
    throw new ToolInputError(
      `Each key in "keys" is at most ${COMPUTER_KEY_NAME_MAX_LENGTH} characters; got one of ${oversized.length}.`,
    );
  }
  return keys;
}

function readActionName(args: Record<string, unknown>): string {
  const value = readStringArg(args, "action", { required: true })!;
  if (value.length > COMPUTER_SEMANTIC_ACTION_MAX_LENGTH) {
    throw new ToolInputError(
      `Argument "action" is longer than ${COMPUTER_SEMANTIC_ACTION_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

/** Bounded in bytes rather than characters: the backend pipes it to a process. */
function readClipboardText(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "text");
  if (Buffer.byteLength(value, "utf8") > MAX_COMPUTER_CLIPBOARD_BYTES) {
    throw new ToolInputError(
      `Argument "text" is longer than the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte clipboard limit.`,
    );
  }
  return value;
}

const CAPTURE_REGION_KEYS = ["x", "y", "width", "height"] as const;

/**
 * No target at all is the third, deliberate form: capture whatever window has
 * focus. It is resolved by the manager rather than here because focus is a
 * live property of the desktop, not of the request.
 */
type ScreenshotRequest =
  | ComputerCaptureRequest
  | { readonly kind: "focused"; readonly maxDimension?: number };

/**
 * The window and rect request forms are mutually exclusive on purpose: a
 * window id and a loose rect disagree about what "the region" is, and silently
 * preferring one would hand the model a screenshot of the wrong thing.
 *
 * A rect arrives in the pixels of the screenshot the model is zooming into;
 * `mapRegion` turns it into the desktop rect the backend captures.
 */
function readCaptureRequest(
  args: Record<string, unknown>,
  mapRegion: (region: ComputerRect) => ComputerRect,
): ScreenshotRequest {
  const windowId = readWindowIdArg(args);
  const present = CAPTURE_REGION_KEYS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );
  const maxDimension = readCaptureMaxDimension(args);
  const limit = maxDimension === undefined ? {} : { maxDimension };

  if (windowId !== undefined) {
    if (present.length > 0) {
      throw new ToolInputError(
        'Pass either "window_id" or the region arguments "x", "y", "width" and "height", never both.',
      );
    }
    return { kind: "window", windowId, ...limit };
  }
  if (present.length === 0) {
    return { kind: "focused", ...limit };
  }
  if (present.length < CAPTURE_REGION_KEYS.length) {
    const missing = CAPTURE_REGION_KEYS.filter((key) => !present.includes(key));
    throw new ToolInputError(
      `A screenshot region needs "x", "y", "width" and "height". Missing: ${missing.join(", ")}.`,
    );
  }
  const region = {
    x: readNumberArg(args, "x")!,
    y: readNumberArg(args, "y")!,
    width: readNumberArg(args, "width")!,
    height: readNumberArg(args, "height")!,
  };
  if (region.width <= 0 || region.height <= 0) {
    throw new ToolInputError('Arguments "width" and "height" must be greater than zero.');
  }
  return { kind: "region", region: mapRegion(region), ...limit };
}

/**
 * Clamped to the agent image budget rather than to the backend's native ceiling.
 *
 * A larger request is not merely wasteful, it is wrong: a vision API downscales
 * anything past roughly 1568 px on its long edge before the model sees it, so
 * the model would read coordinates off a picture the server never produced and
 * every click would land short. The schema advertises the same maximum, and
 * this enforces it, because nothing validates MCP arguments against a schema.
 */
function readCaptureMaxDimension(args: Record<string, unknown>): number | undefined {
  const value = readNumberArg(args, "max_dimension");
  if (value === undefined) return undefined;
  if (value < 1) throw new ToolInputError('Argument "max_dimension" must be at least 1.');
  return Math.min(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION, Math.floor(value));
}

const COMPUTER_MODIFIERS: readonly ComputerInputModifier[] = ["ctrl", "alt", "shift", "meta"];

/**
 * The modifiers to hold across a gesture, refusing a name this desktop cannot
 * press rather than silently dropping it — a shift-click delivered as a plain
 * click is a selection replaced instead of extended, and nothing in the result
 * would say so.
 */
function readModifiers(args: Record<string, unknown>): readonly ComputerInputModifier[] {
  const raw = readStringArrayArg(args, "modifiers");
  if (raw === undefined || raw.length === 0) return [];
  const modifiers = raw.map((entry) => entry.trim().toLowerCase());
  const unknown = modifiers.find(
    (entry) => !COMPUTER_MODIFIERS.includes(entry as ComputerInputModifier),
  );
  if (unknown !== undefined) {
    throw new ToolInputError(
      `Argument "modifiers" accepts only ${COMPUTER_MODIFIERS.join(", ")}; got ${JSON.stringify(unknown)}.`,
    );
  }
  return [...new Set(modifiers as ComputerInputModifier[])];
}

/**
 * Clamped rather than refused, like the drag duration: the caller's intent is
 * clear and only the scale is wrong. The ceiling is what keeps a model that
 * reads "wait for the installer" as minutes from stalling the whole turn behind
 * a sleep nothing can interrupt.
 */
function readWaitDurationMs(args: Record<string, unknown>): number {
  const value = readNumberArg(args, "duration_ms");
  if (value === undefined) throw new ToolInputError('Missing required argument "duration_ms".');
  return Math.min(COMPUTER_WAIT_MAX_MS, Math.max(0, Math.floor(value)));
}

function isToolResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * The availability a manager result carries, for the results that carry one.
 *
 * Looks inside an already-built tool result too, because the perception reads
 * that matter most build one themselves: `computer_get_state` returns image
 * content beside its JSON, so its availability rode in a text part rather than
 * on a plain object and the permission-required branch could never fire for the
 * one tool an agent reaches for first. Every text part this module produces is
 * `JSON.stringify` of its own payload, so parsing it back is reading our own
 * writing, not guessing at someone else's format.
 */
function resultAvailability(value: unknown): ComputerAvailability | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (isToolResult(value)) return resultAvailability(toolResultPayload(value));
  const availability = (value as { readonly availability?: unknown }).availability;
  if (typeof availability !== "object" || availability === null) return undefined;
  return availability as ComputerAvailability;
}

/** The decoded JSON payload of a tool result's text part, when it has one. */
function toolResultPayload(result: McpToolCallResult): Record<string, unknown> | undefined {
  const part = result.content.find((entry) => entry.type === "text");
  if (part?.type !== "text") return undefined;
  try {
    const parsed: unknown = JSON.parse(part.text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces a permission-blocked result's user-facing prose with one line aimed
 * at the model.
 *
 * The availability message is written for the person reading the setup card —
 * where to click in System Settings, why the switch may already look on — and
 * handing it to an agent produced essays about macOS privacy instead of the one
 * sentence the situation needs. The card is already on screen; the model's part
 * is to stop. The rest of the payload is untouched, because a result can be
 * genuinely useful (a window list, a screen size) and still report a grant that
 * is missing.
 */
function withSetupNote(value: unknown, signal: ComputerSetupSignal | undefined): unknown {
  if (signal === undefined || typeof value !== "object" || value === null) return value;
  const availability = resultAvailability(value);
  return {
    ...(value as Record<string, unknown>),
    ...(availability?.kind === "permission-required"
      ? { availability: { kind: availability.kind, missing: availability.missing } }
      : {}),
    setupRequired: computerSetupToolNote(signal),
  };
}

/**
 * The setup note on whatever shape the call produced, which is the whole point:
 * it used to reach only plain-object results, and every result that carries a
 * screenshot — a screenshot, a state read with an image, every observed action
 * — is already a built tool result, as is every error. So the model was handed
 * the card's existence with none of the instruction that goes with it on
 * exactly the paths where a grant is most likely to be the reason it is stuck.
 *
 * A JSON text part gains a `setupRequired` field; anything else gains a
 * trailing paragraph, which is the honest fallback for prose.
 */
function withSetupNoteOnResult(
  result: McpToolCallResult,
  signal: ComputerSetupSignal | undefined,
): McpToolCallResult {
  if (signal === undefined) return result;
  const note = computerSetupToolNote(signal);
  const index = result.content.findIndex((entry) => entry.type === "text");
  if (index === -1) {
    return { ...result, content: [...result.content, { type: "text", text: note }] };
  }
  const part = result.content[index];
  if (part?.type !== "text") return result;
  const content = [...result.content];
  content[index] = { type: "text", text: withSetupNoteInText(part.text, note) };
  return { ...result, content };
}

function withSetupNoteInText(text: string, note: string): string {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `${text}\n\n${note}`;
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), setupRequired: note });
}

export function makeAgentGatewayComputerTools(
  options: AgentGatewayComputerToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager, onSetupRequired } = options;
  /**
   * The screenshots each thread has been shown, so its x/y can be read as
   * pixels in one of them. Lives with the tools rather than the manager
   * because it is the tool surface's contract with the model: the manager
   * and the pane keep speaking desktop coordinates.
   */
  const frames = new ScreenshotFrameRegistry();

  /**
   * PNG bytes travel as MCP image content and the metadata as the text part.
   * Delivering is also remembering: the screenshot becomes the frame the
   * thread's next x/y are measured in, and the metadata carries the id that
   * lets the model name it later.
   */
  const deliverScreenshot = (
    threadId: string,
    payload: Record<string, unknown>,
    screenshot: ComputerScreenshot,
    windowId?: string,
  ): McpToolCallResult => {
    assertDesktopOperationActive();
    const { bytesBase64, ...metadata } = screenshot;
    const frame = frames.record(threadId, screenshot, windowId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...payload,
            screenshot: {
              ...(frame ? { screenshotId: frame.id } : {}),
              ...(windowId !== undefined ? { windowId } : {}),
              ...metadata,
            },
          }),
        },
        { type: "image", data: bytesBase64, mimeType: "image/png" },
      ],
    };
  };

  const capturedScreenshotResult = (
    threadId: string,
    request: ComputerCaptureRequest,
    screenshot: ComputerScreenshot,
  ): McpToolCallResult =>
    deliverScreenshot(
      threadId,
      { computerId: manager.computerId },
      screenshot,
      request.kind === "window" ? request.windowId : undefined,
    );

  /**
   * The model's target as the manager understands it: screenshot pixels
   * become a desktop point through the frame they were measured in. A target
   * with no coordinates (a label, or nothing) passes through untouched, and a
   * half coordinate is left for the manager to refuse with its usual message.
   */
  const resolveTarget = (target: ScreenshotTarget, threadId: string): ComputerTarget => {
    const { screenshotId, ...rest } = target;
    if (typeof target.x !== "number" || typeof target.y !== "number") return rest;
    const frame = frames.resolve(threadId, screenshotId);
    return {
      ...rest,
      ...(rest.windowId === undefined && frame.windowId !== undefined
        ? { windowId: frame.windowId }
        : {}),
      ...screenshotPointToDesktop(frame, target.x, target.y),
    };
  };

  const readTarget = (args: Record<string, unknown>, context: ToolContext): ComputerTarget =>
    resolveTarget(readScreenshotTarget(args), context.callerThreadId);

  const readNestedTarget = (
    args: Record<string, unknown>,
    name: string,
    context: ToolContext,
  ): ComputerTarget =>
    resolveTarget(readNestedScreenshotTarget(args, name), context.callerThreadId);

  /**
   * Raise the chat's setup card for this call, if it earned one, and hand the
   * result back either way. A card is user-facing feedback about the tool call,
   * never a substitute for answering it.
   */
  const withSetupCard = (
    name: string,
    context: ToolContext,
    signal: ComputerSetupSignal | undefined,
    result: McpToolCallResult,
  ): Effect.Effect<McpToolCallResult> => {
    if (onSetupRequired === undefined || signal === undefined) return Effect.succeed(result);
    return onSetupRequired({
      toolName: name,
      missing: signal.missing,
      ...(signal.buildSignature === undefined ? {} : { buildSignature: signal.buildSignature }),
      ...(signal.bundleId === undefined ? {} : { bundleId: signal.bundleId }),
      context,
    }).pipe(Effect.as(result));
  };

  const handle =
    (
      name: string,
      run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
    ) =>
    (args: Record<string, unknown>, context: ToolContext) =>
      Effect.tryPromise({
        try: async (abortSignal) => {
          if (
            computerToolRequiresApproval(name) &&
            PROVIDERS_WITHOUT_APPROVAL_GATE.has(context.callerProvider)
          ) {
            if (!options.authorizeAction)
              return { result: approvalUnavailableResult(name), signal: undefined };
            if (!(await options.authorizeAction(name, args, context, abortSignal))) {
              return {
                result: mcpToolResultError(
                  "Computer action was denied or cancelled; no input was sent.",
                ),
                signal: undefined,
              };
            }
          }
          // Recorded before the call, because the call is what claims the
          // desktop, and the badge has to name this thread from the first
          // action rather than from the second.
          manager.setThreadLabel(context.callerThreadId, context.callerThreadLabel);
          const readOnly = [
            "computer_get_state",
            "computer_screenshot",
            "computer_list_windows",
            "computer_get_screen_size",
            "computer_wait",
          ].includes(name);
          const withActivity = readOnly
            ? manager.withAgentReadActivity.bind(manager)
            : manager.withAgentActivity.bind(manager);
          const value = await withActivity(
            context.callerThreadId,
            async () => {
              await Effect.runPromise(context.assertCallerTurnActive(), { signal: abortSignal });
              abortSignal.throwIfAborted();
              return manager.cursorActivity.during(
                context.callerThreadId,
                cursorToolActivity(name),
                () => run(args, context),
              );
            },
            abortSignal,
          );
          // A call can succeed and still report that the desktop is out of
          // reach: a perception read answers with a `permission-required`
          // availability, and a missing Screen Recording grant blocks nothing at
          // all yet leaves the agent blind. Both are the user's to fix, so both
          // take the same route to the same card as a thrown refusal.
          //
          // Awaited rather than remembered: the read costs a round trip only
          // when the last one saw a gap, and that is exactly the moment it must
          // not be answered from memory — the call after the user grants the
          // permission is the one that has to see it land.
          const signal = computerSetupSignal({
            availability: resultAvailability(value),
            missing: await manager.missingPermissions(),
            buildSignature: manager.buildSignature(),
          });
          return {
            // The note reaches both shapes. A plain object takes it as a field
            // on the payload; a result the handler already built — anything
            // carrying a screenshot — takes it in its text part.
            result: isToolResult(value)
              ? withSetupNoteOnResult(value, signal)
              : mcpToolResultJson(withSetupNote(value, signal)),
            signal,
          };
        },
        catch: (error) => error,
      }).pipe(
        Effect.flatMap(({ result, signal }) => withSetupCard(name, context, signal, result)),
        Effect.catch((error) => {
          const failure =
            error instanceof ComputerBackendError && error.inputPause
              ? {
                  ...mcpToolResultJson({
                    error: { code: "computer_input_paused", ...error.inputPause, retryable: false },
                  }),
                  isError: true,
                }
              : error instanceof ComputerTargetError
                ? targetErrorResult(error)
                : error instanceof ComputerLeaseError
                  ? leaseErrorResult(error)
                  : mcpToolResultError(errorText(error));
          // A missing OS grant is the only failure a user has to act on, so it
          // is the only one that raises a card. Everything else — a target that
          // moved, an undelivered keystroke, arguments the desktop refused — is
          // the agent's to recover from and stays a plain tool error.
          return Effect.promise(() => manager.missingPermissions()).pipe(
            Effect.flatMap((missing) => {
              const signal = computerSetupSignal({
                error,
                missing,
                buildSignature: manager.buildSignature(),
              });
              // The failure path is where the note matters most and where it
              // used to be absent entirely: the model was handed the backend's
              // raw refusal with nothing telling it the user had been asked for
              // a grant, so it explained macOS privacy in prose or retried.
              return withSetupCard(name, context, signal, withSetupNoteOnResult(failure, signal));
            }),
          );
        }),
      );

  const actionEntry = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
    /**
     * Overrides the write annotations for an action that is not one. Only the
     * hover uses it: it posts mouse movement, presses nothing, and never aims the
     * keyboard, so `destructiveHint: true` was telling every provider to treat
     * a look as a change.
     */
    annotations: Record<string, unknown> = WRITE_TOOL_ANNOTATIONS,
  ): ToolEntry => ({
    requiredCapability: COMPUTER_CONTROL_CAPABILITY,
    requiresActiveTurn: true,
    definition: {
      name,
      description,
      inputSchema,
      annotations: { title, ...annotations },
    },
    handler: handle(name, run),
  });

  /**
   * One wording and one shape for a post-action observation, whoever captured
   * it: the generic path here, and the scroll path, which takes its own
   * before/after captures and hands the after one back already taken.
   * Observation is best-effort — the action already happened, so a perception
   * failure must not convert its success into an error result — and no
   * observation degrades to the plain JSON result.
   */
  const withObservation = (
    context: ToolContext,
    result: Record<string, unknown>,
    capture: ComputerActionObservation | undefined,
  ): unknown => {
    if (!capture) return result;
    if ("targetWindowClosed" in capture) {
      return {
        ...result,
        targetWindowClosed: true,
        note: "The window this action targeted no longer exists — the action likely closed it, so no post-action screenshot was taken. Use computer_list_windows or computer_get_state to see the desktop now.",
      };
    }
    const reused = frames.matchLatest(context.callerThreadId, capture.screenshot, capture.windowId);
    if (reused) {
      return {
        ...result,
        screenshotUnchanged: true,
        screenshotId: reused.id,
        screenshot: {
          screenshotId: reused.id,
          windowId: reused.windowId,
          region: reused.region,
          width: reused.width,
          height: reused.height,
          scale: reused.scale,
        },
        note: "The screen is byte-for-byte what your previous screenshot showed, with the same coordinates. Continue using this screenshotId. This does not prove the action missed; wait and look again before repeating an action.",
      };
    }
    return deliverScreenshot(context.callerThreadId, result, capture.screenshot, capture.windowId);
  };

  /**
   * The generic path: the action ran, now go and look at it. Reads
   * `include_screenshot` itself, because an action that took no observation
   * must not pay for one here either.
   */
  const observeAfterAction = async (
    args: Record<string, unknown>,
    result: ComputerActionResult,
    context: ToolContext,
  ): Promise<unknown> => {
    if (readBooleanArg(args, "include_screenshot") === false) return result;
    const label = readVerbatimStringArg(args, "wait_for_label");
    const windowId = result.windowId;
    const readiness =
      label === undefined
        ? undefined
        : windowId === undefined
          ? { status: "unavailable", waitedMs: 0 }
          : await waitForControl(
              () => manager.getState({ includeTree: true, windowId }),
              { label, windowId },
              2_000,
              desktopOperationSignal(),
            ).catch((error: unknown) => {
              // Input already happened. A failed observation must not imply it is
              // safe to send that input again; cancellation still stops the turn.
              assertDesktopOperationActive();
              return { status: "unavailable", note: errorText(error) };
            });
    // The clamped point when the display server moved the pointer, because the
    // window under where the action actually landed is the one it affected.
    return withObservation(
      context,
      readiness === undefined ? result : { ...result, readiness },
      await manager.captureActionScreenshot(
        result.windowId,
        result.clampedTo ?? result.point,
        context.callerThreadId,
        readiness === undefined,
      ),
    );
  };

  /**
   * An action whose visible outcome matters: every pointer, keyboard, and
   * semantic action goes through here so its result carries the screenshot.
   * Launching an app does not — its window appears seconds later, so a capture
   * taken now would only show the desktop from before the launch — and neither
   * does writing the clipboard, which changes nothing on screen.
   *
   * An action that already observed itself returns its own capture alongside
   * the result and is not photographed a second time: scrolling has to capture
   * before and after to measure its travel, and the after capture is the same
   * picture this would otherwise take.
   */
  const observedActionEntry = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<ObservedActionOutcome>,
    annotations: Record<string, unknown> = WRITE_TOOL_ANNOTATIONS,
  ): ToolEntry =>
    actionEntry(
      name,
      title,
      `${description} ${ACTION_SCREENSHOT_HINT}`,
      withActionScreenshotSchema(inputSchema),
      async (args, context) => {
        if (args.wait_for_label !== undefined) {
          if (!readStringArg(args, "wait_for_label")?.trim()) {
            throw new Error("wait_for_label must be a nonempty label.");
          }
          if (readBooleanArg(args, "include_screenshot") === false) {
            throw new Error("wait_for_label requires the action screenshot.");
          }
        }
        const outcome = await run(args, context);
        return "result" in outcome && args.wait_for_label === undefined
          ? withObservation(context, outcome.result, outcome.observation)
          : observeAfterAction(args, "result" in outcome ? outcome.result : outcome, context);
      },
      annotations,
    );

  const dialect = manager.agentDialect;
  const pointerTargetProperties = targetProperties();
  const keyboardTargetProperties = keyboardTargetProperty();

  const targetSchema = {
    type: "object",
    properties: pointerTargetProperties,
    additionalProperties: false,
  } as const;

  /** A pointer target that may also hold modifiers across the gesture. */
  const modifiedTargetSchema = {
    type: "object",
    properties: { ...pointerTargetProperties, ...MODIFIERS_PROPERTY },
    additionalProperties: false,
  } as const;

  /** One click family, four click counts, one description shape. */
  const clickEntry = (
    name: string,
    title: string,
    lead: string,
    run: (
      threadId: string,
      target: ComputerTarget,
      modifiers: readonly ComputerInputModifier[],
    ) => Promise<ComputerActionResult>,
  ): ToolEntry =>
    observedActionEntry(
      name,
      title,
      `${lead} ${SEMANTIC_TARGETING_NOTE} ${POINTER_COORDINATE_HINT}`,
      modifiedTargetSchema,
      async (args, context) =>
        run(context.callerThreadId, readTarget(args, context), readModifiers(args)),
    );

  return [
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_list_windows",
        description: `List visible desktop windows and their bounds without touching the pointer. Windows come back topmost-first: stackingIndex is 0 for the topmost window and grows downward, and occludedBy names the overlapping windows stacked above each one. A plain x/y click lands on whatever is topmost at that point, so when the window you want is occluded, pass its id as window_id alongside x/y to scope the click to it. When present, active reports which window the desktop considers activated. That is diagnostic, not a prerequisite: input aimed with window_id preserves its target. On macOS it leaves window stacking and user focus alone; never activate or hide another app to recover.${windowListCompletenessNote(dialect)}`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "List computer windows", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_list_windows", async () => manager.listWindows()),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_state",
        description: `Read the current desktop state, and call this before acting: the result lists every labeled actionable control (buttons, text fields, checkboxes...) as "elements", and targeting those by label is far more reliable than estimating pixel coordinates from a screenshot. Each element carries role, label, windowId, and an editable control's current value. It returns no screenshot unless you ask for one, so it does not on its own give you a frame to point x/y into — the pointer tools need one. With include_screenshot it adds the entire desktop workspace across every monitor, scaled down; ${SCREENSHOT_FRAME_NOTE} Window bounds and cursor positions in the JSON are desktop coordinates, useful for telling windows apart but not for aiming: aim by label, or with screenshot pixels. Use computer_screenshot when workspace detail is too small to read. include_text adds a full accessibility-text rendering of the tree on top of the elements list; request it or a screenshot only when needed because both increase payload size. If accessibility.unavailableWindowIds includes your window, use scoped screenshots; repeated tree reads will not restore missing accessibility. Do not activate, move, or hide windows to obtain it. On a busy desktop the elements list is capped: when it reports elementsTruncated it also reports elementsOmitted, the number of matching controls it could not fit, and window_id or label_contains narrows the list rather than leaving you to guess which prefix you were shown.`,
        inputSchema: {
          type: "object",
          properties: {
            include_screenshot: {
              type: "boolean",
              description:
                "Attach a downscaled screenshot of the whole workspace. Defaults to false. Pass true when you need a frame to point x/y into, or when the labels are not enough to tell you what is on screen.",
            },
            include_text: {
              type: "boolean",
              description:
                "Attach the whole accessibility tree rendered as text, on top of the elements list. Defaults to false; it is large, so ask only when the elements list is not enough.",
            },
            window_id: {
              type: "string",
              description:
                "Restrict the elements list to controls in this window (from computer_list_windows). The windows, screen size and screenshot are unaffected.",
            },
            label_contains: {
              type: "string",
              description:
                "Restrict the elements list to controls whose label contains this text, case-insensitively. Use it when the list came back truncated, or to check whether one particular control is on screen.",
            },
          },
          additionalProperties: false,
        },
        annotations: { title: "Get computer state", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_get_state", async (args, context) => {
        // One perception read feeds both renderings: the elements digest always
        // rides (that is what makes labels discoverable), while the full
        // accessibility text rendering stays opt-in for its payload size — and
        // is now only *rendered* when asked for, rather than rendered on every
        // read and discarded here.
        const wantText = readBooleanArg(args, "include_text") ?? false;
        const windowId = readWindowIdArg(args);
        const labelContains =
          readVerbatimStringArg(args, "label_contains") ??
          readVerbatimStringArg(args, "labelContains");
        const state = await manager.getState({
          includeScreenshot: readBooleanArg(args, "include_screenshot") ?? false,
          includeText: wantText,
          includeTree: true,
          ...(windowId ? { windowId } : {}),
        });
        const { text, root, screenshot, ...rest } = state;
        const elements = root
          ? actionableElements(root, {
              ...(windowId === undefined ? {} : { windowId }),
              ...(labelContains === undefined ? {} : { labelContains }),
            })
          : undefined;
        const payload = {
          ...rest,
          ...(wantText && text !== undefined ? { text } : {}),
          ...(elements
            ? {
                elements: elements.items,
                ...(elements.sourceIncomplete ? { elementsSourceIncomplete: true } : {}),
                // Both halves together: "there is more" is only actionable
                // alongside how much more, which is what decides between
                // looking again and narrowing the query.
                ...(elements.complete
                  ? {}
                  : { elementsTruncated: true, elementsOmitted: elements.omitted }),
              }
            : {}),
        };
        if (!screenshot) return mcpToolResultJson(payload);
        return deliverScreenshot(context.callerThreadId, payload, screenshot);
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_screenshot",
        description: `Zoom into one part of the desktop when detail is too small to read in a screenshot you have. With no arguments it captures the window that currently has focus, which is usually the one to look at. Otherwise capture a single window by "window_id" from computer_list_windows, or a rectangle given as "x", "y", "width" and "height" in pixels of the screenshot you are zooming into (the most recent one, or the one named by screenshot_id); never pass both forms. ${SCREENSHOT_FRAME_NOTE} The capture is clipped to the desktop workspace, so it may cover less than requested. A window the desktop cannot photograph honestly — one that is not on screen, or whose position cannot be measured — is refused rather than answered with pixels it cannot place; capture what is visible, or bring the window forward first with computer_activate_window if the user wants it on screen.`,
        inputSchema: {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description:
                "Window id from computer_list_windows. Mutually exclusive with x/y/width/height. Omit both forms to capture the focused window.",
            },
            x: {
              type: "number",
              description:
                "Region left edge, in pixels of the screenshot being zoomed into (the most recent one, or the one named by screenshot_id).",
            },
            y: {
              type: "number",
              description: "Region top edge, in pixels of the same screenshot.",
            },
            width: {
              type: "number",
              description: "Region width in pixels of the same screenshot.",
            },
            height: {
              type: "number",
              description: "Region height in pixels of the same screenshot.",
            },
            ...SCREENSHOT_ID_PROPERTY,
            max_dimension: {
              type: "integer",
              minimum: 1,
              maximum: DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
              description: `Longest screenshot side in pixels before downscaling. Defaults to and is capped at ${DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION}, which is the largest image that reaches you unaltered — ask for more and the picture you see would no longer be the picture your coordinates are mapped against. To read finer detail, capture a smaller region rather than a bigger image.`,
            },
          },
          additionalProperties: false,
        },
        annotations: { title: "Capture computer screenshot", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_screenshot", async (args, context) => {
        const threadId = context.callerThreadId;
        const request = readCaptureRequest(args, (region) =>
          screenshotRectToDesktop(frames.resolve(threadId, readScreenshotIdArg(args)), region),
        );
        if (request.kind === "focused") {
          const capture = await manager.captureFocusedWindow(request.maxDimension);
          return deliverScreenshot(
            threadId,
            { computerId: manager.computerId },
            capture.screenshot,
            capture.windowId,
          );
        }
        return capturedScreenshotResult(
          threadId,
          request,
          await manager.captureScreenshot(request),
        );
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_screen_size",
        description:
          "Read the logical screen dimensions of the desktop workspace. Informational only: pointer tools take pixel coordinates in a screenshot, not screen coordinates.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "Get screen size", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_get_screen_size", async () => manager.getScreenSize()),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_wait",
        description: `Wait for delayed content without sending input or changing focus. Prefer label plus window_id when you know the next control: duration_ms is then a maximum, and the tool returns as soon as that unique control appears, with a screenshot by default. Target it by label afterward so a layout change cannot leave stale coordinates. An unavailable accessibility tree returns immediately; use the screenshot and do not repeat semantic waits until the environment changes. Without label this is a fixed pause with no screenshot. Never repeat the preceding action merely because a page is still loading. Waiting is capped at ${COMPUTER_WAIT_MAX_MS} ms; one accessibility read may finish after the deadline.`,
        inputSchema: {
          type: "object",
          properties: {
            duration_ms: {
              type: "integer",
              minimum: 0,
              maximum: COMPUTER_WAIT_MAX_MS,
              description: `How long to wait, in milliseconds. Clamped to ${COMPUTER_WAIT_MAX_MS}.`,
            },
            label: {
              type: "string",
              description: "The next control's label to wait for. Requires window_id.",
            },
            role: {
              type: "string",
              description: "Optional role to distinguish controls with the same label.",
            },
            window_id: {
              type: "string",
              description: "Window to observe without raising or activating it.",
            },
            ...INCLUDE_ACTION_SCREENSHOT_PROPERTY,
          },
          required: ["duration_ms"],
          additionalProperties: false,
        },
        annotations: { title: "Wait", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_wait", async (args, context) => {
        const durationMs = readWaitDurationMs(args);
        if (args.label !== undefined) {
          const target = readTarget(args, context);
          if (!target.windowId || !target.label?.trim()) {
            throw new Error("A conditional wait requires a nonempty label and window_id.");
          }
          const windowId = target.windowId;
          const readiness = await waitForControl(
            () => manager.getState({ includeTree: true, windowId }),
            target,
            durationMs,
            desktopOperationSignal(),
          );
          const result = { computerId: manager.computerId, ...readiness };
          if (
            readBooleanArg(args, "include_screenshot") === false ||
            readiness.status === "closed"
          ) {
            return result;
          }
          const screenshot = await manager.captureScreenshot({
            kind: "window",
            windowId: target.windowId,
            maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
          });
          return deliverScreenshot(context.callerThreadId, result, screenshot, target.windowId);
        }
        if (durationMs > 0)
          await waitForComputer(durationMs, undefined, { signal: desktopOperationSignal() });
        return { computerId: manager.computerId, waitedMs: durationMs };
      }),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_read_clipboard",
        description: `Read the desktop clipboard as text, returned as "value". ${SHARED_CLIPBOARD_NOTE} It returns whatever was copied last by anyone, so it may hold something the user copied for their own purposes. An empty clipboard returns an empty string; a clipboard holding an image, other non-text content, or more than ${COMPUTER_TEXT_MAX_LENGTH} characters of text is an error.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        // Not READ_ONLY_TOOL_ANNOTATIONS: providers auto-approve on
        // readOnlyHint, and this read must go through approval — the clipboard
        // can hold something the human copied privately. It mutates nothing,
        // hence destructiveHint stays false.
        annotations: {
          title: "Read computer clipboard",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler: handle("computer_read_clipboard", async (_args, context) =>
        manager.readClipboard(context.callerThreadId),
      ),
    },
    actionEntry(
      "computer_launch_app",
      "Launch computer app",
      `Launch an application. ${launchAppNote(dialect)} Waits briefly for one matching window and returns its id without a screenshot. A null window is not a launch failure: use computer_list_windows or computer_get_state instead of launching again.`,
      {
        type: "object",
        properties: {
          app: { type: "string", description: launchAppArgumentNote(dialect) },
          wait_for_window: {
            type: "boolean",
            description: "Wait up to 2s for a window. Defaults to true.",
          },
          arguments: {
            type: "array",
            items: { type: "string" },
            description:
              "Arguments passed to the application, such as a file path to open. Omit for a plain launch.",
          },
        },
        required: ["app"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.launchApp(
          context.callerThreadId,
          readStringArg(args, "app", { required: true })!,
          readStringArrayArg(args, "arguments") ?? [],
          readBooleanArg(args, "wait_for_window") === false ? 0 : 2_000,
        ),
    ),
    clickEntry(
      "computer_click",
      "Click",
      "Click a coordinate or a uniquely labelled visible control. Ambiguous and off-screen targets are refused.",
      (threadId, target, modifiers) => manager.click(threadId, target, modifiers),
    ),
    clickEntry(
      "computer_double_click",
      "Double click",
      "Double-click a coordinate or a uniquely labelled visible control — opens an item, or selects a word in text.",
      (threadId, target, modifiers) => manager.doubleClick(threadId, target, modifiers),
    ),
    clickEntry(
      "computer_triple_click",
      "Triple click",
      "Triple-click a coordinate or a uniquely labelled visible control, which selects the whole line or paragraph under it — the reliable way to replace a field's contents before typing, where computer_set_value is not available. Three separate clicks are not the same gesture and will not select anything; a desktop that cannot send one refuses rather than approximating it.",
      (threadId, target, modifiers) => manager.tripleClick(threadId, target, modifiers),
    ),
    clickEntry(
      "computer_right_click",
      "Right click",
      "Right-click a coordinate or a uniquely labelled visible control to open its context menu.",
      (threadId, target, modifiers) => manager.rightClick(threadId, target, modifiers),
    ),
    observedActionEntry(
      "computer_move_cursor",
      "Move cursor",
      `Move the dedicated computer-use cursor to a coordinate or uniquely labelled visible control. It posts no click and presses nothing: it moves the agent's own visible cursor so the user can see where you are working, and to reveal whatever a hover reveals — a tooltip, a menu that opens on hover, a control that appears only under the pointer. It does not aim the keyboard, so a hover followed by computer_type_text without a window_id is refused rather than typed into whatever the cursor happens to be over. The real system pointer never moves. ${POINTER_COORDINATE_HINT}`,
      targetSchema,
      async (args, context) =>
        manager.moveCursor(context.callerThreadId, readTarget(args, context)),
      // Not destructive and not approval-gated: it changes only where the
      // agent's own overlay is drawn. `readOnlyHint` stays false because
      // something on screen does move, so a provider that surfaces write tools
      // still shows it.
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ),
    observedActionEntry(
      "computer_drag",
      "Drag",
      `Drag between two coordinates or uniquely labelled visible controls, holding the primary button down the whole way — a selection swept across text, a file moved, a slider pulled, a window handle resized. ${dragLimitNote(dialect)} ${POINTER_COORDINATE_HINT}`,
      {
        type: "object",
        properties: {
          from: targetSchema,
          to: targetSchema,
          duration_ms: {
            type: "integer",
            minimum: 0,
            maximum: COMPUTER_DRAG_MAX_DURATION_MS,
            description: `How long the pointer takes to travel, in milliseconds. Defaults to ${DEFAULT_DRAG_DURATION_MS}; clamped to ${COMPUTER_DRAG_MAX_DURATION_MS}. A longer glide helps an application that needs to see the drag in progress, such as a drag-and-drop target that must highlight before the drop.`,
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.drag(
          context.callerThreadId,
          readNestedTarget(args, "from", context),
          readNestedTarget(args, "to", context),
          readDragDurationMs(args),
        ),
    ),
    observedActionEntry(
      "computer_scroll",
      "Scroll",
      `Scroll at an optional target. The target is resolved before the gesture and is never guessed. Scroll distance is measured in pixels of the same screenshot the coordinates are in, so a scroll needs a screenshot even when it names no coordinates at all — roughly 80 pixels per notch of a physical wheel in a full-resolution window capture. Each call is limited to half the captured width/height so successive observations overlap; scroll.limitedTo reports a shortened request in desktop pixels. Read the returned image before scrolling again. Do not blindly repeat a pixel count: attached action images may use a different scale. Some applications gear scrolling up and travel several times the distance requested; browsers commonly do. The result reports what the content actually did in scroll.traveledY, in desktop pixels with the same sign as delta_y, and scrolls are corrected automatically using it: the first large scroll into a window is delivered as a small probe plus a pre-corrected remainder, so ask for the distance you actually want — even the first scroll lands close, and later ones land closer. A traveledY of 0 means the content did not move at all, which usually means the page is already at its edge — a wheel cannot scroll past the top or bottom. If you are scrolling to hunt for a control and accessibility is available, call computer_get_state once: its elements list names the labeled controls on screen, and one of those may already be targetable by label. ${POINTER_COORDINATE_HINT}`,
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          ...MODIFIERS_PROPERTY,
          delta_x: {
            type: "number",
            description:
              "Horizontal scroll distance in screenshot pixels; positive scrolls toward the right of the content.",
          },
          delta_y: {
            type: "number",
            description:
              "Vertical scroll distance in screenshot pixels; positive scrolls toward the end of the content, the way a wheel notch pulled downward does.",
          },
        },
        required: ["delta_x", "delta_y"],
        additionalProperties: false,
      },
      async (args, context) => {
        const threadId = context.callerThreadId;
        const raw = readScreenshotTarget(args);
        const frame = frames.resolve(threadId, raw.screenshotId);
        const resolved = resolveTarget(raw, threadId);
        const target =
          !hasTargetFields(resolved) && frame.windowId !== undefined
            ? { ...resolved, windowId: frame.windowId }
            : resolved;
        // The distance is in the same picture's pixels as the point, so a
        // scroll needs a frame even when it names no point at all.
        const delta = screenshotDeltaToDesktop(
          frame,
          readDelta(args, "delta_x"),
          readDelta(args, "delta_y"),
        );
        // Keep adjacent observations overlapping even when the model repeats
        // a pixel count after the screenshot changes scale.
        const limited = {
          deltaX:
            Math.sign(delta.deltaX) * Math.min(Math.abs(delta.deltaX), frame.region.width / 2),
          deltaY:
            Math.sign(delta.deltaY) * Math.min(Math.abs(delta.deltaY), frame.region.height / 2),
        };
        const modifiers = readModifiers(args);
        const outcome = await manager.scrollCalibrated(
          threadId,
          hasTargetFields(target) ? target : null,
          limited.deltaX,
          limited.deltaY,
          {
            observe: readBooleanArg(args, "include_screenshot") !== false,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          },
        );
        if (
          outcome.result.scroll &&
          (limited.deltaX !== delta.deltaX || limited.deltaY !== delta.deltaY)
        ) {
          return {
            ...outcome,
            result: {
              ...outcome.result,
              scroll: { ...outcome.result.scroll, requested: delta, limitedTo: limited },
            },
          };
        }
        return outcome;
      },
    ),
    observedActionEntry(
      "computer_type_text",
      "Type text",
      `Type text into the focused desktop control, as if typed on the keyboard. It inserts at the caret and replaces nothing: to overwrite a field's contents, select them first — computer_triple_click on the field, or the application's own select-all shortcut through computer_hotkey — or use computer_set_value, which writes the whole value atomically. For browser navigation: hotkey meta+l (ctrl+l outside macOS), type the URL without a newline, then press_key enter with wait_for_label for a known destination control. Never guess address-bar coordinates or repeat Enter on an unchanged page. Type the whole string in one call — a name, an email address, a URL — and do not split it into pieces; splitting only multiplies the chance of a partial result. ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          text: { type: "string", description: "The exact text to insert at the caret." },
          ...keyboardTargetProperties,
        },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.typeText(context.callerThreadId, readRequiredText(args), readWindowIdArg(args)),
    ),
    observedActionEntry(
      "computer_press_key",
      "Press key",
      `Press one keyboard key on the computer-use seat — enter, escape, tab, an arrow, a function key, backspace. For a key with modifiers, use computer_hotkey. ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              'One key name, such as "enter", "escape", "tab", "backspace", "arrowdown", "f5", or a single printable character.',
          },
          ...keyboardTargetProperties,
        },
        required: ["key"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.pressKey(
          context.callerThreadId,
          readStringArg(args, "key", { required: true })!,
          readWindowIdArg(args),
        ),
    ),
    observedActionEntry(
      "computer_hotkey",
      "Press hotkey",
      `Press one keyboard shortcut. ${hotkeyFormNote(dialect)} ${KEYBOARD_TARGET_HINT} ${DELIVERY_HINT}`,
      {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: COMPUTER_HOTKEY_MAX_KEYS,
            description: hotkeyKeysNote(dialect),
          },
          ...keyboardTargetProperties,
        },
        required: ["keys"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.hotkey(context.callerThreadId, readHotkeyKeys(args), readWindowIdArg(args)),
    ),
    actionEntry(
      "computer_write_clipboard",
      "Write computer clipboard",
      `Replace the desktop clipboard with text, then paste it with the target application's own paste command. ${SHARED_CLIPBOARD_NOTE} Writing discards whatever the user had copied, so prefer computer_type_text for short input and use this for text too long or too awkward to type.`,
      {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.writeClipboard(context.callerThreadId, readClipboardText(args)),
    ),
    actionEntry(
      "computer_activate_window",
      "Activate window",
      "Bring a window into view and aim the agent keyboard at it. macOS refuses changes to window stacking or application focus; use this tool when the user asks to see a window without sending input. A desktop that cannot raise the window refuses. It returns no screenshot; observe with computer_screenshot or computer_get_state when needed.",
      {
        type: "object",
        properties: {
          window_id: {
            type: "string",
            description: "Window id from computer_list_windows.",
          },
        },
        required: ["window_id"],
        additionalProperties: false,
      },
      async (args, context) => {
        const windowId = readWindowIdArg(args);
        if (windowId === undefined) {
          throw new ToolInputError('Missing required argument "window_id".');
        }
        return manager.activateWindow(context.callerThreadId, windowId);
      },
    ),
    observedActionEntry(
      "computer_set_value",
      "Set computer value",
      "Replace the whole value of a unique accessible field from computer_get_state, using fresh target lookup. Prefer this over click-then-type. The result reports delivery.verified; inspect an unconfirmed write before continuing.",
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          value: { type: "string", description: "The control's complete new value." },
        },
        required: ["value"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.setValue(
          context.callerThreadId,
          readTarget(args, context),
          readSetValueValue(args),
        ),
    ),
    observedActionEntry(
      "computer_perform_action",
      "Perform computer action",
      `Perform a semantic action on a unique accessible control. AXScrollToVisible reveals a known off-screen field; read fresh state afterward. ${performActionNote(dialect)}`,
      {
        type: "object",
        properties: {
          ...pointerTargetProperties,
          action: {
            type: "string",
            enum: [...semanticActionNames(dialect)],
            description: performActionArgumentNote(dialect),
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.performAction(
          context.callerThreadId,
          readTarget(args, context),
          readActionName(args),
        ),
    ),
  ];
}

/**
 * The semantic action names this desktop's accessibility layer actually
 * accepts.
 *
 * The parameter was a bare string with no enum, so models invented plausible
 * names — `AXPress` on a Linux desktop, `toggle` on macOS — and every one of
 * them came back as a refusal the caller could do nothing with. Both lists are
 * what the backends really implement: `KWinComputerBackend.performAction` maps
 * exactly two names onto a synthetic click and refuses everything else, while
 * the macOS helper forwards the name to `AXUIElementPerformAction`.
 */
function semanticActionNames(dialect: ComputerAgentDialect): readonly string[] {
  return dialect === "macos"
    ? [
        "activate",
        "click",
        "AXPress",
        "AXShowMenu",
        "AXIncrement",
        "AXDecrement",
        "AXConfirm",
        "AXCancel",
        "AXPick",
        "AXScrollToVisible",
      ]
    : ["activate", "click"];
}

function performActionNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'Use it for what a click cannot express: AXShowMenu opens a control\'s own menu, AXIncrement and AXDecrement step a stepper or slider, AXPick chooses an item in a list or combo box. "activate" and "click" are delivered as a real synthetic click at the control, which is what most controls want.'
    : 'This desktop supports only "activate" and "click", both delivered as a real synthetic click at the control. For anything else, use the pointer and keyboard tools directly.';
}

function performActionArgumentNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'The action to perform. "activate"/"click" send a real click; the AX* names are macOS accessibility actions performed on the control itself. A control that does not support the action refuses.'
    : 'The action to perform. This desktop accepts only "activate" and "click".';
}

/**
 * What a shortcut may contain, which is not the same question on the two
 * families.
 *
 * The description said "ordered key sequence" and the schema allowed sixteen
 * keys, and neither backend does that: macOS throws unless exactly one key is
 * not a modifier, and Linux presses every key at once and releases them in
 * reverse. So the same wording taught macOS callers to send sequences that are
 * always refused, and Linux callers to expect a sequence they never get.
 */
function hotkeyFormNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'One chord: any number of modifiers plus exactly one other key, pressed together and released together — ["meta", "s"] to save, ["meta", "shift", "z"] to redo. More than one non-modifier key is refused; to press two shortcuts, call this twice.'
    : 'One chord: every key is pressed in the order given, held, then released in reverse — ["ctrl", "s"] to save, ["ctrl", "shift", "z"] to redo. It is not a sequence of separate keystrokes: to press two shortcuts, call this twice.';
}

function hotkeyKeysNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'The chord, modifiers first: any of "meta" (Command), "ctrl", "alt" (Option) and "shift", then exactly one other key such as "s", "tab" or "arrowleft".'
    : 'The chord, modifiers first: any of "ctrl", "alt", "shift" and "meta" (Super), then the key they apply to, such as "s", "tab" or "arrowleft".';
}

function launchAppNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "Names an application the way macOS does."
    : "Names an executable on PATH or a desktop application id.";
}

function launchAppArgumentNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? 'The application: its name as shown in the Applications folder ("Safari", "Visual Studio Code"), its bundle identifier ("com.apple.Safari"), or an absolute path to a bundle ("/Applications/Safari.app"). The result reports what the name resolved to.'
    : 'The application: an executable name on PATH ("firefox"), a desktop application id ("org.mozilla.firefox"), or an absolute path to an executable. The result reports what the name resolved to.';
}

/**
 * Whether this list can be silently short, and why.
 *
 * Only macOS can: without the screen-capture grant `CGWindowListCopyWindowInfo`
 * omits window names, and an untitled off-screen window is unaddressable and so
 * is dropped — which takes every minimized and off-Space window off the list
 * with it. Saying so on Linux, where the compositor plugin enumerates windows
 * with no such grant, would only invite doubt about a list that is complete.
 */
function windowListCompletenessNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? " If the result carries a setupRequired note about a screen-capture grant, this list is also incomplete: without that grant macOS withholds window titles, and an untitled off-screen window cannot be addressed and is left out — so minimized and other-Space windows disappear from it. What it does report is accurate."
    : "";
}

function dragLimitNote(dialect: ComputerAgentDialect): string {
  return dialect === "macos"
    ? "Dragging into a browser or Electron window is best effort on this desktop and is not verified, so check the result with computer_screenshot rather than assuming the drop landed."
    : "This desktop injects the drag at screen coordinates, so it works for anything the pointer can sweep — selecting text, moving a slider — but cross-application drag-and-drop and dragging a window by its titlebar are handled by the compositor and may not follow. Check the result with computer_screenshot rather than assuming the drop landed.";
}

function mcpToolResultJson(value: unknown): McpToolCallResult {
  return formatToolResultJson(value, true);
}
