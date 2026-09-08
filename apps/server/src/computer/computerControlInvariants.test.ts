import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { MacComputerBackend } from "./MacComputerBackend.ts";
import { makeAgentGatewayComputerTools } from "../agentGateway/computerTools.ts";
import type { ToolContext } from "../agentGateway/toolRuntime.ts";
import type { ComputerResolvedTarget } from "./ComputerBackend.ts";
import { MacComputerHelperClient } from "./macComputerHelperClient.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function context(): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "audit",
      threadId: "audit",
      provider: "claudeAgent",
      turnId: "turn",
    },
    callerThreadId: "audit",
    callerThreadLabel: "Audit",
    callerSessionKey: "audit",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}
function setup(backend = new FakeComputerBackend()) {
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = new Map(
    makeAgentGatewayComputerTools({ manager }).map((t) => [t.definition.name, t]),
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    Effect.runPromise(tools.get(name)!.handler(args, context()));
  return { manager, tools, call };
}
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function macFixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const helper = {
    running: false,
    start() {
      this.running = true;
    },
    async dispose() {
      this.running = false;
    },
    async request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "capabilities")
        return {
          protocolVersion: 1,
          accessibility: true,
          screenRecording: true,
          signature: "signed",
          skylight: {
            setWindowLocation: true,
            focusWithoutRaise: true,
            setFrontProcess: true,
            keyWindowRecord: true,
          },
        };
      if (method === "screen-size") return { x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
      if (method === "list-windows")
        return {
          workspace: { x: 0, y: 0, width: 1920, height: 1080 },
          focusedWindowId: "7",
          windows: [
            {
              id: "7",
              title: "Human editor",
              appName: "Human editor",
              pid: 70,
              bounds: { x: 0, y: 0, width: 900, height: 700 },
              focused: true,
              visible: true,
              minimized: false,
              stackingIndex: 0,
            },
            {
              id: "5",
              title: "Agent target",
              appName: "Agent target",
              pid: 50,
              bounds: { x: 100, y: 100, width: 600, height: 500 },
              focused: false,
              visible: true,
              minimized: false,
              stackingIndex: 1,
            },
          ],
        };
      if (method === "type")
        return { ok: true, path: "keystrokes", verified: "unverifiable", windowId: "5" };
      if (method === "capture")
        return { base64: PNG, region: { x: 0, y: 0, width: 900, height: 700 } };
      return { ok: true, path: "keystrokes", verified: "unverifiable" };
    },
  };
  const backend = new MacComputerBackend({
    platform: "darwin",
    now: () => 0,
    env: {},
    resolveBinary: async () => "/fake/audit",
    makeHelperClient: () => helper,
  });
  return { backend, calls };
}

