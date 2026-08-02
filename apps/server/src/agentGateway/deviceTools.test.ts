import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ProviderKind } from "@synara/contracts";

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

  it("returns the screenshot bytes as image content beside the metadata", async () => {
    const { call } = await setup();

    const result = await call("device_screenshot", { udid: DEVICE });

    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    const image = result.content.find((entry) => entry.type === "image");
    expect(image && image.type === "image" ? image.mimeType : null).toBe("image/png");
  });

  it("opens the pane when the agent installs or launches an app", async () => {
    const { manager, structured } = await setup();
    const events: unknown[] = [];
    manager.onEvent((event) => {
      if (event.type === "device.open-pane-requested") events.push(event);
    });

    await structured("device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" });
    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    expect(events).toEqual([
      {
        type: "device.open-pane-requested",
        threadId: THREAD,
        udid: DEVICE,
        reason: "agent-install",
      },
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
