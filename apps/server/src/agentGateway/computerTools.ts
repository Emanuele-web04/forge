/** Agent-facing Linux computer perception and control tools. */
import { Effect } from "effect";

import {
  COMPUTER_TEXT_MAX_LENGTH,
  type ComputerActionResult,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@synara/contracts";

import { actionableElements, ComputerTargetError } from "../computer/uiTreeTargeting.ts";
import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerCaptureRequest,
} from "../computer/ComputerBackend.ts";
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
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readBooleanArg,
  readNumberArg,
  readRecordArg,
  readStringArg,
  readStringArrayArg,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { PROVIDERS_WITHOUT_APPROVAL_GATE } from "./approvalGate.ts";

export const COMPUTER_CONTROL_CAPABILITY = "computer:control" as const;

export const COMPUTER_APPROVAL_REQUIRED_TOOLS = new Set([
  // The one read in this set on purpose: the clipboard is the human's, and it
  // can hold something they copied privately — a password manager entry, a
  // token — that is not otherwise visible to the agent. Reading it must never
  // be auto-approved the way perception tools are.
  "computer_read_clipboard",
  "computer_launch_app",
  "computer_click",
  "computer_double_click",
  "computer_right_click",
  "computer_move_cursor",
  "computer_drag",
  "computer_scroll",
  "computer_type_text",
  "computer_press_key",
  "computer_hotkey",
  "computer_write_clipboard",
  "computer_set_value",
  "computer_perform_action",
]);

export function computerToolRequiresApproval(name: string): boolean {
  return COMPUTER_APPROVAL_REQUIRED_TOOLS.has(name);
}

/**
 * Every computer tool is deferred — none carries `anthropic/alwaysLoad`.
 *
 * Computer control is now available to any chat the desktop backend is available
 * for (see `docs/computer-use-design.md`), so preloading even the act-loop
 * schemas would tax every chat's prompt, including the pure-coding chats that
 * never touch the desktop. Deferring all of them is skill semantics: a chat pays
 * ~0 tokens until an agent first reaches for the desktop, at which point Claude's
 * tool search pulls the whole family in on one query (they share the `computer`
 * name segment, so one search retrieves them all). The tools stay in the
 * capability-gated deferred list, so an agent can always find them on request —
 * they are just not resident until then.
 *
 * The small round-trip cost of that first discovery is the deliberate trade for
 * charging idle chats nothing: an agent that reaches the desktop pays one search;
 * an agent that never does pays nothing.
 */

export interface AgentGatewayComputerToolsOptions {
  readonly manager: ComputerManager;
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
 * One wording for how the model points at things, shared by every tool that
 * returns an image: it points into the picture it was given, in that picture's
 * own pixels, and the server does the geometry (see screenshotFrames.ts). The
 * model is never asked to turn a screenshot pixel into a desktop coordinate —
 * the harnesses behind the Codex app and Anthropic's computer tool do not ask
 * either, and the arithmetic that did (region + pixel / scale across offset,
 * downscaled captures) was where clicks went astray.
 */
const SCREENSHOT_FRAME_NOTE =
  "Every screenshot comes back with a screenshotId and its width and height in pixels; to point at something in it, pass x/y as pixel coordinates in that image, measured from its top-left corner, and the server maps them onto the desktop";

/**
 * Both clipboard tools must say the same thing about ownership: the desktop has
 * one clipboard and the human is the other party using it.
 */
const SHARED_CLIPBOARD_NOTE =
  "The desktop has a single clipboard shared with the human user, not a private one for the agent.";

const POINTER_COORDINATE_NOTE =
  "x/y are pixel coordinates in a screenshot you received — by default the most recent one this conversation was given, otherwise the one named by screenshot_id — measured from that image's top-left corner. Never convert screenshot pixels into desktop coordinates yourself; the server does that. Point at what you can see: if you have not looked at the desktop yet, or a window has moved or resized since your last screenshot, take a new screenshot first.";

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
const ACTION_SCREENSHOT_NOTE = `The result includes a screenshot taken after the action settled, zoomed to the window the action affected — the window it named, or the window under its coordinates — falling back to the whole workspace when neither identifies one, capped at ${COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION} pixels on its longest side so a typical application window comes back at full resolution. It becomes the screenshot your next x/y are measured in: read the next state from it and aim your next action at its pixels instead of making a separate screenshot call, and call computer_screenshot only when this one is too small to read the detail you need. When the new capture is identical to the one the previous action returned, the result reports screenshotUnchanged instead of repeating the image: the screen has not changed since your previous screenshot, so keep reading that one — it remains the screenshot your coordinates refer to. When the action closed its own target window, the result reports targetWindowClosed instead of a screenshot — the picture of a different window would not show your action's outcome.`;

const INCLUDE_ACTION_SCREENSHOT_PROPERTY = {
  include_screenshot: {
    type: "boolean",
    description:
      "Attach the post-action screenshot to the result. Defaults to true. Pass false only when another action follows in this same response and you will read that action's screenshot instead. Never pass false on the last action before you need to see the result: skipping it and then calling computer_screenshot costs the extra round trip the attached screenshot exists to avoid.",
  },
} as const;

/**
 * Keyboard input carries no coordinate, so the only thing that decides where it
 * lands is seat focus. Every keyboard tool says so identically, and says what to
 * pass to make it deterministic.
 */
const KEYBOARD_TARGET_NOTE =
  "Keys go to whichever window holds the agent seat's keyboard focus. Pass window_id to raise and focus a specific window first — recommended whenever more than one window is open, since focus otherwise sits wherever the last action left it.";

const KEYBOARD_TARGET_PROPERTY = {
  window_id: {
    type: "string",
    description:
      "Optional window id from computer_list_windows. The window is raised and given the agent seat's keyboard focus before the keys are sent, and the result's screenshot is zoomed to it.",
  },
} as const;

function withActionScreenshotSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    properties: {
      ...(schema.properties as Record<string, unknown>),
      ...INCLUDE_ACTION_SCREENSHOT_PROPERTY,
    },
  };
}

