/**
 * Agent gateway device tools - the agent's control surface for the device pane.
 *
 * Shaped exactly like `browserTools.ts`: one `ToolEntry` array appended to the
 * gateway's tool assembly, gated on the `device:control` capability, and
 * requiring a live turn so a detached provider cell cannot drive a simulator
 * after its turn ended.
 *
 * Consent rides the existing per-provider approval flows rather than a new
 * subsystem. Two things are enforced here rather than left to the provider:
 *
 * - `device_open_url` always requires approval. It is an exfiltration vector
 *   (an arbitrary URL opened in the device's browser), so it is refused
 *   in-tool for any session whose provider has no approval gate, following the
 *   `BrowserDownloadApprovalRequired` precedent of cancelling before the effect
 *   and telling the agent that explicit user approval is required.
 * - Every input tool is refused the same way for gateless providers
 *   (`PROVIDERS_WITHOUT_APPROVAL_GATE`). Antigravity runs with
 *   `--dangerously-skip-permissions` and Pi executes gateway tools with no
 *   approval bridge, so without this a prompt-injected agent could drive the
 *   device with no user in the loop.
 *
 * @module agentGateway/deviceTools
 */
import {
  DEVICE_SCROLL_MAX_SWIPES,
  DEVICE_SCROLL_MIN_SWIPES,
  DEVICE_SWIPE_DURATION_MAX_MS,
  DEVICE_SWIPE_DURATION_MIN_MS,
  type DeviceHardwareButton,
  type DeviceOpenPaneReason,
} from "@synara/contracts";
import { Effect } from "effect";

import type { DeviceManager } from "../device/DeviceManager.ts";
import { readTapRequest } from "../device/uiTreeTargeting.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readBooleanArg,
  readNumberArg,
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

export const DEVICE_CONTROL_CAPABILITY = "device:control" as const;

export function deviceToolRequiresApproval(name: string): boolean {
  return DEVICE_APPROVAL_REQUIRED_TOOLS.has(name);
}

/**
 * Errors the pane's status row is allowed to show.
 *
 * The agent hears about every tool failure; the person watching should only be
 * interrupted by the ones they can act on — the helper will not build, the
 * simulator will not boot, the stream died. A scroll that ran out of list, a
 * label that matched nothing, a tap whose element moved: those are the agent's
 * feedback loop, and painting them in red under the device reads as the pane
 * being broken while the agent is already recovering.
 *
 * Deliberately a denylist of the recoverable shapes rather than an allowlist of
 * fatal ones: an unrecognised failure is more useful shown than hidden.
 */
const AGENT_RECOVERABLE_ERROR_PATTERNS: readonly RegExp[] = [
  /appears to be at its end/iu,
  /no element (?:matching|labelled|labeled)/iu,
  /matched more than one element/iu,
  /is not visible on screen/iu,
  /out of reach/iu,
  /scrolling stopped moving/iu,
];

