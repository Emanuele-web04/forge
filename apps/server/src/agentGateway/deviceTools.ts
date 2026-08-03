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
 * - Every input tool is refused the same way for gateless providers. Antigravity
 *   runs with `--dangerously-skip-permissions`, so without this a prompt-injected
 *   agent could drive the device with no user in the loop.
 *
 * @module agentGateway/deviceTools
 */
import {
  type DeviceHardwareButton,
  type DeviceOpenPaneReason,
  type ProviderKind,
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

export const DEVICE_CONTROL_CAPABILITY = "device:control" as const;

/**
 * Providers whose sessions run without a per-tool approval gate. Synara cannot
 * put a human in the loop for them, so device actions with a physical or
 * exfiltration effect are refused rather than silently auto-approved.
 */
const PROVIDERS_WITHOUT_APPROVAL_GATE = new Set<ProviderKind>(["antigravity"]);

export function deviceToolRequiresApproval(name: string): boolean {
  return DEVICE_APPROVAL_REQUIRED_TOOLS.has(name);
}

/** Input plus `device_open_url`: anything that changes what the device does. */
const DEVICE_APPROVAL_REQUIRED_TOOLS = new Set([
  "device_boot",
  "device_install",
  "device_launch",
  "device_open_url",
  "device_tap",
  "device_swipe",
  "device_type",
  "device_press_button",
]);

const DEVICE_HARDWARE_BUTTONS: readonly DeviceHardwareButton[] = [
  "home",
  "lock",
  "volume-up",
  "volume-down",
  "rotate",
];

const UDID_PROPERTY = {
  type: "string",
  description: "Device udid from device_list.",
} as const;

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
              yield* Effect.promise(() =>
                manager.recordThreadError(context.callerThreadId, message).catch(() => undefined),
              );
              return mcpToolResultError(message);
            }),
          ),
        );
      });
  };

  /**
   * Put the agent's device in front of the user: attach the thread to it (so
   * the pane has something to stream) and ask the pane to open. Attaching
   * first means the open request lands on a state that already names a device,
   * rather than a pane showing the empty picker.
   */
  const surfaceDevice = async (
    context: ToolContext,
    udid: string,
    reason: DeviceOpenPaneReason,
  ): Promise<void> => {
    await manager.ensureThreadAttached(context.callerThreadId, udid).catch(() => undefined);
    manager.requestOpenPane(context.callerThreadId, udid, reason);
  };

  const tools: ToolEntry[] = [
    {
      requiredCapability: DEVICE_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "device_list",
        description:
          "List iOS simulators Synara can drive, with their runtime, boot state, and who booted them. Call this before any other device_* tool to get a udid.",
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
        description:
          'Boot a simulator. Synara caps the number of simulators it boots itself; past the cap this returns kind "boot-limit-reached" with the devices to shut down, which is a refusal to relay to the user, not an error to retry.',
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
        description:
          "Install a built .app bundle on a booted simulator. Synara never builds the app: run your own build first and pass the resulting bundle path.",
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
        description: "Launch an installed app by bundle id on a booted simulator.",
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
        description:
          "Open a URL on the device, following its deep-link handlers. Always requires explicit user approval.",
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
      handler: handle("device_open_url", async (args) => {
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
        description:
          "Tap an element by label, or a raw point. Prefer label: Synara re-reads the accessibility tree and taps the element's own point, which is the only thing that works for a control merged into its row (a switch's row centre is dead space). Pass role alongside label only to disambiguate. Use x and y just for something the tree does not label; they are device points from device_describe_ui, never screenshot pixels.",
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
      handler: handle("device_tap", async (args) => {
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
        description: "Swipe between two points on the device screen, in device points.",
        inputSchema: {
          type: "object",
          properties: {
            udid: UDID_PROPERTY,
            fromX: { type: "number" },
            fromY: { type: "number" },
            toX: { type: "number" },
            toY: { type: "number" },
            durationMs: {
              type: "number",
              description: "Gesture duration in milliseconds (default 300).",
            },
          },
          required: ["udid", "fromX", "fromY", "toX", "toY"],
          additionalProperties: false,
        },
        annotations: { title: "Swipe", ...WRITE_TOOL_ANNOTATIONS, destructiveHint: false },
      },
      handler: handle("device_swipe", async (args) => {
        const udid = readUdid(args);
        const gesture = {
          fromX: readCoordinate(args, "fromX"),
          fromY: readCoordinate(args, "fromY"),
          toX: readCoordinate(args, "toX"),
          toY: readCoordinate(args, "toY"),
          durationMs: readNumberArg(args, "durationMs") ?? 300,
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
        description:
          "Type text into the focused field. Tap the field first; this does not focus anything by itself.",
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
      handler: handle("device_type", async (args) => {
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
        description: "Press a hardware button: home, lock, volume-up, volume-down, or rotate.",
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
      handler: handle("device_press_button", async (args) => {
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
          "Capture the device screen as a PNG. Prefer device_describe_ui for finding elements; use this when the pixels themselves matter.",
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
          "Read the device's accessibility tree: roles, subroles, labels, values, frames, and activation points in device points. This is the canonical way to locate something before device_tap. Tap a node's activationPoint when it has one: a control merged into its row (switch, checkbox, stepper) only responds there, not at the row's frame centre. A toggle's value is \"1\" when on and \"0\" when off, so re-reading this tree is how you verify a toggle flipped.",
        inputSchema: {
          type: "object",
          properties: { udid: UDID_PROPERTY },
          required: ["udid"],
          additionalProperties: false,
        },
        annotations: { title: "Describe device UI", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("device_describe_ui", async (args) => manager.describeUi(readUdid(args))),
    },
  ];

  return tools;
}
