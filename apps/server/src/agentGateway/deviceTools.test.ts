import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ProviderKind } from "@synara/contracts";

import { DeviceBackendError } from "../device/DeviceBackend.ts";
import { DeviceManager } from "../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../device/FakeDeviceBackend.ts";
import { makeAgentGatewayDeviceTools } from "./deviceTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const THREAD = "thread-a";
const DEVICE = "FAKE-0001";

function makeContext(provider: ProviderKind = "claudeAgent"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:test",
      threadId: THREAD,
      provider,
      turnId: "turn-a",
    },
    callerThreadId: THREAD,
    callerSessionKey: "gateway-session:test",
    callerProvider: provider,
    callerCapabilities: new Set(["device:control"]),
    callerTurnId: "turn-a",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup() {
  const backend = new FakeDeviceBackend();
  const manager = new DeviceManager({ backend });
  await manager.boot(DEVICE);
  const tools = makeAgentGatewayDeviceTools({ manager });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider)));
  };
  const structured = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
  ): Promise<unknown> => {
    const result = await call(name, args, provider);
    const text = result.content.find((entry) => entry.type === "text");
    return text && text.type === "text" ? JSON.parse(text.text) : null;
  };
  return { backend, manager, tools, byName, call, structured };
}

function collectOpenPaneRequests(manager: DeviceManager): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  manager.onEvent((event) => {
    if (event.type === "device.open-pane-requested") events.push(event);
  });
  return events;
}

/** Every tool that drives or reads the device the user is watching. */
const INTERACTION_CALLS = [
  ["device_tap", { udid: DEVICE, x: 10, y: 10 }],
  ["device_swipe", { udid: DEVICE, fromX: 0, fromY: 0, toX: 10, toY: 10 }],
  ["device_type", { udid: DEVICE, text: "hello" }],
  ["device_press_button", { udid: DEVICE, button: "home" }],
  ["device_scroll_to_element", { udid: DEVICE, label: "Deep Row" }],
  ["device_describe_ui", { udid: DEVICE }],
  ["device_screenshot", { udid: DEVICE }],
] as const;

describe("agent gateway device tools surface", () => {
  it("exposes the full device tool set behind the device:control capability", async () => {
    const { tools } = await setup();

    expect(tools.map((tool: ToolEntry) => tool.definition.name)).toEqual([
      "device_list",
      "device_boot",
      "device_install",
      "device_launch",
      "device_open_url",
      "device_tap",
      "device_swipe",
      "device_type",
      "device_press_button",
      "device_screenshot",
      "device_describe_ui",
      "device_scroll_to_element",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "device:control")).toBe(true);
  });

  it("requires an active turn for every tool, including the read-only ones", async () => {
    const { tools } = await setup();

    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
  });

  it("marks read tools read-only and input tools as writes", async () => {
    const { byName } = await setup();

    expect(byName.get("device_describe_ui")?.definition.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("device_screenshot")?.definition.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("device_tap")?.definition.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("device_open_url")?.definition.annotations?.openWorldHint).toBe(true);
  });
});

