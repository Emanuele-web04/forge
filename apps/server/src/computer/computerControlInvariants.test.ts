import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { makeAgentGatewayComputerTools } from "../agentGateway/computerTools.ts";
import type { ToolContext } from "../agentGateway/toolRuntime.ts";

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
});

describe("Provider authority invariants", () => {
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