export function isViewerFacingDeviceError(error: unknown): boolean {
  const message = errorText(error);
  return !AGENT_RECOVERABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Input plus `device_open_url`: anything that changes what the device does. */
const DEVICE_APPROVAL_REQUIRED_TOOLS = new Set([
  "device_boot",
  "device_install",
  "device_launch",
  "device_open_url",
  "device_tap",
  "device_swipe",
  // Scrolling drives real swipes, so it belongs with the input tools rather
  // than the read-only ones despite reading as a lookup.
  "device_scroll_to_element",
  "device_type",
  "device_press_button",
]);

/**
 * The buttons an agent may press.
 *
 * `rotate` is in the contract's button union but deliberately absent here: the
 * backend refuses it on every call, because rotation is a Simulator.app window
 * command with no HID usage and no simctl equivalent on a headless boot.
 * Advertising a value that is guaranteed to fail only invites agents to plan
 * around it and then report an error the user cannot act on. The pane's own
 * rail leaves it out for the same reason.
 */
const DEVICE_HARDWARE_BUTTONS: readonly DeviceHardwareButton[] = [
  "home",
  "lock",
  "volume-up",
  "volume-down",
];

const UDID_PROPERTY = {
  type: "string",
  description: "Device udid from device_list.",
} as const;

const DEVICE_SWIPE_DURATION_RANGE = {
  minimum: DEVICE_SWIPE_DURATION_MIN_MS,
  maximum: DEVICE_SWIPE_DURATION_MAX_MS,
} as const;

const DEVICE_SCROLL_BUDGET_RANGE = {
  minimum: DEVICE_SCROLL_MIN_SWIPES,
  maximum: DEVICE_SCROLL_MAX_SWIPES,
} as const;

const DEVICE_APPROVAL_AGENT_GUIDANCE =
  "If this reports DeviceApprovalRequired, the action was refused before it ran because the session has no approval gate; explain that the user must perform it from the device pane and do not retry.";
const DEVICE_BUILD_AGENT_GUIDANCE =
  "Synara never builds the app; when needed, build it first with xcodebuild or the project's build tool. This tool surfaces the driven device in the pane.";
const DEVICE_INPUT_RESULT_AGENT_GUIDANCE =
  "If HID events were not delivered, nothing happened and the server already retried once, so surface the failure. Never report success without observing the result in device_describe_ui; an unchanged tree means the action missed or changed nothing.";

function approvalRequiredDeviceDescription(description: string): string {
  return `${description} ${DEVICE_APPROVAL_AGENT_GUIDANCE}`;
}

function builtAppDeviceDescription(description: string): string {
  return approvalRequiredDeviceDescription(`${description} ${DEVICE_BUILD_AGENT_GUIDANCE}`);
}

function deviceInputDescription(description: string): string {
  return approvalRequiredDeviceDescription(`${description} ${DEVICE_INPUT_RESULT_AGENT_GUIDANCE}`);
}

function approvalUnavailableResult(name: string): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: "DeviceApprovalRequired",
        message: `${name} requires explicit user approval, and this provider session has no approval gate. The action was refused before it ran; ask the user to perform it from the device pane.`,
      },
    }),
    isError: true,
  };
}

function readUdid(args: Record<string, unknown>): string {
  return readStringArg(args, "udid", { required: true })!;
}

function readCoordinate(args: Record<string, unknown>, name: string): number {
  const value = readNumberArg(args, name);
  if (value === undefined) throw new ToolInputError(`Missing required argument "${name}".`);
  if (value < 0 || value > 20_000) {
    throw new ToolInputError(`Argument "${name}" must be a device point between 0 and 20000.`);
  }
  return value;
}

function readBoundedIntegerArg(
  args: Record<string, unknown>,
  name: string,
  range: { readonly minimum: number; readonly maximum: number },
): number | undefined {
  const value = readNumberArg(args, name);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < range.minimum || value > range.maximum) {
    throw new ToolInputError(
      `Argument "${name}" must be an integer between ${range.minimum} and ${range.maximum}.`,
    );
  }
  return value;
}

export interface AgentGatewayDeviceToolsOptions {
  readonly manager: DeviceManager;
}