describe("agent gateway device tool handlers", () => {
  it("lists devices with their availability", async () => {
    const { structured } = await setup();

    const result = (await structured("device_list", {})) as {
      devices: readonly { udid: string; bootSource: string }[];
      availability: { kind: string };
    };

    expect(result.availability).toEqual({ kind: "available" });
    expect(result.devices.find((device) => device.udid === DEVICE)?.bootSource).toBe("synara");
  });

  it("taps through to the backend with the requested device points", async () => {
    const { backend, structured } = await setup();

    await structured("device_tap", { udid: DEVICE, x: 100, y: 220 });

    expect(backend.callsOfKind("tap")[0]).toMatchObject({ udid: DEVICE, x: 100, y: 220 });
  });

  it("taps a label at the control's own point and reports its prior state", async () => {
    const { backend, structured } = await setup();

    const result = (await structured("device_tap", {
      udid: DEVICE,
      label: "Fake Toggle",
    })) as { x: number; element: { subrole: string; valueBeforeTap: string } };

    // The switch, not the row centre at x=196.
    expect(result.x).toBe(340);
    expect(result.element).toMatchObject({ subrole: "Switch", valueBeforeTap: "0" });
    expect(backend.callsOfKind("tap")[0]).toMatchObject({ x: 340, y: 222 });
  });

  it("scrolls a below-the-fold element into view without the agent swiping", async () => {
    const { backend, structured } = await setup();

    const result = (await structured("device_scroll_to_element", {
      udid: DEVICE,
      label: "Deep Row",
    })) as { element: { label: string }; tapPoint: { y: number } };

    expect(result.element.label).toBe("Deep Row");
    expect(backend.callsOfKind("swipe").length).toBeGreaterThan(0);
    // Landed somewhere tappable rather than merely on screen.
    expect(result.tapPoint.y).toBeGreaterThan(0);
    expect(result.tapPoint.y).toBeLessThan(852);
  });

  it("reports the labels on screen when a scroll target does not exist", async () => {
    const { call } = await setup();

    const result = await call("device_scroll_to_element", { udid: DEVICE, label: "Nope" });

    const entry = result.content.find((item) => item.type === "text");
    const message = entry && entry.type === "text" ? entry.text : "";
    expect(result.isError).toBe(true);
    // A dead-end error is one that names no alternative; the real labels have
    // to survive into the message the agent reads.
    expect(message).toMatch(/No element labelled/);
    expect(message).toMatch(/Fake Toggle/);
  });

  it("returns the screenshot bytes as image content beside the metadata", async () => {
    const { call } = await setup();

    const result = await call("device_screenshot", { udid: DEVICE });

    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    const image = result.content.find((entry) => entry.type === "image");
    expect(image && image.type === "image" ? image.mimeType : null).toBe("image/png");
  });

  it("opens the pane when the agent installs an app", async () => {
    const { manager, structured } = await setup();
    const events = collectOpenPaneRequests(manager);

    await structured("device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" });

    expect(events).toEqual([
      {
        type: "device.open-pane-requested",
        threadId: THREAD,
        udid: DEVICE,
        reason: "agent-install",
      },
    ]);
  });

  it("opens the pane when the agent launches an app", async () => {
    const { manager, structured } = await setup();
    const events = collectOpenPaneRequests(manager);

    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    expect(events).toEqual([
      {
        type: "device.open-pane-requested",
        threadId: THREAD,
        udid: DEVICE,
        reason: "agent-launch",
      },
    ]);
  });

  it("reports the boot-limit refusal to the agent rather than failing", async () => {
    const { structured } = await setup();
    await structured("device_boot", { udid: "FAKE-0002" });
    await structured("device_boot", { udid: "FAKE-0003" });

    const result = (await structured("device_boot", { udid: "FAKE-0004" })) as { kind: string };

    expect(result.kind).toBe("boot-limit-reached");
  });

  it("surfaces a backend failure as a tool error and records it on the thread", async () => {
    const { manager, call } = await setup();

    const result = await call("device_tap", { udid: "FAKE-0002", x: 1, y: 1 });

    expect(result.isError).toBe(true);
    expect((await manager.getThreadState(THREAD)).lastError).toContain("not booted");
  });

  it("rejects malformed arguments without touching the device", async () => {
    const { backend, call } = await setup();

    const missingUdid = await call("device_tap", { x: 1, y: 1 });
    const badCoordinate = await call("device_tap", { udid: DEVICE, x: -5, y: 1 });

    expect(missingUdid.isError).toBe(true);
    expect(badCoordinate.isError).toBe(true);
    expect(backend.callsOfKind("tap")).toHaveLength(0);
  });

  it("enforces contract bounds for swipe duration and scroll budget", async () => {
    const { backend, call } = await setup();

    const fractionalDuration = await call("device_swipe", {
      udid: DEVICE,
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 10,
      durationMs: 10.5,
    });
    const excessiveDuration = await call("device_swipe", {
      udid: DEVICE,
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 10,
      durationMs: 10_001,
    });
    const excessiveScrolls = await call("device_scroll_to_element", {
      udid: DEVICE,
      label: "Deep Row",
      maxSwipes: 33,
    });

    expect(fractionalDuration.isError).toBe(true);
    expect(excessiveDuration.isError).toBe(true);
    expect(excessiveScrolls.isError).toBe(true);
    expect(backend.callsOfKind("swipe")).toHaveLength(0);
  });

  it("marks the thread agent-active only while a tool runs", async () => {
    const { manager, structured } = await setup();

    await structured("device_describe_ui", { udid: DEVICE });

    expect((await manager.getThreadState(THREAD)).agentActive).toBe(false);
  });
});

describe("agent gateway device tools without an approval gate", () => {
  it("refuses input and open_url for Antigravity before the action runs", async () => {
    const { backend, call } = await setup();

    for (const [name, args] of [
      ["device_tap", { udid: DEVICE, x: 1, y: 1 }],
      ["device_swipe", { udid: DEVICE, fromX: 0, fromY: 0, toX: 10, toY: 10 }],
      ["device_type", { udid: DEVICE, text: "hello" }],
      ["device_press_button", { udid: DEVICE, button: "home" }],
      ["device_open_url", { udid: DEVICE, url: "https://example.com" }],
      ["device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" }],
      ["device_launch", { udid: DEVICE, bundleId: "com.example.Demo" }],
      ["device_boot", { udid: "FAKE-0002" }],
    ] as const) {
      const result = await call(name, args, "antigravity");
      expect(result.isError, `${name} should be refused`).toBe(true);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text && text.type === "text" ? text.text : "").toContain("DeviceApprovalRequired");
    }

    expect(backend.calls.filter((entry) => entry.kind !== "attachStream")).toEqual([
      { kind: "boot", udid: DEVICE },
    ]);
  });

  it("still allows the read tools for Antigravity", async () => {
    const { call } = await setup();

    const list = await call("device_list", {}, "antigravity");
    const describe = await call("device_describe_ui", { udid: DEVICE }, "antigravity");
    const screenshot = await call("device_screenshot", { udid: DEVICE }, "antigravity");

    expect(list.isError).toBeUndefined();
    expect(describe.isError).toBeUndefined();
    expect(screenshot.isError).toBeUndefined();
  });

  it("allows every tool for providers that do gate approvals", async () => {
    const { call } = await setup();

    const result = await call("device_tap", { udid: DEVICE, x: 5, y: 5 }, "codex");

    expect(result.isError).toBeUndefined();
  });
});