const SCREENSHOT_ID_PROPERTY = {
  screenshot_id: {
    type: "string",
    description:
      "screenshotId of the screenshot that x/y (and any region) are measured in. Defaults to the most recent screenshot this conversation received. Pass it only when pointing into an earlier screenshot that is still valid, such as a workspace overview taken just before a zoomed window capture.",
  },
} as const;

const TARGET_PROPERTIES = {
  x: {
    type: "number",
    description:
      "X pixel coordinate in the screenshot (the most recent one, or the one named by screenshot_id), measured from its left edge.",
  },
  y: {
    type: "number",
    description:
      "Y pixel coordinate in the screenshot (the most recent one, or the one named by screenshot_id), measured from its top edge.",
  },
  ...SCREENSHOT_ID_PROPERTY,
  label: {
    type: "string",
    description:
      "Accessible label to resolve from a fresh UI snapshot — use the exact label from computer_get_state's elements list.",
  },
  role: { type: "string", description: "Optional accessible role used to disambiguate a label." },
  window_id: {
    type: "string",
    description:
      "Optional window id from computer_list_windows. With a label it picks which window the label is resolved in. With x/y it scopes the coordinate to that window: the window is raised and input is routed to it even if another window overlaps, and the click is refused if the coordinate is outside the window. For computer_scroll it is also a target on its own, scrolling the window itself.",
  },
} as const;

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
  const label = readStringArg(args, "label");
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
 * Longest glide a drag may hold the pointer button for. The bound is repeated in
 * the JSON Schema for the model's benefit, but it is enforced here because
 * nothing validates MCP tool arguments against that schema before dispatch: an
 * unclamped `duration_ms` of 1e9 is a drag that holds the button — and the
 * exclusive desktop lease — for eleven days.
 */
const MAX_DRAG_DURATION_MS = 30_000;

/** Clamped rather than refused: the caller's intent is clear, only the scale is wrong. */
function readDragDurationMs(args: Record<string, unknown>): number {
  const value = readNumberArg(args, "duration_ms");
  if (value === undefined) return DEFAULT_DRAG_DURATION_MS;
  return Math.min(MAX_DRAG_DURATION_MS, Math.max(0, value));
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

/** Mirrors `ComputerHotkeyInput`: at most 16 keys, each a name of 128 characters. */
const HOTKEY_KEYS_MAX_ITEMS = 16;
const HOTKEY_KEY_MAX_LENGTH = 128;

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
  if (keys.length > HOTKEY_KEYS_MAX_ITEMS) {
    throw new ToolInputError(`Argument "keys" accepts at most ${HOTKEY_KEYS_MAX_ITEMS} keys.`);
  }
  const oversized = keys.find((key) => key.length > HOTKEY_KEY_MAX_LENGTH);
  if (oversized !== undefined) {
    throw new ToolInputError(
      `Each key in "keys" is at most ${HOTKEY_KEY_MAX_LENGTH} characters; got one of ${oversized.length}.`,
    );
  }
  return keys;
}