describe("Production audit: desired invariants", () => {
  it("hover must not change keyboard focus", async () => {
    const backend = new FakeComputerBackend();
    const { manager } = setup(backend);
    try {
      await manager.moveCursor("audit", { windowId: "fake-calculator", x: 1180, y: 228 });
      expect(backend.calls.filter((c) => c.method === "focusWindow")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("concurrent keyboard calls must preserve each named target", async () => {
    const entered = deferred(),
      release = deferred();
    const backend = new FakeComputerBackend();
    let aim = "";
    const deliveries: { text: string; aim: string }[] = [];
    backend.focusWindow = async (id) => {
      aim = id;
      if (id === "fake-calculator") {
        entered.resolve();
        await release.promise;
      }
    };
    backend.typeText = async (text) => {
      deliveries.push({ text, aim });
      return { value: text };
    };
    const { manager } = setup(backend);
    await manager.listWindows();
    const first = manager.typeText("audit", "calculator text", "fake-calculator");
    await entered.promise;
    const second = manager.typeText("audit", "browser text", "fake-terminal");
    await Promise.resolve();
    expect(deliveries).toEqual([]);
    release.resolve();
    await Promise.all([first, second]);
    await manager.dispose();
    expect(deliveries.find((d) => d.text === "calculator text")?.aim).toBe("fake-calculator");
  });

  it("aborting a tool during targeting must prevent its later click", async () => {
    const entered = deferred(),
      release = deferred();
    const backend = new FakeComputerBackend();
    const getState = backend.getState.bind(backend);
    backend.getState = async (options) => {
      entered.resolve();
      await release.promise;
      return getState(options);
    };
    const { manager, tools } = setup(backend);
    const abort = new AbortController();
    const result = Effect.runPromise(
      tools
        .get("computer_click")!
        .handler({ label: "Calculate", role: "button", include_screenshot: false }, context()),
      { signal: abort.signal },
    ).catch(() => undefined);
    await entered.promise;
    abort.abort();
    await result;
    release.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await manager.dispose();
    expect(backend.calls.filter((c) => c.method === "click")).toEqual([]);
  });

  it("a moved window must deliver its new screenshot geometry", async () => {
    const backend = new FakeComputerBackend();
    const { manager } = setup(backend);
    await manager.captureActionScreenshot("fake-calculator", undefined, "audit");
    backend.emitWindowsChanged(
      (await backend.listWindows()).map((w) =>
        w.id === "fake-calculator" ? { ...w, bounds: { ...w.bounds!, x: 800 } } : w,
      ),
    );
    const result = await manager.captureActionScreenshot("fake-calculator", undefined, "audit");
    await manager.dispose();
    expect(result).toHaveProperty("screenshot.region.x", 800);
  });

  it("an intervening explicit screenshot must prevent unrelated image reuse", async () => {
    const { manager, call } = setup();
    await call("computer_click", { label: "Calculate", role: "button" });
    const explicit = await call("computer_screenshot", { window_id: "fake-terminal" });
    expect(explicit.isError).not.toBe(true);
    expect(explicit.content.some((c) => c.type === "image")).toBe(true);
    const result = await call("computer_click", { label: "Calculate", role: "button" });
    await manager.dispose();
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("semantic click must retain its resolved window in the helper request", async () => {
    const { backend, calls } = macFixture();
    const target: ComputerResolvedTarget = {
      target: { label: "Button" },
      point: { x: 200, y: 200 },
      node: {
        role: "button",
        label: "Button",
        value: null,
        description: null,
        frame: { x: 100, y: 100, width: 600, height: 500 },
        activationPoint: { x: 200, y: 200 },
        onScreen: true,
        windowId: "5",
        nodePath: [0],
        children: [],
      },
    };
    await backend.performAction(target, "click");
    await backend.dispose();
    expect(calls.find((c) => c.method === "perform-action")?.params.windowId).toBe("5");
  });

  it("unqualified keyboard observation must show the agent target, not human focus", async () => {
    const { backend, calls } = macFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await manager.typeText("audit", "initial", "5");
    const result = await manager.typeText("audit", "hello");
    await manager.captureActionScreenshot(result.windowId, result.point, "audit");
    await manager.dispose();
    expect(calls.find((c) => c.method === "capture")?.params.windowId).toBe("5");
  });

  it("desktop lease release must clear the previous task's keyboard target", async () => {
    const backend = new FakeComputerBackend();
    let aim: string | undefined;
    backend.focusWindow = async (id) => {
      aim = id;
    };
    backend.clearFocusWindow = async () => {
      aim = undefined;
    };
    backend.typeText = async (text) => {
      if (!aim) throw new Error("No keyboard target");
      return { value: text, windowId: aim };
    };
    const { manager } = setup(backend);
    await manager.typeText("task-a", "A", "fake-calculator");
    await manager.releaseDesktopControl("task-a");
    try {
      await expect(manager.typeText("task-b", "B")).rejects.toThrow("No keyboard target");
    } finally {
      await manager.dispose();
    }
  });

  it("a failed ownership reset cannot let a retry inherit stale keyboard aim", async () => {
    const backend = new FakeComputerBackend();
    let resets = 0;
    let aim: string | undefined = "previous-task-window";
    backend.clearFocusWindow = async () => {
      if (++resets === 1) throw new Error("Helper unavailable");
      aim = undefined;
    };
    backend.typeText = async () => {
      if (!aim) throw new Error("No keyboard target");
      throw new Error("Stale keyboard target was used");
    };
    const { manager } = setup(backend);
    try {
      await expect(manager.typeText("task-b", "B")).rejects.toThrow("Helper unavailable");
      await expect(manager.typeText("task-b", "B")).rejects.toThrow("No keyboard target");
      expect(resets).toBe(2);
    } finally {
      await manager.dispose();
    }
  });

  it("a valid thirty-second drag must not time out at fifteen seconds", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        this.signalCode = signal;
        child.emit("exit", null, signal);
        return true;
      },
    });
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString());
      setTimeout(
        () => child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"),
        request.params.durationMs,
      );
    });
    const client = new MacComputerHelperClient({
      binaryPath: "/fake/audit",
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    let failure: unknown;
    const request = client.request("drag", { durationMs: 30_000 }).catch((e) => {
      failure = e;
    });
    try {
      await vi.advanceTimersByTimeAsync(15_001);
      expect(failure).toBeUndefined();
    } finally {
      await client.dispose();
      await request;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("Additional production invariants", () => {
  it("passes the requested window to the native accessibility scan", async () => {
    const { backend, calls } = macFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await manager.getState({ includeTree: true, windowId: "5" });
    expect(calls.find((call) => call.method === "describe-ui")?.params).toEqual({
      windowIds: ["5"],
    });
    await manager.dispose();
  });

  it.each(["pi", "antigravity"] as const)(
    "lets Synara approve or deny %s actions",
    async (provider) => {
      const backend = new FakeComputerBackend();
      const manager = new ComputerManager({ backend, actionSettleMs: 0 });
      let allowed = false;
      const authorizeAction = vi.fn(async () => allowed);
      const tool = makeAgentGatewayComputerTools({ manager, authorizeAction }).find(
        (tool) => tool.definition.name === "computer_type_text",
      )!;
      const caller = {
        ...context(),
        callerProvider: provider,
        principal: { ...context().principal, provider },
      };
      const denied = await Effect.runPromise(
        tool.handler({ text: "denied", include_screenshot: false }, caller),
      );
      expect(denied.isError).toBe(true);
      expect(backend.calls.filter((call) => call.method === "typeText")).toHaveLength(0);
      allowed = true;
      const accepted = await Effect.runPromise(
        tool.handler({ text: "approved", include_screenshot: false }, caller),
      );
      expect(accepted.isError).not.toBe(true);
      expect(backend.calls.filter((call) => call.method === "typeText")).toHaveLength(1);
      expect(authorizeAction).toHaveBeenCalledTimes(2);
      await manager.dispose();
    },
  );

  it("rechecks original turn authority after waiting for the desktop", async () => {
    const backend = new FakeComputerBackend();
    const { manager, tools } = setup(backend);
    const entered = deferred(),
      release = deferred();
    const first = manager.withAgentActivity("audit", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let active = true;
    const caller = {
      ...context(),
      assertCallerTurnActive: () =>
        active
          ? Effect.void
          : Effect.fail(new GatewayToolError("caller_turn_inactive", "original turn ended")),
    };
    const second = Effect.runPromise(
      tools
        .get("computer_type_text")!
        .handler({ text: "never", include_screenshot: false }, caller),
    );
    await Promise.resolve();
    active = false;
    release.resolve();
    await first;
    expect((await second).isError).toBe(true);
    expect(backend.calls.filter((call) => call.method === "typeText")).toHaveLength(0);
    await manager.dispose();
  });
});
