import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_TEXT_MAX_LENGTH,
  COMPUTER_WAIT_MAX_MS,
  type ComputerPermission,
  type ProviderKind,
} from "@synara/contracts";

import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  ComputerBackendError,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
} from "../computer/ComputerBackend.ts";
import { ComputerTargetError } from "../computer/uiTreeTargeting.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  computerToolInstructions,
  computerToolRequiresApproval,
  makeAgentGatewayComputerTools,
  PROVIDERS_WITHOUT_APPROVAL_GATE,
} from "./computerTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-computer";

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
}

/** A backend that never implemented the optional clipboard methods. */
function withoutClipboard(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "readClipboard" || property === "writeClipboard"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

function makeContext(
  provider: ProviderKind = "claudeAgent",
  threadId = THREAD,
  label: string | null = null,
): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:computer",
      threadId,
      provider,
      turnId: "turn-computer",
    },
    callerThreadId: threadId,
    callerThreadLabel: label,
    callerSessionKey: "gateway-session:computer",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(backend = new FakeComputerBackend()) {
  // A zero settle delay: these tests assert on what the post-action capture
  // does, not on how long the desktop is given to repaint.
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerTools({ manager });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
    threadId?: string,
    label?: string | null,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider, threadId, label)));
  };
  /**
   * Look at the desktop the way the model does before it points: a workspace
   * screenshot. The fake workspace is 1920×1080 and the perception budget caps
   * an image handed to a model at 1536 on its longest side, so this frame comes
   * back at 1536×864, scale 0.8, from (0, 0) — a screenshot pixel is 1.25
   * desktop points, and that conversion is exactly what the server does for the
   * model rather than asking it to.
   */
  const see = async (threadId = THREAD, label: string | null = null) => {
    const state = await call(
      "computer_get_state",
      { include_screenshot: true },
      undefined,
      threadId,
      label,
    );
    expect(state.isError).not.toBe(true);
    return (resultJson(state) as { screenshot: { screenshotId: string } }).screenshot;
  };
  return { backend, manager, tools, byName, call, see };
}

type ToolsByName = Map<string, { definition: { inputSchema: unknown } }>;

/** One property's `enum`, for the schemas whose vocabulary is backend-dependent. */
function schemaEnum(byName: ToolsByName, tool: string, property: string): readonly string[] {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { enum?: readonly string[] }> }
    | undefined;
  return schema?.properties?.[property]?.enum ?? [];
}

/** One property's description, for the same reason. */
function schemaPropertyDescription(byName: ToolsByName, tool: string, property: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  return schema?.properties?.[property]?.description ?? "";
}

/** The `window_id` blurb one tool advertises, which is backend-dependent prose. */
function windowIdDescription(byName: ToolsByName, tool: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: { window_id?: { description?: string } } }
    | undefined;
  return schema?.properties?.window_id?.description ?? "";
}