/** Mirrors the contract's action-name bound on semantic actions. */
const ACTION_NAME_MAX_LENGTH = 256;

function readActionName(args: Record<string, unknown>): string {
  const value = readStringArg(args, "action", { required: true })!;
  if (value.length > ACTION_NAME_MAX_LENGTH) {
    throw new ToolInputError(
      `Argument "action" is longer than ${ACTION_NAME_MAX_LENGTH} characters.`,
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

function readCaptureMaxDimension(args: Record<string, unknown>): number | undefined {
  const value = readNumberArg(args, "max_dimension");
  if (value === undefined) return undefined;
  if (value < 1) throw new ToolInputError('Argument "max_dimension" must be at least 1.');
  return Math.min(MAX_COMPUTER_CAPTURE_MAX_DIMENSION, Math.floor(value));
}

function isToolResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function makeAgentGatewayComputerTools(
  options: AgentGatewayComputerToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager } = options;
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
    reuseUnchanged = false,
  ): McpToolCallResult => {
    const { bytesBase64, ...metadata } = screenshot;
    const previous = reuseUnchanged
      ? frames.matchLatest(threadId, screenshot, windowId)
      : undefined;
    if (previous) {
      return mcpToolResultJson({
        ...payload,
        screenshotUnchanged: true,
        screenshot: {
          ...metadata,
          screenshotId: previous.id,
          ...(windowId !== undefined ? { windowId } : {}),
        },
        note: "The image and coordinate frame are unchanged. Keep using this screenshotId and the previous image.",
      });
    }
    const frame = frames.record(threadId, screenshot, windowId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...payload,
              screenshot: {
                ...(frame ? { screenshotId: frame.id } : {}),
                ...(windowId !== undefined ? { windowId } : {}),
                ...metadata,
              },
            },
            null,
            2,
          ),
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
    return { ...rest, ...screenshotPointToDesktop(frame, target.x, target.y) };
  };

  const readTarget = (args: Record<string, unknown>, context: ToolContext): ComputerTarget =>
    resolveTarget(readScreenshotTarget(args), context.callerThreadId);

  const readNestedTarget = (
    args: Record<string, unknown>,
    name: string,
    context: ToolContext,
  ): ComputerTarget =>
    resolveTarget(readNestedScreenshotTarget(args, name), context.callerThreadId);

  const handle =
    (
      name: string,
      run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
    ) =>
    (args: Record<string, unknown>, context: ToolContext) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (
            computerToolRequiresApproval(name) &&
            PROVIDERS_WITHOUT_APPROVAL_GATE.has(context.callerProvider)
          ) {
            return approvalUnavailableResult(name);
          }
          // Recorded before the call, because the call is what claims the
          // desktop, and the badge has to name this thread from the first
          // action rather than from the second.
          manager.setThreadLabel(context.callerThreadId, context.callerThreadLabel);
          const value = await manager.withAgentActivity(
            context.callerThreadId,
            async () => {
              await Effect.runPromise(context.assertCallerTurnActive(), { signal });
              signal.throwIfAborted();
              return run(args, context);
            },
            signal,
          );
          return isToolResult(value) ? value : mcpToolResultJson(value);
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof ComputerTargetError
              ? targetErrorResult(error)
              : error instanceof ComputerLeaseError
                ? leaseErrorResult(error)
                : mcpToolResultError(errorText(error)),
          ),
        ),
      );

  const actionEntry = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
  ): ToolEntry => ({
    requiredCapability: COMPUTER_CONTROL_CAPABILITY,
    requiresActiveTurn: true,
    definition: {
      name,
      description,
      inputSchema,
      annotations: { title, ...WRITE_TOOL_ANNOTATIONS },
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
    result: ComputerActionResult,
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
    return deliverScreenshot(
      context.callerThreadId,
      result,
      capture.screenshot,
      capture.windowId,
      true,
    );
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
    // The clamped point when the display server moved the pointer, because the
    // window under where the action actually landed is the one it affected.
    return withObservation(
      context,
      result,
      await manager.captureActionScreenshot(result.windowId, result.clampedTo ?? result.point),
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
  ): ToolEntry =>
    actionEntry(
      name,
      title,
      `${description} ${ACTION_SCREENSHOT_NOTE}`,
      withActionScreenshotSchema(inputSchema),
      async (args, context) => {
        const outcome = await run(args, context);
        return "result" in outcome
          ? withObservation(context, outcome.result, outcome.observation)
          : observeAfterAction(args, outcome, context);
      },
    );

  const targetSchema = {
    type: "object",
    properties: TARGET_PROPERTIES,
    additionalProperties: false,
  } as const;

  return [
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_list_windows",
        description:
          "List visible desktop windows and their bounds without touching the pointer. Windows come back topmost-first: stackingIndex is 0 for the topmost window and grows downward, and occludedBy names the overlapping windows stacked above each one. A plain x/y click lands on whatever is topmost at that point, so when the window you want is occluded, pass its id as window_id alongside x/y to scope the click to it. When present, active reports which window the desktop considers activated; apps may silently drop keyboard shortcuts sent to a window that is not active, so if a hotkey had no effect, check this field.",
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
        description: `Read the current desktop state, and call this before acting: the result lists every labeled actionable control (buttons, text fields, checkboxes...) as "elements", and targeting those by label is far more reliable than estimating pixel coordinates from a screenshot. The screenshot covers the entire desktop workspace across every monitor, scaled down. ${SCREENSHOT_FRAME_NOTE}. Window bounds and cursor positions in the JSON are desktop coordinates, useful for telling windows apart but not for aiming: aim by label, or with screenshot pixels. Use computer_screenshot when workspace detail is too small to read. include_text adds a full accessibility-text rendering of the tree on top of the elements list; request it or a screenshot only when needed because both increase payload size.`,
        inputSchema: {
          type: "object",
          properties: {
            include_screenshot: { type: "boolean" },
            include_text: { type: "boolean" },
          },
          additionalProperties: false,
        },
        annotations: { title: "Get computer state", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_get_state", async (args, context) => {
        // One perception read feeds both renderings: the elements digest always
        // rides (that is what makes labels discoverable), while the full
        // accessibility text rendering stays opt-in for its payload size.
        const state = await manager.getState({
          includeScreenshot: readBooleanArg(args, "include_screenshot") ?? false,
          includeText: true,
        });
        const { text, root, screenshot, ...rest } = state;
        const wantText = readBooleanArg(args, "include_text") ?? false;
        const elements = root ? actionableElements(root) : undefined;
        const payload = {
          ...rest,
          ...(wantText && text !== undefined ? { text } : {}),
          ...(elements
            ? {
                elements: elements.items,
                ...(elements.complete ? {} : { elementsTruncated: true }),
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
        description: `Zoom into one part of the desktop when detail is too small to read in a screenshot you have. With no arguments it captures the window that currently has focus, which is usually the one to look at. Otherwise capture a single window by "window_id" from computer_list_windows, or a rectangle given as "x", "y", "width" and "height" in pixels of the screenshot you are zooming into (the most recent one, or the one named by screenshot_id); never pass both forms. ${SCREENSHOT_FRAME_NOTE}. The capture is clipped to the desktop workspace, so it may cover less than requested.`,
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
              maximum: MAX_COMPUTER_CAPTURE_MAX_DIMENSION,
              description: `Longest screenshot side in pixels before downscaling. Defaults to ${DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION}, the same budget computer_get_state spends on the whole workspace.`,
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
        name: "computer_read_clipboard",
        description: `Read the desktop clipboard as text, returned as "value". ${SHARED_CLIPBOARD_NOTE} It returns whatever was copied last by anyone, so it may hold something the user copied for their own purposes. An empty clipboard returns an empty string; a clipboard holding an image, other non-text content, or more than 16384 characters of text is an error.`,
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
      "Launch an application by command or desktop app identifier.",
      {
        type: "object",
        properties: {
          app: { type: "string" },
          arguments: { type: "array", items: { type: "string" } },
        },
        required: ["app"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.launchApp(
          context.callerThreadId,
          readStringArg(args, "app", { required: true })!,
          readStringArrayArg(args, "arguments") ?? [],
        ),
    ),
    observedActionEntry(
      "computer_click",
      "Click",
      `Click a coordinate or a uniquely labelled visible control. Ambiguous and off-screen targets are refused. ${SEMANTIC_TARGETING_NOTE} ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) => manager.click(context.callerThreadId, readTarget(args, context)),
    ),
    observedActionEntry(
      "computer_double_click",
      "Double click",
      `Double-click a coordinate or a uniquely labelled visible control. ${SEMANTIC_TARGETING_NOTE} ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) =>
        manager.doubleClick(context.callerThreadId, readTarget(args, context)),
    ),
    observedActionEntry(
      "computer_right_click",
      "Right click",
      `Right-click a coordinate or a uniquely labelled visible control. ${SEMANTIC_TARGETING_NOTE} ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) =>
        manager.rightClick(context.callerThreadId, readTarget(args, context)),
    ),
    observedActionEntry(
      "computer_move_cursor",
      "Move cursor",
      `Move the dedicated computer-use cursor to a coordinate or uniquely labelled visible control. ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) =>
        manager.moveCursor(context.callerThreadId, readTarget(args, context)),
    ),
    observedActionEntry(
      "computer_drag",
      "Drag",
      `Drag between two coordinates or uniquely labelled visible controls. ${POINTER_COORDINATE_NOTE}`,
      {
        type: "object",
        properties: {
          from: targetSchema,
          to: targetSchema,
          duration_ms: { type: "integer", minimum: 0, maximum: MAX_DRAG_DURATION_MS },
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
      `Scroll at an optional target. The target is resolved before the gesture and is never guessed. Scroll distance is measured in pixels of the same screenshot the coordinates are in — roughly 80 pixels per notch of a physical wheel in a full-resolution window capture. To page through content, scroll by about half the window's height as it appears in the screenshot so each observation overlaps the last; larger steps skip content. Some applications gear scrolling up and travel several times the distance requested; browsers commonly do. The result reports what the content actually did in scroll.traveledY, in desktop pixels with the same sign as delta_y, and scrolls are corrected automatically using it: the first large scroll into a window is delivered as a small probe plus a pre-corrected remainder, so ask for the distance you actually want — even the first scroll lands close, and later ones land closer. A traveledY of 0 means the content did not move at all, which usually means the page is already at its edge — a wheel cannot scroll past the top or bottom. If you are scrolling to hunt for a control, stop and call computer_get_state instead: its elements list names the labeled controls on screen, and one of those may already be targetable by label. ${POINTER_COORDINATE_NOTE}`,
      {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
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
        const target = resolveTarget(raw, threadId);
        // The distance is in the same picture's pixels as the point, so a
        // scroll needs a frame even when it names no point at all.
        const delta = screenshotDeltaToDesktop(
          frames.resolve(threadId, raw.screenshotId),
          readDelta(args, "delta_x"),
          readDelta(args, "delta_y"),
        );
        return manager.scrollCalibrated(
          threadId,
          hasTargetFields(target) ? target : null,
          delta.deltaX,
          delta.deltaY,
          { observe: readBooleanArg(args, "include_screenshot") !== false },
        );
      },
    ),
    observedActionEntry(
      "computer_type_text",
      "Type text",
      `Type text into the focused desktop control. ${KEYBOARD_TARGET_NOTE}`,
      {
        type: "object",
        properties: { text: { type: "string" }, ...KEYBOARD_TARGET_PROPERTY },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.typeText(context.callerThreadId, readRequiredText(args), readWindowIdArg(args)),
    ),
    observedActionEntry(
      "computer_press_key",
      "Press key",
      `Press one keyboard key on the computer-use seat. ${KEYBOARD_TARGET_NOTE}`,
      {
        type: "object",
        properties: { key: { type: "string" }, ...KEYBOARD_TARGET_PROPERTY },
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
      `Press a keyboard shortcut as an ordered key sequence. ${KEYBOARD_TARGET_NOTE}`,
      {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
          ...KEYBOARD_TARGET_PROPERTY,
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
    observedActionEntry(
      "computer_set_value",
      "Set computer value",
      "Set the value of a uniquely labelled accessible control after a fresh snapshot. The label comes from computer_get_state's elements list; this writes atomically instead of typing keystrokes, so prefer it over click-then-type for any field that appears there.",
      {
        type: "object",
        properties: { ...TARGET_PROPERTIES, value: { type: "string" } },
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
      "Perform a named semantic action on a uniquely labelled accessible control.",
      {
        type: "object",
        properties: { ...TARGET_PROPERTIES, action: { type: "string" } },
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