export function makeAgentGatewayDeviceTools(
  options: AgentGatewayDeviceToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager } = options;

  /**
   * Shared handler body: refuse when approval is impossible, mark the thread as
   * agent-driven for the badge, and turn any failure into a tool error rather
   * than a transport error.
   */
  const handle = (
    name: string,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
  ) => {
    return (args: Record<string, unknown>, context: ToolContext) =>
      Effect.gen(function* () {
        if (
          deviceToolRequiresApproval(name) &&
          PROVIDERS_WITHOUT_APPROVAL_GATE.has(context.callerProvider)
        ) {
          return approvalUnavailableResult(name);
        }
        return yield* Effect.tryPromise({
          try: async () => {
            const value = await manager.withAgentActivity(context.callerThreadId, () =>
              run(args, context),
            );
            return mcpToolResultJson(value);
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const message = errorText(error);
              if (isViewerFacingDeviceError(error)) {
                yield* Effect.promise(() =>
                  manager.recordThreadError(context.callerThreadId, message).catch(() => undefined),
                );
              }
              return mcpToolResultError(message);
            }),
          ),
        );
      });
  };

  const surfaceDevice = async (
    context: ToolContext,
    udid: string,
    reason: DeviceOpenPaneReason,
  ): Promise<void> => {
    await manager.surfaceDeviceForAgent(context.callerThreadId, udid, reason);
  };

  /**
   * Wrap an interaction tool so driving the device also puts it in front of the
   * user. Any interaction counts, not just install and launch: the common case
   * is an app already running on a booted simulator, where the agent goes
   * straight to describe/tap and the pane would otherwise never open.
   *
   * Surfacing runs after the action so a failed tap does not open a pane on a
   * device the agent could not drive, and it is a no-op once the pane has been
   * surfaced for that thread and device.
   */
  const handleInteraction = (
    name: string,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
  ) =>
    handle(name, async (args, context) => {
      const result = await run(args, context);
      await surfaceDevice(context, readUdid(args), "agent-tool");
      return result;
    });

  const tools: ToolEntry[] = [
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_list",
        description:
          "List iOS simulators Synara can drive, with their runtime, boot state, and who booted them. Call this before any other device_* tool and use an already-booted device when one is available; booting another wastes time and can leave the user watching the wrong pane.",
        inputSchema: {
          type: "object",
          properties: {
            includeShutdown: {
              type: "boolean",
              description: "Include devices that are not currently booted.",
            },
          },
          additionalProperties: false,
        },
        annotations: { title: "List devices", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("device_list", async (args) =>
        manager.list({ includeShutdown: readBooleanArg(args, "includeShutdown") ?? false }),
      ),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_boot",
        description: approvalRequiredDeviceDescription(
          'Boot a simulator only when device_list finds nothing booted or the user named a different device. Synara caps the simulators it boots; kind "boot-limit-reached" lists devices to relay to the user so they can choose one to shut down, and must not be retried.',
        ),
        inputSchema: {
          type: "object",
          properties: { udid: UDID_PROPERTY },
          required: ["udid"],
          additionalProperties: false,
        },
        annotations: { title: "Boot device", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handle("device_boot", async (args, context) => {
        const udid = readUdid(args);
        const result = await manager.boot(udid);
        // Booting is the agent claiming a device even when it never installs
        // or launches (driving Settings, opening a URL). Attach so the pane has
        // something to show, but stay silent: opening the pane is reserved for
        // install/launch, when there is actually an app to watch.
        if (result.kind === "booted") {
          await manager.ensureThreadAttached(context.callerThreadId, udid).catch(() => undefined);
        }
        return result;
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_install",
        description: builtAppDeviceDescription(
          "Install a built .app bundle on a booted simulator and pass the resulting bundle path.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            appPath: { type: "string", description: "Absolute path to a built .app bundle." },
          },
          required: ["udid", "appPath"],
          additionalProperties: false,
        },
        annotations: { title: "Install app", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handle("device_install", async (args, context) => {
        const udid = readUdid(args);
        const result = await manager.install(
          udid,
          readStringArg(args, "appPath", { required: true })!,
        );
        await surfaceDevice(context, udid, "agent-install");
        return result;
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_launch",
        description: builtAppDeviceDescription(
          "Launch an installed app by bundle id on a booted simulator. Launch system apps directly by bundle id; Settings is com.apple.Preferences.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            bundleId: { type: "string", description: "App bundle identifier." },
            arguments: {
              type: "array",
              items: { type: "string" },
              description: "Launch arguments passed to the app.",
            },
          },
          required: ["udid", "bundleId"],
          additionalProperties: false,
        },
        annotations: { title: "Launch app", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handle("device_launch", async (args, context) => {
        const udid = readUdid(args);
        const result = await manager.launch(
          udid,
          readStringArg(args, "bundleId", { required: true })!,
          readStringArrayArg(args, "arguments"),
        );
        await surfaceDevice(context, udid, "agent-launch");
        return result;
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_open_url",
        description: approvalRequiredDeviceDescription(
          "Open a URL on the device through its deep-link handlers; this always requires explicit user approval. For Expo Go, boot with device_boot and then use exp://127.0.0.1:8081; if Metro is needed, start it detached in the background so it does not block the turn. Never run expo start --ios, expo run:ios, or npm run ios because they open Simulator.app outside the pane. When the user asks to see the app working, finish with it visible in the streamed pane.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            url: { type: "string", description: "URL or custom scheme to open." },
          },
          required: ["udid", "url"],
          additionalProperties: false,
        },
        annotations: { title: "Open URL", ...WRITE_TOOL_ANNOTATIONS, openWorldHint: true },
      },
      // Surfaced like any other interaction. Opening a deep link is how an Expo
      // or React Native app reaches the screen, so it is exactly the moment the
      // user needs to see the device; without this the dock stays shut until a
      // later tap or describe happens to open it.
      handler: handleInteraction("device_open_url", async (args) => {
        const udid = readUdid(args);
        await manager.openUrl(udid, readStringArg(args, "url", { required: true })!);
        return { udid, opened: true };
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_tap",
        description: deviceInputDescription(
          "Tap by label with device_tap {udid, label}; add role as {udid, label, role} only to disambiguate a repeated label. Synara re-reads the accessibility tree, scrolls the element into view, and uses its activationPoint, which is required for a switch, checkbox, stepper, or other control merged into a row whose centre is dead space. Use x and y only for an unlabeled target, and copy device points from device_describe_ui rather than screenshot pixels or computed coordinates.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            label: {
              type: "string",
              description: "Label of the element to tap, as reported by device_describe_ui.",
            },
            role: {
              type: "string",
              description:
                'Optional role or subrole to disambiguate a repeated label, e.g. "Button" or "Switch".',
            },
            x: { type: "number", description: "Horizontal device point. Requires y." },
            y: { type: "number", description: "Vertical device point. Requires x." },
          },
          required: ["udid"],
          additionalProperties: false,
        },
        annotations: { title: "Tap", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handleInteraction("device_tap", async (args) => {
        const udid = readUdid(args);
        const request = readTapRequest({
          x: readNumberArg(args, "x"),
          y: readNumberArg(args, "y"),
          label: readStringArg(args, "label") ?? undefined,
          role: readStringArg(args, "role") ?? undefined,
        });
        if (request.kind === "point") {
          const x = readCoordinate(args, "x");
          const y = readCoordinate(args, "y");
          await manager.tap(udid, x, y);
          return { udid, x, y };
        }
        const match = await manager.tapElement(udid, request.target);
        // Report the node so the agent sees what it hit and, for a toggle, the
        // state it had before the tap; the follow-up describe shows the change.
        return {
          udid,
          x: match.point.x,
          y: match.point.y,
          element: {
            role: match.node.role,
            subrole: match.node.subrole,
            label: match.node.label,
            valueBeforeTap: match.node.value,
          },
        };
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_swipe",
        description: deviceInputDescription(
          "Swipe between two device points only when the gesture itself is the goal, such as dismissing a sheet, paging a carousel, or pulling to refresh. Never write a swipe loop to find content; use device_scroll_to_element or labelled device_tap instead.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            fromX: { type: "number" },
            fromY: { type: "number" },
            toX: { type: "number" },
            toY: { type: "number" },
            durationMs: {
              type: "integer",
              ...DEVICE_SWIPE_DURATION_RANGE,
              description: "Gesture duration in milliseconds (default 300).",
            },
          },
          required: ["udid", "fromX", "fromY", "toX", "toY"],
          additionalProperties: false,
        },
        annotations: { title: "Swipe", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handleInteraction("device_swipe", async (args) => {
        const udid = readUdid(args);
        const gesture = {
          fromX: readCoordinate(args, "fromX"),
          fromY: readCoordinate(args, "fromY"),
          toX: readCoordinate(args, "toX"),
          toY: readCoordinate(args, "toY"),
          durationMs: readBoundedIntegerArg(args, "durationMs", DEVICE_SWIPE_DURATION_RANGE) ?? 300,
        };
        await manager.swipe(udid, gesture);
        return { udid, ...gesture };
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_type",
        description: deviceInputDescription(
          "Type text into the focused field. Tap the field first; this does not focus anything by itself.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            text: { type: "string", description: "Text to enter." },
          },
          required: ["udid", "text"],
          additionalProperties: false,
        },
        annotations: { title: "Type text", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handleInteraction("device_type", async (args) => {
        const udid = readUdid(args);
        const text = args.text;
        if (typeof text !== "string") throw new ToolInputError('Argument "text" must be a string.');
        await manager.typeText(udid, text);
        return { udid, length: text.length };
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_press_button",
        description: deviceInputDescription(
          "Press a hardware button: home, lock, volume-up, or volume-down.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            button: { type: "string", enum: [...DEVICE_HARDWARE_BUTTONS] },
          },
          required: ["udid", "button"],
          additionalProperties: false,
        },
        annotations: {
          title: "Press hardware button",
          ...WRITE_TOOL_ANNOTATIONS,
          destructiveHint: false,
        },
      },
      handler: handleInteraction("device_press_button", async (args) => {
        const udid = readUdid(args);
        const button = readStringArg(args, "button", { required: true })!;
        if (!(DEVICE_HARDWARE_BUTTONS as readonly string[]).includes(button)) {
          throw new ToolInputError(
            `Argument "button" must be one of: ${DEVICE_HARDWARE_BUTTONS.join(", ")}.`,
          );
        }
        await manager.pressButton(udid, button as DeviceHardwareButton);
        return { udid, button };
      }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_screenshot",
        description:
          "Capture the device screen as a PNG for showing the user a result or when pixels themselves matter. Never use screenshots to locate elements or verify state; use device_describe_ui.",
        inputSchema: {
          type: "object",
          properties: { udid: UDID_PROPERTY },
          required: ["udid"],
          additionalProperties: false,
        },
        annotations: { title: "Screenshot device", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          return yield* Effect.tryPromise({
            try: async () => {
              const result = await manager.withAgentActivity(context.callerThreadId, () =>
                manager.screenshot(readUdid(args)),
              );
              await surfaceDevice(context, readUdid(args), "agent-tool");
              // Image content beside the JSON so the model sees the screen
              // without a second decode step, matching browser_screenshot.
              const { bytesBase64, ...metadata } = result;
              return {
                ...mcpToolResultJson(metadata),
                content: [
                  { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
                  { type: "image" as const, data: bytesBase64, mimeType: "image/png" as const },
                ],
              } satisfies McpToolCallResult;
            },
            catch: (error) => error,
          }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))));
        }),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_describe_ui",
        description:
          'Read the accessibility tree: roles, subroles, labels, values, frames, and activation points in device points. Use this before device_tap and re-read it afterwards to verify the screen changed. A control merged into a row only responds at its activationPoint, not the row centre. Toggle value "1" means on and "0" means off; inspect and re-read that value rather than using a screenshot. Simulators omit hardware-backed panes such as Airplane Mode, Cellular, and Face ID enrollment, while Developer options appear only when exposed by the runtime; if a requested control is absent, say so instead of substituting another setting.',
        inputSchema: {
          type: "object",
          properties: { udid: UDID_PROPERTY },
          required: ["udid"],
          additionalProperties: false,
        },
        annotations: { title: "Describe device UI", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handleInteraction("device_describe_ui", async (args) =>
        manager.describeUi(readUdid(args)),
      ),
    },
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_scroll_to_element",
        description: deviceInputDescription(
          "Scroll a labelled element into view in one call. Synara swipes and re-reads the tree until the element reaches the tappable band, then returns its tap point. Use this instead of a device_swipe loop when reading or confirming content below the fold; labelled device_tap already scrolls on its own.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            label: {
              type: "string",
              description: "Label of the element to bring into view.",
            },
            role: {
              type: "string",
              description: "Optional role or subrole to disambiguate a repeated label.",
            },
            maxSwipes: {
              type: "integer",
              ...DEVICE_SCROLL_BUDGET_RANGE,
              description: "Swipe budget before giving up. Defaults to 8.",
            },
          },
          required: ["udid", "label"],
          additionalProperties: false,
        },
        annotations: {
          title: "Scroll to element",
          ...WRITE_TOOL_ANNOTATIONS,
          destructiveHint: false,
        },
      },
      handler: handleInteraction("device_scroll_to_element", async (args) => {
        const udid = readUdid(args);
        const match = await manager.scrollToElement(
          udid,
          {
            label: readStringArg(args, "label", { required: true })!,
            role: readStringArg(args, "role") ?? undefined,
          },
          {
            maxScrolls: readBoundedIntegerArg(args, "maxSwipes", DEVICE_SCROLL_BUDGET_RANGE),
          },
        );
        return {
          udid,
          element: {
            role: match.node.role,
            subrole: match.node.subrole,
            label: match.node.label,
            value: match.node.value,
            frame: match.node.frame,
          },
          tapPoint: match.point,
        };
      }),
    },
  ];

  return tools;
}