describe("agent gateway computer tools", () => {
  it("documents non-disruptive targeting and recovery", async () => {
    const { byName } = await setup();
    const notes = computerToolInstructions();
    expect(notes).toContain("never raises or activates");
    expect(notes).toContain("Never hide, minimize, activate, or rearrange");
    expect(windowIdDescription(byName, "computer_press_key")).toContain("without activating");
    expect(windowIdDescription(byName, "computer_click")).toContain("macOS does not raise");
    expect(byName.get("computer_activate_window")?.definition.description).toContain(
      "macOS refuses changes",
    );
  });

  it("keeps screenshot clicks and scrolls aimed at a covered window without raising it", async () => {
    const backend = Object.assign(new FakeComputerBackend(), { inputDoesNotRequireReveal: true });
    const click = vi.spyOn(backend, "click");
    const scroll = vi.spyOn(backend, "scroll");
    const { call } = await setup(backend);
    const shot = await call("computer_screenshot", { window_id: "fake-calculator" });
    const { screenshot } = resultJson(shot) as { screenshot: { screenshotId: string } };
    const windows = await backend.listWindows();
    backend.emitWindowsChanged(
      windows.map((window) => ({
        ...window,
        stackingIndex: window.id === "fake-calculator" ? 1 : 0,
        ...(window.id === "fake-calculator"
          ? { occludedBy: ["fake-browser"] }
          : {
              bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            }),
      })),
    );
    const clicked = await call("computer_click", {
      x: 50,
      y: 50,
      screenshot_id: screenshot.screenshotId,
      include_screenshot: false,
    });
    expect(clicked.isError).not.toBe(true);
    expect(click.mock.calls.at(-1)?.[1]).toBe("fake-calculator");
    const scrolled = await call("computer_scroll", {
      x: 50,
      y: 50,
      delta_y: 100,
      delta_x: 0,
      screenshot_id: screenshot.screenshotId,
      include_screenshot: false,
    });
    expect(scrolled.isError).not.toBe(true);
    expect(scroll.mock.calls.at(-1)?.[3]).toBe("fake-calculator");
    const centered = await call("computer_scroll", {
      delta_y: 100,
      delta_x: 0,
      screenshot_id: screenshot.screenshotId,
      include_screenshot: false,
    });
    expect(centered.isError).not.toBe(true);
    expect(scroll.mock.calls.at(-1)?.[3]).toBe("fake-calculator");
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
  });

  it("refuses an old window screenshot after its window closes instead of targeting another app", async () => {
    const { backend, call } = await setup();
    const shot = await call("computer_screenshot", { window_id: "fake-calculator" });
    const { screenshot } = resultJson(shot) as { screenshot: { screenshotId: string } };
    backend.emitWindowsChanged(
      (await backend.listWindows()).filter((w) => w.id !== "fake-calculator"),
    );
    const clicked = await call("computer_click", {
      x: 50,
      y: 50,
      screenshot_id: screenshot.screenshotId,
      include_screenshot: false,
    });
    expect(clicked.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  it("spells out all three delivery verdicts once, in the shared notes", async () => {
    // Collapsing "unverifiable" into "not confirmed" buys a screenshot after
    // every keystroke on the many native controls that expose no readable value.
    // The full three-way explanation lives in the MCP instructions now — it was
    // eleven identical copies across the tool schemas — and each input tool
    // carries the short form plus a pointer to it.
    const { byName } = await setup();
    const notes = computerToolInstructions();
    expect(notes).toContain('"unverifiable" means the control exposes no readable value');
    expect(notes).toContain('Only on "unconfirmed"');
    for (const name of ["computer_type_text", "computer_press_key", "computer_hotkey"]) {
      const description = byName.get(name)?.definition.description ?? "";
      expect(description).toContain("delivery.verified");
      expect(description).toContain("Reading a delivery verdict");
    }
  });

  it("carries the caller's name to the backend that draws the agent cursor", async () => {
    // The tool layer is the only place that knows what a thread is called, and
    // the badge on the human's desktop is the only reason it has to say so.
    const names: Array<string | null> = [];
    const backend = Object.assign(new FakeComputerBackend(), {
      setDrivingAgent: async (name: string | null) => {
        names.push(name);
      },
    });
    const { call, see } = await setup(backend);
    await see(THREAD, "Luna");

    await call("computer_click", { x: 4, y: 4 }, "claudeAgent", THREAD, "Luna");
    expect(names).toEqual(["Luna"]);

    await call("computer_press_key", { key: "enter" }, "claudeAgent", THREAD, "Luna");
    expect(names).toEqual(["Luna"]);
  });

  it("exposes the full Phase 1 surface behind computer:control", async () => {
    const { byName, tools } = await setup();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "computer_list_windows",
      "computer_get_state",
      "computer_screenshot",
      "computer_get_screen_size",
      "computer_wait",
      "computer_read_clipboard",
      "computer_launch_app",
      "computer_click",
      "computer_double_click",
      "computer_triple_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_hotkey",
      "computer_write_clipboard",
      "computer_activate_window",
      "computer_set_value",
      "computer_perform_action",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "computer:control")).toBe(true);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS).toEqual(
      new Set([
        "computer_read_clipboard",
        "computer_launch_app",
        "computer_click",
        "computer_double_click",
        "computer_triple_click",
        "computer_right_click",
        "computer_drag",
        "computer_scroll",
        "computer_type_text",
        "computer_press_key",
        "computer_hotkey",
        "computer_write_clipboard",
        "computer_set_value",
        "computer_perform_action",
        "computer_activate_window",
      ]),
    );
    // A hover posts no event, presses nothing, and no longer aims the keyboard,
    // so there is nothing for a human to approve and nothing destructive to
    // warn about. It was gated back when `move` still re-pointed the keyboard.
    expect(computerToolRequiresApproval("computer_move_cursor")).toBe(false);
    expect(
      (
        byName.get("computer_move_cursor")?.definition.annotations as
          | { destructiveHint?: boolean }
          | undefined
      )?.destructiveHint,
    ).toBe(false);
    // Waiting touches nothing at all.
    expect(computerToolRequiresApproval("computer_wait")).toBe(false);
    for (const name of COMPUTER_APPROVAL_REQUIRED_TOOLS) {
      expect(computerToolRequiresApproval(name)).toBe(true);
      expect(tools.some((tool) => tool.definition.name === name)).toBe(true);
    }
  });

  it("defers every computer tool: none preloaded, none carrying _meta", async () => {
    const { tools, byName } = await setup();
    // Computer control is available to any chat the backend serves, so preloading
    // even the act-loop schemas would tax every chat's prompt. All of them are
    // deferred instead — skill semantics: a chat pays ~0 tokens until an agent
    // reaches for the desktop, at which point one tool search pulls the family in.
    const preloaded = tools.filter(
      (tool) => tool.definition._meta?.["anthropic/alwaysLoad"] === true,
    );
    expect(preloaded).toEqual([]);
    // No `_meta` at all: no alwaysLoad marker, and no search hint (a hint would
    // replace the description a deferred tool advertises, and the shared
    // `computer` name segment already retrieves the whole set in one search).
    for (const tool of tools) {
      expect(tool.definition._meta).toBeUndefined();
    }
    // Deferring must not disturb what a tool already declares, nor its gate: the
    // whole family stays behind the computer:control capability and is present.
    expect(byName.get("computer_click")?.definition.annotations).toMatchObject({
      readOnlyHint: false,
    });
    expect(tools.every((tool) => tool.requiredCapability === "computer:control")).toBe(true);
  });

  it("returns perception payloads and preserves screenshot image content", async () => {
    const { call } = await setup();
    const list = await call("computer_list_windows", {});
    expect(list.isError).not.toBe(true);
    const state = await call("computer_get_state", {
      include_screenshot: true,
      include_text: true,
    });
    expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(state.content.find((entry) => entry.type === "image")).toMatchObject({
      mimeType: "image/png",
    });
    // The id is how the model names this picture later; the size is the space
    // its coordinates are in. Region and scale still travel for the pane and
    // for debugging, but the model is never asked to do arithmetic with them.
    const text = state.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: {
        screenshotId: "shot-1",
        // The 1920x1080 workspace comes back downscaled: no image handed to a
        // model may exceed the vision-API resize threshold, or the model reads
        // coordinates off a picture the server never produced.
        width: 1_536,
        height: 864,
        region: { x: 0, y: 0, width: 1_920, height: 1_080 },
        scale: 0.8,
      },
    });
  });

  /**
   * The elements digest is the parity lever with macOS visual understanding:
   * without it the model's only grounding is pixel estimation from a
   * downscaled screenshot, which is how forms turned into scroll-hunting.
   */
  it("lists actionable elements on every get_state without needing include_text", async () => {
    const { call } = await setup();
    const state = await call("computer_get_state", {});
    const payload = resultJson(state) as {
      elements: { role: string; label: string; windowId: string | null }[];
      text?: string;
    };

    expect(Array.isArray(payload.elements)).toBe(true);
    const roles = payload.elements.map((element: { role: string }) => element.role);
    expect(roles).toContain("button"); // Calculate
    expect(roles).toContain("text-field"); // Display
    for (const element of payload.elements) {
      expect(typeof element.label).toBe("string");
      expect(element.label.length).toBeGreaterThan(0);
      expect(element.windowId).not.toBeNull();
    }
    // The full text rendering stays opt-in; the digest always rides.
    expect(payload.text).toBeUndefined();

    const withText = await call("computer_get_state", { include_text: true });
    const textPayload = resultJson(withText) as { text?: string };
    expect(textPayload.text).toEqual(expect.stringContaining("button"));
  });

  it("reports an elements digest that omits nothing silently when truncated", async () => {
    const bigTree = {
      role: "desktop" as const,
      label: null,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
      activationPoint: null,
      onScreen: true,
      windowId: null,
      children: Array.from({ length: 90 }, (_unused, index) => ({
        role: "push button" as const,
        label: `Button ${index}`,
        value: null,
        description: null,
        frame: { x: 0, y: 0, width: 80, height: 30 },
        activationPoint: null,
        onScreen: true,
        windowId: "w1",
        children: [],
      })),
    };
    const { call } = await setup(new FakeComputerBackend({ root: bigTree }));

    const payload = resultJson(await call("computer_get_state", {})) as {
      elements: unknown[];
      elementsTruncated?: boolean;
    };
    expect(payload.elements).toHaveLength(60);
    expect(payload.elementsTruncated).toBe(true);
  });

  it("tells the model to point in screenshot pixels and never to convert them", async () => {
    const { byName } = await setup();
    // Both perception tools spell the same contract out, so the model carries
    // one skill from the workspace shot to the zoomed one.
    for (const name of ["computer_get_state", "computer_screenshot"]) {
      const description = byName.get(name)?.definition.description ?? "";
      expect(description).toContain("screenshotId");
      expect(description).toContain("pass x/y as pixel coordinates in that image");
      expect(description).not.toContain("region.x");
    }
    // The full paragraph is said once in the MCP instructions rather than
    // eleven times across the schemas; each pointer tool carries the short form
    // and names the section.
    const notes = computerToolInstructions();
    expect(notes).toContain("pixel coordinates in a screenshot you received");
    expect(notes).toContain("Never convert screenshot pixels into desktop coordinates");
    for (const name of [
      "computer_click",
      "computer_double_click",
      "computer_triple_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
    ]) {
      const description = byName.get(name)?.definition.description ?? "";
      expect(description).toContain("never desktop coordinates, and never converted by you");
      expect(description).toContain("Pointing at the desktop");
      expect(description).not.toContain("global desktop coordinates");
      // The optional id lives beside x/y on every pointer tool.
      expect(JSON.stringify(byName.get(name)?.definition.inputSchema)).toContain("screenshot_id");
    }
    expect(byName.get("computer_get_screen_size")?.definition.description).toContain(
      "Informational only",
    );
  });

  it("tells the model how to click a window another window covers", async () => {
    const { byName } = await setup();
    const list = byName.get("computer_list_windows")?.definition.description ?? "";
    expect(list).toContain("stackingIndex");
    expect(list).toContain("occludedBy");
    expect(list).toContain("window_id");

    // Every pointer tool takes the same target shape, so the escape hatch has
    // to be described on the shared property rather than in one tool.
    for (const name of ["computer_click", "computer_double_click", "computer_drag"]) {
      const schema = JSON.stringify(byName.get(name)?.definition.inputSchema ?? {});
      expect(schema).toContain("input is routed to that window");
    }
  });

  it("zooms into a window and reads the next coordinates in that window's pixels", async () => {
    const { backend, call, see } = await setup();
    const result = await call("computer_screenshot", { window_id: "fake-calculator" });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(result.content.find((entry) => entry.type === "image")).toMatchObject({
      mimeType: "image/png",
    });
    // The calculator window sits at (1050, 120) and is 420x620 logical pixels,
    // which fits the default budget, so the capture is not downscaled.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: {
        screenshotId: "shot-1",
        windowId: "fake-calculator",
        mimeType: "image/png",
        width: 420,
        height: 620,
        region: { x: 1_050, y: 120, width: 420, height: 620 },
        scale: 1,
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
    });

    // Pixel (5, 5) of that picture is the calculator's top-left corner plus
    // five: the server adds the window offset, the model never does. (The
    // clicks here skip their observation so the zoom stays the frame; an
    // observation would become the next frame, as the observation test pins.)
    await call("computer_click", { x: 5, y: 5, include_screenshot: false });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1_055, y: 125 });

    // A point past the picture's edge is refused rather than landing on
    // whatever the desktop has next to the window.
    const outside = await call("computer_click", { x: 500, y: 10, include_screenshot: false });
    expect(outside.isError).toBe(true);
    expect(resultJson(outside)).toMatchObject({
      error: {
        code: "computer_target_offscreen",
        message: expect.stringContaining("420x620 screenshot shot-1"),
      },
    });
    expect(backend.callsFor("click")).toHaveLength(1);

    // Naming an earlier screenshot reads the coordinates in that one instead.
    const workspace = await see();
    expect(workspace.screenshotId).toBe("shot-2");
    await call("computer_click", {
      x: 5,
      y: 5,
      screenshot_id: "shot-1",
      include_screenshot: false,
    });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1_055, y: 125 });
    await call("computer_click", { x: 5, y: 5, include_screenshot: false });
    // Back in the workspace frame, whose 1536-wide picture covers 1920 desktop
    // points: five screenshot pixels are six desktop points, and the server is
    // what converts them.
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 6, y: 6 });

    // An id this conversation was never given is refused, naming the ones it has.
    const unknown = await call("computer_click", { x: 5, y: 5, screenshot_id: "shot-9" });
    expect(resultJson(unknown)).toMatchObject({
      error: {
        code: "computer_target_not_found",
        message: expect.stringContaining("shot-1, shot-2"),
      },
    });
  });

  it("refuses to point before the conversation has seen a screenshot", async () => {
    const { backend, call } = await setup();

    const blind = await call("computer_click", { x: 4, y: 4 });
    expect(blind.isError).toBe(true);
    expect(resultJson(blind)).toMatchObject({
      error: {
        code: "computer_target_invalid",
        message: expect.stringContaining("computer_screenshot"),
      },
    });
    // A scroll distance is in screenshot pixels too, so it needs a frame even
    // without a point.
    const scroll = await call("computer_scroll", { delta_x: 0, delta_y: 100 });
    expect(scroll.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("scroll")).toHaveLength(0);

    // A label needs no picture: it is resolved from the accessibility tree.
    const byLabel = await call("computer_click", { label: "Calculate", role: "button" });
    expect(byLabel.isError).not.toBe(true);
    expect(backend.callsFor("click")).toHaveLength(1);
  });

  it("keeps each conversation's screenshots apart", async () => {
    const { call, see } = await setup();
    await see("thread-a");

    // Thread B never looked, so thread A's picture is not its frame.
    const blind = await call("computer_click", { x: 1, y: 1 }, undefined, "thread-b");
    expect(resultJson(blind)).toMatchObject({ error: { code: "computer_target_invalid" } });
  });

  it("zooms into a region and maps points and scroll distances through its scale", async () => {
    const { backend, call, see } = await setup();
    await see();
    // The rect is in the workspace screenshot's pixels, and that picture is the
    // 1920-wide desktop downscaled to 1536, so each of its pixels is 1.25
    // desktop points: this asks for the desktop rect (1050, 120) 400x800.
    const result = await call("computer_screenshot", {
      x: 840,
      y: 96,
      width: 320,
      height: 640,
      max_dimension: 400,
    });

    expect(result.isError).not.toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");
    // 800 logical pixels squeezed into 400 screenshot pixels halves the scale,
    // so screenshot pixel (100, 100) is desktop point (1250, 320).
    expect(payload).toMatchObject({
      screenshot: {
        width: 200,
        height: 400,
        region: { x: 1_050, y: 120, width: 400, height: 800 },
        scale: 0.5,
      },
    });
    expect(payload.windowId).toBeUndefined();
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 1_050, y: 120, width: 400, height: 800 },
      maxDimension: 400,
    });

    // The server owns the arithmetic the model used to be asked for. (Each
    // action skips its observation so the zoom stays the frame under test.)
    const skip = { include_screenshot: false };
    await call("computer_click", { x: 100, y: 100, ...skip });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1_250, y: 320 });
    // A scroll distance is in the same pixels as the point, so 40 pixels of a
    // half-scale picture is 80 pixels of content.
    await call("computer_scroll", { x: 100, y: 100, delta_x: 0, delta_y: 40, ...skip });
    expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 1_250, y: 320 }, 0, 80]);
    await call("computer_drag", { from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, ...skip });
    expect(backend.callsFor("drag").at(-1)?.args.slice(0, 2)).toEqual([
      { x: 1_050, y: 120 },
      { x: 1_250, y: 320 },
    ]);
    // Zooming again is measured in the zoomed picture, and clipped to it.
    await call("computer_screenshot", { x: 100, y: 300, width: 200, height: 200 });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 1_250, y: 720, width: 200, height: 200 },
    });
  });

  it("refuses an ambiguous or incomplete screenshot request without capturing", async () => {
    const { backend, call } = await setup();

    const both = await call("computer_screenshot", { window_id: "fake-calculator", x: 0 });
    expect(both.isError).toBe(true);
    expect(both.content[0]).toMatchObject({ text: expect.stringContaining("never both") });

    const partial = await call("computer_screenshot", { x: 10, y: 20, width: 30 });
    expect(partial.isError).toBe(true);
    expect(partial.content[0]).toMatchObject({ text: expect.stringContaining("height") });

    const empty = await call("computer_screenshot", { x: 10, y: 20, width: 0, height: 30 });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]).toMatchObject({ text: expect.stringContaining("greater than zero") });

    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
  });

  it("captures the focused window when called without a target", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_screenshot", {});

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    // The fake terminal is the focused window, so an untargeted zoom lands on
    // it and says so, mapping the same way an explicit window capture does.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: {
        screenshotId: "shot-1",
        windowId: "fake-terminal",
        region: { x: 40, y: 40, width: 960, height: 720 },
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
    });
  });

  it("surfaces a compositor capture failure as a readable error result", async () => {
    const { backend, call } = await setup();
    backend.failNext(
      "captureScreenshot",
      new Error("org.synara.ComputerUse.Error.CaptureFailed: window not visible"),
    );

    const result = await call("computer_screenshot", { window_id: "fake-calculator" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("window not visible"),
    });
  });

  it("keeps the zoom tool read-only and free of an approval gate", async () => {
    const { backend, byName, call } = await setup();
    expect(computerToolRequiresApproval("computer_screenshot")).toBe(false);
    expect(byName.get("computer_screenshot")?.definition.annotations).toMatchObject({
      readOnlyHint: true,
    });
    // Antigravity has no approval gate, so a read-only tool must still run.
    const result = await call(
      "computer_screenshot",
      { window_id: "fake-calculator" },
      "antigravity",
    );
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
  });

  it("passes a clamped pointer landing point back to the caller", async () => {
    const backend = new FakeComputerBackend();
    backend.click = async (point) => ({ point, clampedTo: { x: point.x, y: 1_080 } });
    const { call, see } = await setup(backend);
    await see();

    // Screenshot pixel 44 of the downscaled workspace frame is desktop point 55.
    const result = await call("computer_click", { x: 44, y: 44 });
    expect(result.isError).not.toBe(true);
    const entry = result.content[0];
    expect(JSON.parse(entry?.type === "text" ? entry.text : "{}")).toMatchObject({
      point: { x: 55, y: 55 },
      clampedTo: { x: 55, y: 1_080 },
    });
  });

  it("attaches a post-action screenshot of the focused window to action results", async () => {
    const { backend, call, see } = await setup();
    await see();
    const result = await call("computer_click", { x: 100, y: 100 });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    // A bare coordinate names no window, so the capture goes to the window the
    // compositor routed the click to — the topmost one at the point — and the
    // metadata says which window the pixels cover. (An untargeted action also
    // clears the pinned focus, so the focused-window fallback cannot answer
    // here; the action point is what identifies the window.)
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      action: "computer_click",
      point: { x: 125, y: 125 },
      screenshot: {
        screenshotId: "shot-2",
        windowId: "fake-terminal",
        region: { x: 40, y: 40, width: 960, height: 720 },
        scale: 1,
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
      // Action observations spend a smaller pixel budget than perception ones.
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });

    // The observation is the picture the model reads next, so it is also the
    // one its next coordinates are in: (5, 5) of the terminal is desktop (45, 45).
    await call("computer_click", { x: 5, y: 5 });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 45, y: 45 });
    // The identical capture comes back as screenshotUnchanged, and the model is
    // told to keep reading the previous picture — so that stays the frame.
    const repeat = await call("computer_click", { x: 5, y: 5 });
    expect(resultJson(repeat)).toMatchObject({ screenshotUnchanged: true });
    await call("computer_click", { x: 6, y: 6 });
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 46, y: 46 });
  });

  it("captures the window a scoped action named rather than the focused one", async () => {
    const { backend, call, see } = await setup();
    await see();
    const result = await call("computer_click", {
      x: 1_100,
      y: 200,
      window_id: "fake-calculator",
    });

    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      // Action observations spend a smaller pixel budget than perception ones.
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });
  });

  it("reports a closed target instead of photographing another window", async () => {
    const backend = new FakeComputerBackend();
    const originalClick = backend.click.bind(backend);
    backend.click = async (target) => {
      const result = await originalClick(target);
      // The click closed every window: by observation time the target is gone,
      // and the one thing the result must not contain is a screenshot of
      // whatever window remains focused — on a live desktop, the human's.
      backend.emitWindowsChanged([]);
      return result;
    };
    const { call, see } = await setup(backend);
    await see();

    const result = await call("computer_click", {
      x: 1_100,
      y: 200,
      window_id: "fake-calculator",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      action: "computer_click",
      targetWindowClosed: true,
    });
  });

  it("skips the post-action screenshot when the model opts out", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_type_text", { text: "hi", include_screenshot: false });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
  });

  it("focuses a named window before keyboard input and zooms the result to it", async () => {
    const { backend, call } = await setup();

    const hotkey = await call("computer_hotkey", {
      keys: ["ctrl", "t"],
      window_id: "fake-calculator",
    });
    expect(hotkey.isError).not.toBe(true);
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(resultJson(hotkey)).toMatchObject({ windowId: "fake-calculator" });
    // The screenshot follows the keys, so the model sees the window it typed
    // into rather than whatever happened to be focused.
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      // Action observations spend a smaller pixel budget than perception ones.
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });

    // The camel-case spelling works here for the same reason it does on targets.
    const typed = await call("computer_type_text", { text: "hi", windowId: "fake-terminal" });
    expect(typed.isError).not.toBe(true);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-terminal"]);
    expect(backend.callsFor("typeText").at(-1)?.args).toEqual(["hi"]);

    const pressed = await call("computer_press_key", { key: "enter", window_id: "gone" });
    expect(pressed.isError).toBe(true);
    expect(resultJson(pressed)).toMatchObject({
      error: { code: "computer_target_not_found" },
    });
    expect(backend.callsFor("pressKey")).toHaveLength(0);
  });

  it("zooms the post-action screenshot to the window under an untargeted action's point", async () => {
    const { backend, call, see } = await setup();
    await see();

    // The regression this pins: an untargeted scroll used to come back with a
    // workspace-wide downscale too small to read, and the model scroll-hunted
    // blind. The window under the scroll's own coordinates is the picture.
    const result = await call("computer_scroll", { x: 1_100, y: 200, delta_x: 0, delta_y: 300 });
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(resultJson(result)).toMatchObject({
      action: "computer_scroll",
      screenshot: { windowId: "fake-calculator" },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });
  });

  it("tells the model where keyboard input lands and when not to skip a screenshot", async () => {
    const { byName } = await setup();
    const notes = computerToolInstructions();
    expect(notes).toContain("keys go to the last aimed window");
    expect(notes).toContain("Pass window_id");
    for (const name of ["computer_type_text", "computer_press_key", "computer_hotkey"]) {
      const tool = byName.get(name);
      expect(tool?.definition.description).toContain("Keys go where the agent seat is aimed");
      expect(tool?.definition.description).toContain("Aiming the keyboard");
      expect(JSON.stringify(tool?.definition.inputSchema)).toContain("window_id");
    }
    // The opt-out has to fence itself off, or it reintroduces the separate
    // perception call the attached screenshot exists to remove.
    const schema = JSON.stringify(byName.get("computer_click")?.definition.inputSchema);
    expect(schema).toContain("Never pass false on the last action");
  });

  it("reports an unchanged screen instead of resending the identical image", async () => {
    const { backend, call } = await setup();

    const first = await call("computer_press_key", { key: "enter" });
    expect(first.content.map((entry) => entry.type)).toEqual(["text", "image"]);

    // The fake returns the same PNG for the same window, which is the live case
    // this exists for: an action the desktop did not visibly react to. Sending
    // the identical picture again costs a second copy of the same image tokens
    // and tells the model nothing it is not already looking at.
    const repeat = await call("computer_press_key", { key: "enter" });
    expect(repeat.isError).not.toBe(true);
    expect(repeat.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(resultJson(repeat)).toMatchObject({
      action: "computer_press_key",
      screenshotUnchanged: true,
      note: expect.stringContaining("byte-for-byte what your previous screenshot showed"),
    });
    expect(backend.callsFor("captureScreenshot")).toHaveLength(2);

    // A different window is a different picture, however identical its pixels.
    const other = await call("computer_press_key", { key: "enter", window_id: "fake-calculator" });
    expect(other.content.map((entry) => entry.type)).toEqual(["text", "image"]);
  });

  it("tells the model the observation is downscaled and what unchanged means", async () => {
    const { byName } = await setup();
    const notes = computerToolInstructions();

    expect(notes).toContain(`capped at ${COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION} pixels`);
    // Knowing where the detail went is the difference between zooming in and
    // concluding the label is unreadable.
    expect(notes).toContain("computer_screenshot");
    expect(notes).toContain("screenshotUnchanged");
    // And "unchanged" must not read as "your action failed": the server has
    // already looked for a window the action opened before it says this.
    expect(notes).toContain("not that the action failed");
    // Each action still says a screenshot is attached, and points at the rest.
    const description = byName.get("computer_click")?.definition.description ?? "";
    expect(description).toContain("screenshot taken shortly after the action");
    expect(description).toContain("The screenshot on every action");
  });

  it("keeps a successful action result when the post-action capture fails", async () => {
    const { backend, call } = await setup();
    backend.failNext("captureScreenshot");
    const result = await call("computer_press_key", { key: "enter" });

    // The key press happened; losing the screenshot must not report failure.
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(resultJson(result)).toMatchObject({ action: "computer_press_key" });
  });

  it("tells the model every observed action already carries its screenshot", async () => {
    const { byName } = await setup();
    for (const name of [
      "computer_click",
      "computer_double_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_hotkey",
      "computer_set_value",
      "computer_perform_action",
    ]) {
      const tool = byName.get(name);
      expect(tool?.definition.description).toContain("screenshot taken shortly after the action");
      expect(JSON.stringify(tool?.definition.inputSchema)).toContain("include_screenshot");
    }
    // Launching resolves seconds later and clipboard writes change no pixels,
    // so neither pays for a capture that would only show the previous state.
    for (const name of ["computer_launch_app", "computer_write_clipboard"]) {
      const tool = byName.get(name);
      expect(tool?.definition.description).not.toContain("screenshot taken after");
      expect(JSON.stringify(tool?.definition.inputSchema)).not.toContain("include_screenshot");
    }
  });

  it("resolves semantic actions from a fresh snapshot and reports backend calls", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { label: "Calculate", role: "button" });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("click")).toHaveLength(1);
    expect(backend.callsFor("click")[0]?.args[0]).toEqual({ x: 1_180, y: 228 });

    const setValue = await call("computer_set_value", { label: "Display", value: "468" });
    expect(setValue.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);
  });

  it("preserves raw text values, including whitespace and an empty value", async () => {
    const { backend, call } = await setup();

    for (const text of ["  hello  ", " ", "\n"]) {
      const result = await call("computer_type_text", { text });
      expect(result.isError).not.toBe(true);
      expect(backend.callsFor("typeText").at(-1)?.args).toEqual([text]);
    }

    const emptyValue = await call("computer_set_value", { label: "Display", value: "" });
    expect(emptyValue.isError).not.toBe(true);
    expect(backend.callsFor("setValue").at(-1)?.args.at(-1)).toBe("");
  });

  it("fills a form field whose visible label contains a non-breaking space", async () => {
    const backend = new FakeComputerBackend({
      root: {
        role: "AXTextField",
        label: "First name\u00a0*",
        value: "",
        description: null,
        frame: { x: 100, y: 200, width: 300, height: 40 },
        activationPoint: null,
        onScreen: true,
        windowId: "w1",
        editable: true,
        children: [],
      },
    });
    const { call } = await setup(backend);
    const result = await call("computer_set_value", {
      window_id: "w1",
      label: "First name *",
      value: "Ada",
      include_screenshot: false,
    });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);
    expect(backend.callsFor("setValue")[0]?.args.at(-1)).toBe("Ada");
    expect(backend.callsFor("typeText")).toHaveLength(0);
  });

  it("treats a camel-case windowId as a scroll target", async () => {
    const backend = new FakeComputerBackend({
      root: {
        role: "window",
        label: "Calculator",
        value: null,
        description: null,
        frame: { x: 100, y: 200, width: 300, height: 400 },
        activationPoint: { x: 250, y: 400 },
        onScreen: true,
        windowId: "w1",
        children: [],
      },
    });
    const { call, see } = await setup(backend);
    await see();

    const result = await call("computer_scroll", {
      windowId: "w1",
      delta_x: 10,
      delta_y: -20,
    });

    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("scroll").at(-1)?.args[0]).toEqual({ x: 250, y: 400 });
  });

  it("refuses invalid targets with structured candidate data", async () => {
    const { call } = await setup();
    const result = await call("computer_click", { label: "does not exist" });
    expect(result.isError).toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    const structured = text && text.type === "text" ? JSON.parse(text.text) : null;
    expect(structured.error.code).toBe("computer_target_not_found");
    expect(structured.error.candidates.length).toBeGreaterThan(0);
  });

  it("round-trips the shared clipboard and starts from an empty one", async () => {
    const { backend, call } = await setup();

    const empty = await call("computer_read_clipboard", {});
    expect(resultJson(empty)).toMatchObject({ action: "computer_read_clipboard", value: "" });

    const write = await call("computer_write_clipboard", { text: "  copied\ntext  " });
    expect(write.isError).not.toBe(true);
    expect(backend.callsFor("writeClipboard").at(-1)?.args).toEqual(["  copied\ntext  "]);

    const read = await call("computer_read_clipboard", {});
    expect(resultJson(read)).toMatchObject({ value: "  copied\ntext  " });
  });

  it("tells the model the clipboard belongs to the user too", async () => {
    const { byName } = await setup();
    for (const name of ["computer_read_clipboard", "computer_write_clipboard"]) {
      expect(byName.get(name)?.definition.description).toContain("shared with the human user");
    }
  });

  it("refuses clipboard text past the byte limit before it reaches the backend", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_write_clipboard", {
      text: "x".repeat(MAX_COMPUTER_CLIPBOARD_BYTES + 1),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("writeClipboard")).toHaveLength(0);
  });

  /**
   * MCP tool arguments are never validated against their JSON Schemas, so
   * these bounds are enforced at the tool layer: an oversized set_value that
   * fell back to typed keystrokes would hold the exclusive desktop lease and
   * the turn for hours, and thousands of hotkey keys would hold the seat
   * indefinitely as press/release pairs.
   */
  it("refuses a set_value past the text bound before it reaches the backend", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_set_value", {
      label: "Display",
      role: "text-field",
      value: "x".repeat(COMPUTER_TEXT_MAX_LENGTH + 1),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(0);

    const within = await call("computer_set_value", {
      label: "Display",
      role: "text-field",
      value: "x".repeat(COMPUTER_TEXT_MAX_LENGTH),
    });
    expect(within.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);
  });

  it("refuses a hotkey chord past the contract's shape before dispatch", async () => {
    const { backend, call } = await setup();

    const tooMany = await call("computer_hotkey", {
      keys: Array.from({ length: 17 }, (_, index) => `Key${index}`),
    });
    expect(tooMany.isError).toBe(true);
    expect(backend.callsFor("hotkey")).toHaveLength(0);

    const longKey = await call("computer_hotkey", { keys: ["k".repeat(129)] });
    expect(longKey.isError).toBe(true);
    expect(backend.callsFor("hotkey")).toHaveLength(0);

    const within = await call("computer_hotkey", { keys: ["Control", "L"] });
    expect(within.isError).not.toBe(true);
    expect(backend.callsFor("hotkey")).toHaveLength(1);
  });

  it("refuses a semantic action name past the contract's bound", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_perform_action", {
      label: "Display",
      action: "a".repeat(257),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("performAction")).toHaveLength(0);
  });

  it("reports clipboard tools as unsupported on a backend without them", async () => {
    const { call } = await setup(withoutClipboard(new FakeComputerBackend()));

    for (const [name, args] of [
      ["computer_read_clipboard", {}],
      ["computer_write_clipboard", { text: "nope" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("does not support clipboard access");
    }
  });

  it("refuses action tools for providers without an approval gate", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { x: 10, y: 10 }, "antigravity");
    expect(result.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  /**
   * A provider added to this set skips the approval card entirely, so a name
   * drifting in silently would ship an unreviewable input path. Pinned so the
   * set only ever changes deliberately.
   */
  it("pins the gate-less provider set", async () => {
    expect(PROVIDERS_WITHOUT_APPROVAL_GATE).toEqual(new Set(["antigravity", "pi"]));
  });

  it("keeps the clipboard read behind approval instead of the perception set", async () => {
    const { backend, byName, call } = await setup();

    // Approval-gated on purpose: the clipboard can hold something the human
    // copied privately, so providers must not auto-approve it as read-only.
    expect(byName.get("computer_read_clipboard")?.definition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });

    const refused = await call("computer_read_clipboard", {}, "antigravity");
    expect(refused.isError).toBe(true);
    expect(backend.callsFor("readClipboard")).toHaveLength(0);
  });

  it("refuses a second thread's actions with a retryable error and keeps its perception", async () => {
    const { backend, call, manager, see } = await setup();
    await see("thread-a");

    // The first action to land owns the desktop; nothing asks for it explicitly.
    const owned = await call("computer_click", { x: 10, y: 10 }, undefined, "thread-a");
    expect(owned.isError).not.toBe(true);

    const blocked = await call("computer_type_text", { text: "hello" }, undefined, "thread-b");
    expect(blocked.isError).toBe(true);
    expect(resultJson(blocked)).toMatchObject({
      error: {
        code: "computer_controlled_by_other_thread",
        retryable: true,
        message: expect.stringContaining("another conversation"),
      },
    });
    // The refusal happens before the backend, so the loser never moves anything.
    expect(backend.callsFor("typeText")).toHaveLength(0);

    // Reading the desktop is never arbitrated: the blocked thread can keep
    // watching, which is what makes "try again later" actionable advice. (The
    // state call gives the zoom that follows it a screenshot to point into.)
    for (const [name, args] of [
      ["computer_list_windows", {}],
      ["computer_get_state", { include_screenshot: true }],
      ["computer_get_screen_size", {}],
      ["computer_screenshot", { x: 0, y: 0, width: 100, height: 100 }],
    ] as const) {
      const perception = await call(name, args, undefined, "thread-b");
      expect(perception.isError).not.toBe(true);
    }

    // Turn end hands the desktop over; the roles then swap.
    await manager.releaseDesktopControl("thread-a");
    const handover = await call("computer_type_text", { text: "hello" }, undefined, "thread-b");
    expect(handover.isError).not.toBe(true);
    const nowBlocked = await call("computer_click", { x: 1, y: 1 }, undefined, "thread-a");
    expect(resultJson(nowBlocked)).toMatchObject({
      error: { code: "computer_controlled_by_other_thread" },
    });
  });

  /**
   * Models spell an omitted optional field as an explicit `null` all the time.
   * Deciding "this scroll has a target" from which keys are present read that
   * as a target, built an empty one, and had it refused as
   * computer_target_invalid — a hard failure for a request that meant "scroll
   * wherever the pointer is".
   */
  it("reads an explicitly null scroll target as no target", async () => {
    const { backend, call, see } = await setup();
    await see();

    const result = await call("computer_scroll", {
      x: null,
      y: null,
      label: null,
      window_id: null,
      delta_x: 0,
      delta_y: 120,
    });

    expect(result.isError).not.toBe(true);
    // Probe plus remainder, both untargeted: the null target survives into
    // every leg rather than becoming an empty target object.
    // 120 screenshot pixels of the downscaled workspace frame is 150 desktop
    // pixels: the probe takes 48 of them and the remainder carries 102.
    expect(backend.callsFor("scroll").map((entry) => entry.args)).toEqual([[null, 0, 150]]);
  });

  it("limits large scrolls to overlapping views across screenshot scale changes", async () => {
    const { backend, call } = await setup();
    const first = resultJson(await call("computer_screenshot", { window_id: "fake-terminal" })) as {
      screenshot: { region: { width: number; height: number }; width: number; height: number };
    };
    for (const distance of [1500, 700, -1400]) {
      const result = resultJson(
        await call("computer_scroll", {
          window_id: "fake-terminal",
          delta_x: 0,
          delta_y: distance,
        }),
      ) as { scroll: { requested: { deltaY: number }; limitedTo: { deltaY: number } } };
      expect(result.scroll.limitedTo.deltaY).toBe(
        (Math.sign(distance) * first.screenshot.region.height) / 2,
      );
      expect(Math.abs(result.scroll.requested.deltaY)).toBeGreaterThan(
        Math.abs(result.scroll.limitedTo.deltaY),
      );
      expect(Math.abs(backend.callsFor("scroll").at(-1)!.args[2] as number)).toBeLessThanOrEqual(
        first.screenshot.region.height / 2,
      );
    }
  });

  it("reports scroll travel and spends no extra capture doing it", async () => {
    const { backend, call, see } = await setup();
    await see();
    const seen = backend.callsFor("captureScreenshot").length;

    const result = await call("computer_scroll", { x: 1_100, y: 200, delta_x: 0, delta_y: 300 });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(resultJson(result)).toMatchObject({
      action: "computer_scroll",
      scroll: {
        // Screenshot pixels converted to desktop pixels by the frame's 0.8
        // scale before anything is injected.
        requested: { deltaX: 0, deltaY: 375 },
        injected: { deltaX: 0, deltaY: 375 },
        gearing: 1,
      },
    });
    // Exactly three on a first, probing scroll: before, after the probe leg,
    // and after the remainder — the last of which is also the screenshot the
    // result carries. A fourth would mean the generic observation path had
    // photographed the window again.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(seen + 3);
  });

  it("opts out of the captures with the screenshot, keeping the request telemetry", async () => {
    const { backend, call, see } = await setup();
    await see();
    const seen = backend.callsFor("captureScreenshot").length;

    const result = await call("computer_scroll", {
      x: 1_100,
      y: 200,
      delta_x: 0,
      delta_y: 300,
      include_screenshot: false,
    });

    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(seen);
    const payload = resultJson(result) as {
      scroll?: { requested?: unknown; injected?: unknown; traveledY?: number };
    };
    expect(payload.scroll?.requested).toEqual({ deltaX: 0, deltaY: 375 });
    expect(payload.scroll?.injected).toEqual({ deltaX: 0, deltaY: 375 });
    expect(payload.scroll?.traveledY).toBeUndefined();
  });

  it("tells the model that scroll distance is verified rather than assumed", async () => {
    const { byName } = await setup();
    const description = byName.get("computer_scroll")?.definition.description ?? "";

    expect(description).toContain("scroll.traveledY");
    expect(description).toContain("corrected automatically");
    // The advice that replaced scroll-hunting stays.
    expect(description).toContain("computer_get_state");
  });

  it("still resolves a scroll target when one is actually given", async () => {
    const { backend, call, see } = await setup();
    await see();

    await call("computer_scroll", { x: 100, y: 100, delta_x: 0, delta_y: -50 });

    // Probe plus remainder — the resolved point rides into both legs. The
    // point sits inside a window so the probe has something to measure against;
    // a point over bare desktop would skip calibration and send one leg.
    expect(backend.callsFor("scroll").map((entry) => entry.args)).toEqual([
      [{ x: 125, y: 125 }, 0, -48],
      [{ x: 125, y: 125 }, 0, -14.5],
    ]);
  });

  /**
   * The JSON Schema bound is advisory: nothing validates MCP tool arguments
   * against it before dispatch. Unclamped, a duration of 1e9 held the pointer
   * button — and the exclusive desktop lease — for eleven days.
   */
  it("refuses mutating computer tools for Pi, whose sessions have no approval gate", async () => {
    // Pi re-exposes every gateway tool as a native custom tool whose execute
    // posts tools/call directly: no permission hook, no request/respond. It was
    // in neither family's gate-less set, so computer_click ran on the real
    // desktop with nobody asked.
    const { backend, call } = await setup();
    for (const name of [
      "computer_click",
      "computer_type_text",
      "computer_write_clipboard",
      "computer_activate_window",
    ]) {
      const refused = await call(name, { x: 1, y: 1, text: "x", window_id: "fake-terminal" }, "pi");
      expect(refused.isError).toBe(true);
      expect(resultJson(refused)).toMatchObject({
        error: { code: "ComputerApprovalRequired" },
      });
    }
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("typeText")).toHaveLength(0);
    // Perception is untouched: refusing to read the screen protects nobody.
    const seen = await call("computer_list_windows", {}, "pi");
    expect(seen.isError).not.toBe(true);
  });

  it("never hands the model an image larger than it will actually be shown", async () => {
    // Above roughly 1568 px on the long edge a vision API downscales the picture
    // before the model sees it, so the model reads coordinates off an image the
    // server never produced and the mapping is wrong by that ratio.
    const { backend, byName, call } = await setup();
    const schema = byName.get("computer_screenshot")?.definition.inputSchema as {
      properties: { max_dimension: { maximum: number } };
    };
    expect(schema.properties.max_dimension.maximum).toBe(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION);
    expect(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION).toBe(1_536);

    // The schema bound is advisory — nothing validates MCP arguments against it
    // — so the request is clamped here too.
    await call("computer_screenshot", { window_id: "fake-terminal", max_dimension: 8_000 });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
      maxDimension: DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
    });
  });

  it("waits without touching the desktop, and never for longer than its bound", async () => {
    const { backend, call } = await setup();
    const started = Date.now();
    const result = await call("computer_wait", { duration_ms: 5 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({ waitedMs: 5 });
    // No pointer, no keys, no capture: a wait that photographed the desktop
    // would be a screenshot with a delay, which is not what it is for.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
    expect(backend.callsFor("click")).toHaveLength(0);

    // Clamped rather than refused: the intent is clear and only the scale is
    // wrong, and an unclamped wait stalls the whole turn behind a sleep.
    const clamped = await call("computer_wait", { duration_ms: 60 * 60 * 1_000 });
    expect(resultJson(clamped)).toMatchObject({ waitedMs: COMPUTER_WAIT_MAX_MS });
    const negative = await call("computer_wait", { duration_ms: -5 });
    expect(resultJson(negative)).toMatchObject({ waitedMs: 0 });
  });

  it("waits for a live label and returns its window screenshot in the same call", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_wait", {
      duration_ms: 5_000,
      label: "Display",
      window_id: "fake-calculator",
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "ready",
      screenshot: { windowId: "fake-calculator" },
    });
    expect(backend.callsFor("getState")).toHaveLength(1);
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    const invalid = await call("computer_wait", { duration_ms: 0, label: "Display" });
    expect(invalid.isError).toBe(true);
  });

  it("can wait for the next label on an action without replaying input", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", {
      label: "Display",
      window_id: "fake-calculator",
      wait_for_label: "Display",
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({ readiness: { status: "ready" } });
    expect(backend.callsFor("click")).toHaveLength(1);
    const invalid = await call("computer_click", {
      label: "Display",
      wait_for_label: "",
    });
    expect(invalid.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(1);
  });

  it("holds modifiers across a click and a scroll, and refuses a name it cannot press", async () => {
    // Not expressible with computer_hotkey, which releases its keys before the
    // gesture happens — so shift-click and ctrl-scroll had no spelling at all.
    const { backend, call, see } = await setup();
    await see();

    await call("computer_click", { x: 40, y: 40, modifiers: ["shift"], include_screenshot: false });
    expect(backend.callsFor("click").at(-1)?.args).toEqual([{ x: 50, y: 50 }, ["shift"]]);

    await call("computer_scroll", {
      x: 40,
      y: 40,
      delta_x: 0,
      delta_y: 8,
      modifiers: ["ctrl", "ctrl"],
      include_screenshot: false,
    });
    expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 50, y: 50 }, 0, 10, ["ctrl"]]);

    const refused = await call("computer_click", { x: 40, y: 40, modifiers: ["hyper"] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({ text: expect.stringContaining("hyper") });
  });

  it("sends a triple click as one gesture, and refuses where it cannot be one", async () => {
    const { backend, call, see } = await setup();
    await see();
    await call("computer_triple_click", { x: 40, y: 40, include_screenshot: false });
    expect(backend.callsFor("tripleClick")).toHaveLength(1);
    expect(backend.callsFor("click")).toHaveLength(0);

    // Three separate clicks are three carets, not a line selection, so a
    // backend that cannot express the gesture says so rather than approximating.
    const without = new Proxy(new FakeComputerBackend(), {
      get: (target, property, receiver) =>
        property === "tripleClick" ? undefined : Reflect.get(target, property, receiver),
    }) as FakeComputerBackend;
    const limited = await setup(without);
    await limited.see();
    const refused = await limited.call("computer_triple_click", { x: 40, y: 40 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({
      text: expect.stringContaining("cannot send a triple click"),
    });
  });

  it("photographs a window the action opened instead of reporting nothing changed", async () => {
    // The observer captures exactly one window, so a key press that opens a
    // dialog photographs the old window — very often byte-identical — and the
    // model was told its action had not landed at the moment it had landed
    // hardest.
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend);

    // Establishes the terminal's capture as what this thread has already seen.
    const first = await call("computer_press_key", { key: "enter", window_id: "fake-terminal" });
    expect(first.content.map((entry) => entry.type)).toEqual(["text", "image"]);

    const before = await backend.listWindows();
    backend.pressKey = async () => {
      backend.emitWindowsChanged([
        ...before,
        {
          id: "fake-dialog",
          title: "Save changes?",
          appName: "org.kde.konsole",
          bounds: { x: 200, y: 200, width: 300, height: 200 },
          focused: false,
          minimized: false,
          visible: true,
        },
      ]);
      return {};
    };

    const opened = await call("computer_press_key", { key: "enter", window_id: "fake-terminal" });
    expect(opened.isError).not.toBe(true);
    expect(resultJson(opened)).toMatchObject({ screenshot: { windowId: "fake-dialog" } });
    expect(opened.content.map((entry) => entry.type)).toEqual(["text", "image"]);
  });

  it("says an unchanged frame is unsettled rather than asserting the action missed", async () => {
    const { call } = await setup();
    await call("computer_press_key", { key: "enter", window_id: "fake-terminal" });
    // Nothing opened, so there is no new window to photograph instead and the
    // identical picture is genuinely all there is to report.
    const quiet = await call("computer_press_key", { key: "enter", window_id: "fake-terminal" });
    expect(resultJson(quiet)).toMatchObject({
      screenshotUnchanged: true,
      note: expect.stringContaining("does not prove the action missed"),
    });
  });

  it("does not substitute a new window from another process for the target screenshot", async () => {
    const backend = new FakeComputerBackend();
    const before = (await backend.listWindows()).map((window) => ({ ...window, pid: 10 }));
    backend.emitWindowsChanged(before);
    const { call } = await setup(backend);
    backend.pressKey = async () => {
      backend.emitWindowsChanged([
        ...before,
        { ...before[0]!, id: "unrelated-popup", pid: 20, stackingIndex: 0 },
      ]);
      return {};
    };
    const result = await call("computer_press_key", { key: "enter", window_id: "fake-terminal" });
    expect(resultJson(result)).toMatchObject({ screenshot: { windowId: "fake-terminal" } });
  });

  it("scopes the elements digest by window and by label, and counts what it drops", async () => {
    const { call } = await setup();
    const all = resultJson(await call("computer_get_state", {})) as {
      elements: { label: string; windowId: string }[];
      elementsTruncated?: boolean;
      elementsOmitted?: number;
    };
    const windowId = all.elements[0]!.windowId;

    const scoped = resultJson(await call("computer_get_state", { window_id: windowId })) as {
      elements: { windowId: string }[];
    };
    expect(scoped.elements.length).toBeGreaterThan(0);
    expect(scoped.elements.every((element) => element.windowId === windowId)).toBe(true);

    const label = all.elements[0]!.label;
    const filtered = resultJson(
      await call("computer_get_state", { label_contains: label.toUpperCase() }),
    ) as { elements: { label: string }[] };
    expect(filtered.elements.length).toBeGreaterThan(0);
    expect(
      filtered.elements.every((element) =>
        element.label.toLocaleLowerCase().includes(label.toLocaleLowerCase()),
      ),
    ).toBe(true);

    const none = resultJson(
      await call("computer_get_state", { label_contains: "no control is called this" }),
    ) as { elements: unknown[]; elementsTruncated?: boolean };
    expect(none.elements).toEqual([]);
    expect(none.elementsTruncated).toBeUndefined();
  });

  it("brings a window forward only through the explicit tool, and refuses where it cannot", async () => {
    const raised: string[] = [];
    const backend = Object.assign(new FakeComputerBackend(), {
      raiseWindow: (windowId: string) => {
        raised.push(windowId);
        return Promise.resolve();
      },
    });
    const { call } = await setup(backend);

    const result = await call("computer_activate_window", { window_id: "fake-terminal" });
    expect(result.isError).not.toBe(true);
    expect(raised).toEqual(["fake-terminal"]);
    expect(resultJson(result)).toMatchObject({
      action: "computer_activate_window",
      windowId: "fake-terminal",
    });

    const missing = await call("computer_activate_window", { window_id: "no-such-window" });
    expect(missing.isError).toBe(true);

    // A desktop with no stacking control says so rather than reporting a move
    // that never happened.
    const without = new Proxy(new FakeComputerBackend(), {
      get: (target, property, receiver) =>
        property === "raiseWindow" ? undefined : Reflect.get(target, property, receiver),
    }) as FakeComputerBackend;
    const plain = await setup(without);
    const refused = await plain.call("computer_activate_window", { window_id: "fake-terminal" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({
      text: expect.stringContaining("cannot bring a window forward"),
    });

    // And it is approval-gated, being the one tool whose whole effect is on
    // what the person at the machine sees.
    expect(computerToolRequiresApproval("computer_activate_window")).toBe(true);
  });

  it("describes the shortcut form and the semantic actions this desktop actually accepts", async () => {
    const linux = await setup();
    const hotkey = linux.byName.get("computer_hotkey")?.definition.description ?? "";
    expect(hotkey).toContain("One chord");
    expect(hotkey).not.toContain("ordered key sequence");
    expect(hotkey).toContain("released in reverse");
    const linuxActions = schemaEnum(linux.byName, "computer_perform_action", "action");
    expect(linuxActions).toEqual(["activate", "click"]);
    expect(linux.byName.get("computer_launch_app")?.definition.description).toContain(
      "executable on PATH",
    );

    const mac = await setup(
      Object.assign(new FakeComputerBackend(), { agentDialect: "macos" as const }),
    );
    const macHotkey = mac.byName.get("computer_hotkey")?.definition.description ?? "";
    expect(macHotkey).toContain("exactly one other key");
    expect(macHotkey).toContain("More than one non-modifier key is refused");
    const macActions = schemaEnum(mac.byName, "computer_perform_action", "action");
    expect(macActions).toContain("AXShowMenu");
    expect(mac.byName.get("computer_launch_app")?.definition.description).toContain(
      "the way macOS does",
    );
    const macLaunchApp = schemaPropertyDescription(mac.byName, "computer_launch_app", "app");
    expect(macLaunchApp).toContain("com.apple.Safari");
    expect(macLaunchApp).toContain("/Applications/Safari.app");
  });

  it("documents the refusals whose right answer is to wait rather than to stop", async () => {
    // The human-active refusal is the agent giving way on purpose; a model that
    // reads it as a broken desktop abandons a task it could finish two seconds
    // later.
    const notes = computerToolInstructions();
    expect(notes).toContain("computer_human_active");
    expect(notes).toContain("it is the feature working, not a fault");
    expect(notes).toContain("computer_controlled_by_other_thread");
    expect(notes).toContain("computer_target_ambiguous");
    expect(notes).toContain("ComputerApprovalRequired");
  });

  it("matches a label exactly as written, spaces included", async () => {
    // The desktop targeters compare labels verbatim on purpose, so trimming the
    // argument retargeted a caller that named "Save " at a control called "Save".
    const { call } = await setup();
    const refused = await call("computer_click", { label: "Calculate " });
    expect(refused.isError).toBe(true);
    expect(resultJson(refused)).toMatchObject({ error: { code: "computer_target_not_found" } });
    const found = await call("computer_click", { label: "Calculate" });
    expect(found.isError).not.toBe(true);
  });

  it("clamps a drag duration to the bound its schema advertises", async () => {
    const { backend, byName, call, see } = await setup();
    await see();

    await call("computer_drag", {
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      duration_ms: 1e9,
    });
    await call("computer_drag", { from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, duration_ms: -5 });

    const durations = backend.callsFor("drag").map((entry) => entry.args[2]);
    expect(durations).toEqual([30_000, 0]);
    const schema = byName.get("computer_drag")?.definition.inputSchema as {
      properties: { duration_ms: { maximum: number; minimum: number } };
    };
    // The clamp is the schema's own bound, not a second opinion about it.
    expect(schema.properties.duration_ms).toMatchObject({ maximum: 30_000, minimum: 0 });
  });
});

describe("agent gateway computer setup prompts", () => {
  /** One tool call against a backend whose window read fails the given way. */
  async function readFailingWith(error: unknown) {
    const backend = Object.assign(new FakeComputerBackend(), {
      listWindows: () => Promise.reject(error),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const setupPrompts: string[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName }) => Effect.sync(() => void setupPrompts.push(toolName)),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    const result = await Effect.runPromise(tool.handler({}, makeContext()));
    return { result, setupPrompts };
  }

  it("prompts for setup when the desktop withheld an OS permission", async () => {
    const { result, setupPrompts } = await readFailingWith(
      new ComputerBackendError("Screen Recording is not granted.", { setupRequired: true }),
    );
    expect(result.isError).toBe(true);
    expect(setupPrompts).toEqual(["computer_list_windows"]);
  });

  it("returns a structured pause without asking for OS permissions", async () => {
    const pause = { windowId: "test-window", message: "Return to this desktop." };
    const { result, setupPrompts } = await readFailingWith(
      new ComputerBackendError(pause.message, { inputPause: pause }),
    );
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toEqual({
      error: { code: "computer_input_paused", ...pause, retryable: false },
    });
    expect(setupPrompts).toEqual([]);
  });

  it("prompts for setup when the permission failure arrived wrapped", async () => {
    const wrapped = new Error("the desktop refused", {
      cause: new ComputerBackendError("Accessibility is not granted.", { setupRequired: true }),
    });
    const { setupPrompts } = await readFailingWith(wrapped);
    expect(setupPrompts).toEqual(["computer_list_windows"]);
  });

  it.each([
    [
      "a target that is no longer there",
      new ComputerTargetError({
        code: "computer_target_not_found",
        message: "No control matches that label.",
      }),
    ],
    ["an ordinary backend fault", new ComputerBackendError("The click was not delivered.")],
    ["an unrelated failure", new Error("boom")],
  ])("does not prompt for setup after %s", async (_name, error) => {
    const { result, setupPrompts } = await readFailingWith(error);
    expect(result.isError).toBe(true);
    expect(setupPrompts).toEqual([]);
  });

  /** One `computer_list_windows` against a backend that succeeds but is blocked. */
  async function readWith(overrides: Partial<FakeComputerBackend>) {
    const backend = Object.assign(new FakeComputerBackend(), overrides);
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const prompts: {
      toolName: string;
      missing: readonly string[];
      buildSignature?: string;
    }[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName, missing, buildSignature }) =>
        Effect.sync(
          () =>
            void prompts.push({
              toolName,
              missing,
              ...(buildSignature ? { buildSignature } : {}),
            }),
        ),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    const result = await Effect.runPromise(tool.handler({}, makeContext()));
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    return { result, prompts, text };
  }

  it("prompts for setup when a successful result reports a permission state", async () => {
    // The shape that slipped through before this funnel: the call succeeded, the
    // payload said "Synara needs Accessibility", and nothing put a card on
    // screen — so the model explained macOS privacy in prose instead.
    const { result, prompts, text } = await readWith({
      availability: () =>
        Promise.resolve({
          kind: "permission-required",
          missing: ["accessibility"],
          message: "Synara needs Accessibility to control this Mac. Turn Synara on in…",
          buildSignature: "signed",
        }),
      missingPermissions: () => Promise.resolve(["accessibility"]),
    });

    expect(result.isError).not.toBe(true);
    expect(prompts).toEqual([
      { toolName: "computer_list_windows", missing: ["accessibility"], buildSignature: "signed" },
    ]);
    // The model is told the OS is asking the user right now — not how macOS
    // privacy works, and not to walk them through System Settings over the top
    // of a dialog that is already on screen.
    expect(text).toContain("macOS is asking the user right now for Accessibility");
    expect(text).toContain("waiting for the user to grant it");
    expect(text).not.toContain("Turn Synara on in");
  });

  it("prompts for setup for a grant that only blinds the desktop", async () => {
    // Screen Recording alone leaves availability `available` on purpose, so the
    // only thing that can raise the card is the backend saying what it lacks.
    const { result, prompts } = await readWith({
      missingPermissions: () => Promise.resolve(["screenRecording"]),
    });

    expect(result.isError).not.toBe(true);
    expect(prompts).toEqual([{ toolName: "computer_list_windows", missing: ["screenRecording"] }]);
  });

  it("reads the missing grants fresh on every call, never from the previous answer", async () => {
    // The live failure this signature exists to prevent: the user granted Screen
    // Recording between two tool calls, the second call re-read a cached
    // "missing", and the card and the model's refusal stayed on screen over a
    // desktop that already worked.
    let granted = false;
    const { prompts } = await readWith({
      missingPermissions: () => {
        const answer = granted ? [] : ["screenRecording"];
        granted = true;
        return Promise.resolve(answer as readonly ComputerPermission[]);
      },
    });
    expect(prompts).toEqual([{ toolName: "computer_list_windows", missing: ["screenRecording"] }]);

    const second = await readWith({
      missingPermissions: () => Promise.resolve([]),
    });
    expect(second.prompts).toEqual([]);
  });

  it("carries an ad-hoc build signature to the card, so it can explain a stale grant", async () => {
    // On a locally built copy System Settings can show Synara switched on while
    // the grant is pinned to a binary a rebuild replaced; without this the card
    // tells the user to flip a switch that is already flipped.
    const { prompts } = await readWith({
      missingPermissions: () => Promise.resolve(["screenRecording"]),
      buildSignature: () => "adhoc",
    });

    expect(prompts).toEqual([
      { toolName: "computer_list_windows", missing: ["screenRecording"], buildSignature: "adhoc" },
    ]);
  });

  it("carries the named grants through a thrown refusal", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      listWindows: () =>
        Promise.reject(
          new ComputerBackendError("The helper refused: -32000.", { setupRequired: true }),
        ),
      missingPermissions: () => Promise.resolve(["screenRecording"] as const),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const prompts: { toolName: string; missing: readonly string[] }[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName, missing }) =>
        Effect.sync(() => void prompts.push({ toolName, missing })),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    await Effect.runPromise(tool.handler({}, makeContext()));

    expect(prompts).toEqual([{ toolName: "computer_list_windows", missing: ["screenRecording"] }]);
  });

  it("says nothing about setup when every grant is in place", async () => {
    const { prompts, text } = await readWith({});
    expect(prompts).toEqual([]);
    expect(text).not.toContain("setup card");
    expect(text).not.toContain("macOS is asking");
  });

  it("tells the model to stop for a blocking grant and to carry on for a degrading one", async () => {
    // Screen Recording declined leaves the desktop perfectly driveable and only
    // unseeable, and the note used to say "Stop desktop automation… do not
    // retry" on every successful call for the rest of the session.
    const degrading = await readWith({
      missingPermissions: () => Promise.resolve(["screenRecording"]),
    });
    expect(degrading.text).toContain("does not block desktop control");
    expect(degrading.text).toContain("Do not stop");
    expect(degrading.text).not.toContain("Stop desktop automation");

    const blocking = await readWith({
      missingPermissions: () => Promise.resolve(["accessibility"]),
    });
    expect(blocking.text).toContain("Nothing on the desktop can be driven without it");
    expect(blocking.text).toContain("Stop desktop automation");
  });

  it("puts the setup note on the error path and on a screenshot-bearing result", async () => {
    // Both were unreachable: the catch branch returned the backend's raw
    // message, and every screenshot-bearing result is already a built tool
    // result, which the note only knew how to add to a plain object.
    const backend = Object.assign(new FakeComputerBackend(), {
      missingPermissions: () => Promise.resolve(["accessibility"] as const),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const tools = makeAgentGatewayComputerTools({ manager });
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    const run = async (name: string, args: Record<string, unknown>) =>
      await Effect.runPromise(byName.get(name)!.handler(args, makeContext()));

    // A perception read with an image: the note lands in the JSON text part
    // beside the picture.
    const state = await run("computer_get_state", { include_screenshot: true });
    expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect((resultJson(state) as { setupRequired?: string }).setupRequired).toContain(
      "macOS is asking the user right now for Accessibility",
    );

    // And a failure, which used to hand back the backend's sentence alone.
    backend.failNext("captureScreenshot");
    const failed = await run("computer_screenshot", { window_id: "fake-terminal" });
    expect(failed.isError).toBe(true);
    const text = failed.content.find((entry) => entry.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain("macOS is asking the user right now");
  });

  it("raises the card from a state read that reports a blocking permission", async () => {
    // The primary perception tool carried no availability at all, so the
    // permission-required branch could not fire for the call an agent makes
    // first.
    const backend = Object.assign(new FakeComputerBackend(), {
      availability: () =>
        Promise.resolve({
          kind: "permission-required" as const,
          missing: ["accessibility" as const],
          message: "Synara needs Accessibility to control this Mac.",
          buildSignature: "signed" as const,
        }),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const prompts: string[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      onSetupRequired: ({ toolName }) => Effect.sync(() => void prompts.push(toolName)),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_get_state")!;
    const result = await Effect.runPromise(tool.handler({}, makeContext()));

    expect(prompts).toEqual(["computer_get_state"]);
    expect(resultJson(result)).toMatchObject({
      availability: { kind: "permission-required", missing: ["accessibility"] },
    });
  });
});

describe("screenshot delivery consistency", () => {
  it("refreshes screenshot coordinates when an unchanged window moves", async () => {
    const { backend, manager, call } = await setup();
    try {
      await call("computer_press_key", { key: "enter", window_id: "fake-calculator" });
      const windows = await backend.listWindows();
      backend.emitWindowsChanged(
        // Preserve the earlier window snapshot so movement can invalidate it.
        // oxlint-disable-next-line no-map-spread
        windows.map((w) =>
          w.id === "fake-calculator" ? { ...w, bounds: { ...w.bounds!, x: 600 } } : w,
        ),
      );
      await call("computer_press_key", { key: "enter", window_id: "fake-calculator" });
      await call("computer_click", { x: 5, y: 5, include_screenshot: false });
      expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 605, y: 125 });
    } finally {
      await manager.dispose();
    }
  });
  it("returns the action window after an intervening workspace screenshot", async () => {
    const { manager, call, see } = await setup();
    try {
      await call("computer_press_key", { key: "enter", window_id: "fake-calculator" });
      await see();
      const repeat = await call("computer_press_key", {
        key: "enter",
        window_id: "fake-calculator",
      });
      expect(repeat.content.some((c) => c.type === "image")).toBe(true);
    } finally {
      await manager.dispose();
    }
  });
});

describe("computer operation ordering", () => {
  it("keeps pane input after the action observation and refuses a queued call from an ended turn", async () => {
    const { backend, manager, byName, call } = await setup();
    const { promise: held, resolve: finish } = Promise.withResolvers<void>();
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const pressKey = backend.pressKey.bind(backend);
    backend.pressKey = async (key) => {
      const result = await pressKey(key);
      entered();
      await held;
      return result;
    };
    const events: string[] = [];
    const capture = backend.captureScreenshot.bind(backend);
    backend.captureScreenshot = async (request) => {
      events.push("capture");
      return capture(request);
    };
    const type = backend.typeText.bind(backend);
    backend.typeText = async (text) => {
      events.push("pane input");
      return type(text);
    };
    let active = true;
    try {
      const first = call("computer_press_key", { key: "enter" });
      await started;
      const paneInput = manager.typeText(undefined, "human");
      const context = {
        ...makeContext(),
        assertCallerTurnActive: () =>
          active
            ? Effect.void
            : Effect.fail(
                new GatewayToolError("caller_turn_inactive", "The requesting turn ended."),
              ),
      };
      const next = Effect.runPromise(
        byName.get("computer_press_key")!.handler({ key: "escape" }, context),
      );
      active = false;
      expect(events).toEqual([]);
      finish();
      await first;
      await paneInput;
      expect((await next).isError).toBe(true);
      expect(events).toEqual(["capture", "pane input"]);
      expect(backend.callsFor("pressKey")).toHaveLength(1);
    } finally {
      finish();
      await manager.dispose();
    }
  });
});

it("allows pane input while computer_wait is pending", async () => {
  const { manager, call } = await setup();
  try {
    let waited = false;
    const waiting = call("computer_wait", { duration_ms: 250 }).then((result) => {
      waited = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.typeText(undefined, "human input");
    expect(waited).toBe(false);
    expect((await waiting).isError).not.toBe(true);
  } finally {
    await manager.dispose();
  }
});

it("keeps computer metadata compact and tool schemas below the audit baseline", async () => {
  const { manager, tools, call } = await setup(
    Object.assign(new FakeComputerBackend(), { agentDialect: "macos" as const }),
  );
  try {
    expect(JSON.stringify(tools.map((tool) => tool.definition)).length).toBeLessThan(42_000);
    const result = await call("computer_get_screen_size", {});
    const text = result.content.find((part) => part.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type === "text") expect(text.text).toBe(JSON.stringify(JSON.parse(text.text)));
  } finally {
    await manager.dispose();
  }
});