describe("agent gateway device tools auto-attach", () => {
  it("attaches the caller thread to the device it launches on", async () => {
    const { manager, structured } = await setup();

    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    // The open-pane request is only useful if the pane has a device to stream.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
  });

  it("attaches on install too", async () => {
    const { manager, structured } = await setup();

    await structured("device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" });

    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
  });

  it("attaches on boot without opening the pane", async () => {
    const { manager, structured } = await setup();
    const opened = collectOpenPaneRequests(manager);

    await structured("device_boot", { udid: "FAKE-0002" });

    // Booting alone has nothing to watch yet, and the first real interaction
    // surfaces the pane anyway.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe("FAKE-0002");
    expect(opened).toHaveLength(0);
  });

  it("leaves a thread already watching another device alone", async () => {
    const { backend, manager, structured } = await setup();
    await backend.boot("FAKE-0002");
    await manager.attach(THREAD, "FAKE-0002");

    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe("FAKE-0002");
  });

  it("still returns the launch result when attaching cannot stream", async () => {
    const { backend, structured } = await setup();
    backend.failNext("attachStream", new DeviceBackendError("helper is not built"));

    const result = (await structured("device_launch", {
      udid: DEVICE,
      bundleId: "com.example.Demo",
    })) as { bundleId?: string };

    // A stream failure must not turn a successful launch into a tool error.
    expect(result.bundleId).toBe("com.example.Demo");
  });
});

describe("agent gateway device tools surface the pane on any interaction", () => {
  // The demo failure: an Expo app already running on a booted simulator, so the
  // agent never installs or launches and goes straight to describe/tap.
  for (const [name, args] of INTERACTION_CALLS) {
    it(`attaches and opens the pane on ${name}`, async () => {
      const { manager, call } = await setup();
      const opened = collectOpenPaneRequests(manager);

      const result = await call(name, { ...args });

      expect(result.isError, `${name} should succeed`).not.toBe(true);
      expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
      expect(opened).toEqual([
        {
          type: "device.open-pane-requested",
          threadId: THREAD,
          udid: DEVICE,
          reason: "agent-tool",
        },
      ]);
    });

    it(`asks the pane to open only once across repeated ${name} calls`, async () => {
      const { manager, call } = await setup();
      const opened = collectOpenPaneRequests(manager);

      await call(name, { ...args });
      await call(name, { ...args });
      await call(name, { ...args });

      // An agent taps every few seconds; re-requesting per call would spam the
      // UI and could yank back a user who navigated away.
      expect(opened).toHaveLength(1);
    });

    it(`never steals a thread already watching another device on ${name}`, async () => {
      const { backend, manager, call } = await setup();
      await backend.boot("FAKE-0002");
      await manager.attach(THREAD, "FAKE-0002");
      const opened = collectOpenPaneRequests(manager);

      await call(name, { ...args });

      expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe("FAKE-0002");
      // The attachment the user chose survives; the request names the agent's
      // device, which stays reachable from the picker.
      expect(opened.map((event) => event.udid)).toEqual([DEVICE]);
    });
  }

  it("does not surface the pane for device_list", async () => {
    const { manager, structured } = await setup();
    const opened = collectOpenPaneRequests(manager);

    await structured("device_list", { includeShutdown: true });

    // Pure discovery, usually called before the agent has picked a device.
    expect(opened).toHaveLength(0);
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBeNull();
  });

  it("does not surface the pane when the interaction fails", async () => {
    const { manager, call } = await setup();
    const opened = collectOpenPaneRequests(manager);

    const result = await call("device_tap", { udid: "FAKE-0002", x: 1, y: 1 });

    expect(result.isError).toBe(true);
    expect(opened).toHaveLength(0);
  });

  it("keeps the pane request idempotent across different interaction tools", async () => {
    const { manager, call } = await setup();
    const opened = collectOpenPaneRequests(manager);

    for (const [name, args] of INTERACTION_CALLS) await call(name, { ...args });

    expect(opened).toHaveLength(1);
    // One attach, so no duplicate stream for the pane to reconcile.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
  });
});
