import { describe, expect, it, vi } from "vitest";
import { CuaComputerBackend } from "./CuaComputerBackend.ts";
import { ComputerAvailability, ComputerScreenshot } from "@synara/contracts";
import { Schema } from "effect";
import { CuaTransportError, type cuaRequest } from "@synara/shared/cuaDriverProtocol";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { withDesktopDeliveryMode } from "./DesktopOperationQueue.ts";

const isTyping = (name?: string) => name === "type_text";

function fixture() {
  const calls: Array<{ name?: string; args?: Record<string, unknown> }> = [];
  let bounds = { x: -300, y: 20, width: 200, height: 100 };
  let live = true;
  let failure: Error | undefined;
  let nativeRefusal = false;
  let missingPermissions = false;
  let captureWindowId = 20;
  let capturePid = 10;
  let visible = true;
  let ready: Record<string, unknown> = { ready: true, pid: 10, window_id: 20 };
  let afterCapture: (() => void) | undefined;
  let actionResult: Record<string, unknown> = {
    route: "synthetic_events",
    delivery: { mode: "background" },
    effect: "unverifiable",
  };
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  const request = vi.fn(async (_endpoint, request) => {
    calls.push(request);
    if (request.method === "probe" || request.method === "stop") return { ok: true };
    if (isTyping(request.name) && failure) throw failure;
    if (isTyping(request.name) && nativeRefusal)
      return {
        ok: true,
        result: {
          isError: true,
          structuredContent: { effect: "refused", code: "same_pid_keyboard_ambiguity" },
          content: [{ type: "text", text: "No actuator ran." }],
        },
      };
    let data: unknown = {};
    if (request.name === "check_permissions")
      data = { accessibility: !missingPermissions, screen_recording: !missingPermissions };
    if (request.name === "list_windows")
      data = {
        windows: live
          ? [
              {
                pid: 10,
                window_id: 20,
                title: "Owned fixture",
                bounds,
                is_on_screen: visible,
                on_current_space: visible,
                z_index: 1,
              },
              { pid: 20, window_id: 30, bounds: { x: 0, y: 0, width: 0, height: 0 } },
            ]
          : [],
      };
    if (request.name === "check_input_ready") data = ready;
    if (request.name === "get_screen_size") data = { width: 1000, height: 800, scale_factor: 2 };
    if (request.name === "get_window_state") {
      const result = {
        structuredContent: {
          pid: capturePid,
          window_id: captureWindowId,
          window_bounds: bounds,
          screenshot_frame_valid: true,
          elements: [],
        },
        content: [{ type: "image", mimeType: "image/png", data: header.toString("base64") }],
      };
      afterCapture?.();
      return { ok: true, result };
    }
    if (isTyping(request.name)) data = actionResult;
    return { ok: true, result: { structuredContent: data } };
  }) as unknown as typeof cuaRequest;
  const backend = new CuaComputerBackend({ endpoint: "/fixture-only", request });
  return {
    backend,
    calls,
    setVisible: (value: boolean) => {
      visible = value;
    },
    readiness: (value: Record<string, unknown>) => {
      ready = value;
    },
    moveAfterCapture: () => {
      afterCapture = () => {
        bounds = { ...bounds, x: -250 };
      };
    },
    captureWindow: (value: number, pid = 10) => {
      captureWindowId = value;
      capturePid = pid;
    },
    actionResult: (value: Record<string, unknown>) => {
      actionResult = value;
    },
    move: () => {
      bounds = { ...bounds, x: -250 };
    },
    close: () => {
      live = false;
    },
    fail: (error: Error) => {
      failure = error;
    },
    refuse: () => {
      nativeRefusal = true;
    },
    denyPermissions: () => {
      missingPermissions = true;
    },
  };
}

describe("Cua native boundary", () => {
  it("checks exact native input readiness without capturing or dispatching input", async () => {
    const f = fixture();
    await expect(f.backend.checkInputReady("cua:10:20")).resolves.toBeUndefined();
    expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "check_input_ready"]);
    expect(f.calls[1]?.args).toEqual({ pid: 10, window_id: 20 });
    f.readiness({ ready: true, pid: 10, window_id: 21 });
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      code: "invalid_readiness",
      effect: "not-dispatched",
    });
    f.readiness({ ready: false });
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      code: "invalid_readiness",
    });
  });
  it("pauses input on another Space while leaving observation available", async () => {
    const f = fixture();
    f.setVisible(false);
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "target_not_on_active_space",
      inputPause: { windowId: "cua:10:20" },
    });
    expect(f.calls.some((call) => isTyping(call.name))).toBe(false);
    await expect(f.backend.getState({ windowId: "cua:10:20" })).resolves.toMatchObject({
      computerId: "desktop",
    });
  });
  it("preserves a native off-Space refusal during read-only readiness", async () => {
    const f = fixture();
    f.readiness({
      ready: false,
      effect: "refused",
      code: "target_not_on_active_space",
      pid: 10,
      window_id: 20,
      reason: "The target is on another Space.",
    });
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "target_not_on_active_space",
      inputPause: { windowId: "cua:10:20", message: "The target is on another Space." },
    });
    expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "check_input_ready"]);
  });
  it("maps only proven native Space refusals to recoverable pause", async () => {
    const f = fixture();
    f.actionResult({
      effect: "refused",
      code: "target_not_on_active_space",
      message: "Target is on another Space.",
    });
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      inputPause: { windowId: "cua:10:20" },
    });
    f.fail(new CuaTransportError("Space changed after dispatch", "dispatched-unknown"));
    const error = await f.backend.typeText("abc", "cua:10:20").catch((error) => error);
    expect(error.effect).toBe("dispatched-unknown");
    expect(error.inputPause).toBeUndefined();
    expect(f.calls.filter((call) => isTyping(call.name))).toHaveLength(2);
  });
  it("rejects a drag if its prepared window moves before input admission", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    f.moveAfterCapture();
    await expect(
      withDesktopDeliveryMode("foreground", () =>
        f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
      ),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "stale_geometry" });
    expect(f.calls.some((call) => call.name === "drag")).toBe(false);
  });
  it("binds foreground drag pixels to the exact observed native bounds", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    await withDesktopDeliveryMode("foreground", () =>
      f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
    );
    expect(f.calls.filter((call) => call.name === "drag")).toEqual([
      expect.objectContaining({
        args: {
          pid: 10,
          window_id: 20,
          delivery_mode: "foreground",
          from_x: 50,
          from_y: 20,
          to_x: 150,
          to_y: 60,
          duration_ms: 500,
          expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
        },
      }),
    ]);
  });
  it("preserves capture identity and rejects a different native window", async () => {
    const f = fixture();
    const image = await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(image)).toMatchObject({
      windowId: "cua:10:20",
    });
    expect(
      await f.backend.getState({ windowId: "cua:10:20", includeScreenshot: true }),
    ).toMatchObject({ screenshot: { windowId: "cua:10:20" } });
    f.captureWindow(21);
    await expect(
      f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    await expect(
      f.backend.getState({ windowId: "cua:10:20", includeTree: true }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    expect(f.calls.some((call) => call.name === "click")).toBe(false);
  });
  it.each([
    { pid: 11, windowId: 20 },
    { pid: 10, windowId: 21 },
  ])(
    "rejects preparation from pid $pid window $windowId before clicking",
    async ({ pid, windowId }) => {
      const f = fixture();
      await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      // Identical geometry does not establish that the native frame is ours.
      f.captureWindow(windowId, pid);
      await expect(f.backend.click({ x: -200, y: 70 }, "cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
      });
      expect(f.calls.some((call) => call.name === "click")).toBe(false);
    },
  );
  it("keeps explicitly approved foreground text on the native foreground tool", async () => {
    const f = fixture();
    await withDesktopDeliveryMode("foreground", () => f.backend.typeText("abc", "cua:10:20"));
    expect(f.calls.find((call) => isTyping(call.name))).toMatchObject({
      name: "type_text",
      args: { delivery_mode: "foreground", force_synthetic: true },
    });
  });
  it("reads the published action route and requires public verification evidence", async () => {
    const f = fixture();
    f.actionResult({
      route: "accessibility",
      delivery: { mode: "background" },
      effect: "confirmed",
    });
    expect(await f.backend.typeText("abc", "cua:10:20")).toMatchObject({
      effect: "dispatched-unknown",
      deliveryPath: "cua-accessibility-background",
    });
    f.actionResult({
      route: "accessibility",
      delivery: { mode: "background" },
      effect: "confirmed",
      evidence: [{ kind: "value_readback" }],
    });
    expect(await f.backend.typeText("def", "cua:10:20")).toMatchObject({
      effect: "verified",
      verified: "confirmed",
    });
  });
  it("preserves public action refusals even without the outer error flag", async () => {
    const f = fixture();
    f.actionResult({ route: "accessibility", effect: "refused" });
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
  });
  it("encodes missing grants with the public permission schema", async () => {
    const f = fixture();
    f.denyPermissions();
    const availability = await f.backend.availability();
    expect(Schema.decodeUnknownSync(ComputerAvailability)(availability)).toMatchObject({
      kind: "permission-required",
      missing: ["accessibility", "screenRecording"],
    });
  });
  it("ignores non-actionable zero-area windows", async () => {
    const f = fixture();
    expect(await f.backend.listWindows()).toHaveLength(1);
  });
  it("distinguishes a native admission refusal from an uncertain delivery", async () => {
    const f = fixture();
    f.refuse();
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "same_pid_keyboard_ambiguity",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
  });
  it("translates DOM key names without turning Delete into Backspace", async () => {
    const f = fixture();
    await f.backend.pressKey("Delete", "cua:10:20");
    await f.backend.hotkey(["meta", "arrowleft"], "cua:10:20");
    expect(f.calls.find((c) => c.name === "press_key")?.args).toMatchObject({
      key: "forward_delete",
    });
    expect(f.calls.find((c) => c.name === "hotkey")?.args).toMatchObject({
      keys: ["command", "left"],
    });
    expect(() => f.backend.hotkey(["meta", "a", "s"], "cua:10:20")).toThrow("exactly one");
  });
  it("converts pixel deltas to one bounded wheel operation", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    const result = await f.backend.scroll({ x: -275, y: 30 }, 0, 250, "cua:10:20");
    expect(result.scrollDelta).toEqual({ deltaX: 0, deltaY: 240 });
    expect(f.calls.filter((c) => c.name === "scroll")).toHaveLength(1);
    expect(f.calls.find((c) => c.name === "scroll")?.args).toMatchObject({
      amount: 2,
      by: "line",
      direction: "down",
    });
    await expect(
      f.backend.scroll({ x: -275, y: 30 }, 0, 240, "cua:10:20", ["meta"]),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    expect(f.calls.filter((c) => c.name === "scroll")).toHaveLength(1);
  });
  it("coalesces physical state across concurrent thread projections", async () => {
    const f = fixture();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        Promise.all([f.backend.availability(), f.backend.listWindows(), f.backend.getScreenSize()]),
      ),
    );
    expect(f.calls.map((c) => c.name)).toEqual([
      "check_permissions",
      "list_windows",
      "get_screen_size",
    ]);
  });
  it("does not replay identical text when native readback is unverifiable", async () => {
    const f = fixture();
    await f.backend.availability();
    await f.backend.focusWindow("cua:10:20");
    expect(await f.backend.typeText("abc")).toMatchObject({ verified: "unverifiable" });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
    expect(f.calls.find((c) => isTyping(c.name))?.args).toMatchObject({
      delivery_mode: "background",
      text: "abc",
      pid: 10,
      window_id: 20,
    });
  });
  it("preserves unknown dispatch on transport timeout without retry", async () => {
    const f = fixture();
    await f.backend.availability();
    f.fail(new CuaTransportError("timeout", "dispatched-unknown"));
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "dispatched-unknown",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
  });
  it("maps negative desktop coordinates using the captured geometry and scale", async () => {
    const f = fixture();
    await f.backend.availability();
    const image = await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    expect(image).toMatchObject({ width: 400, height: 200, scale: 2, region: { x: -300, y: 20 } });
    await f.backend.click({ x: -275, y: 30 }, "cua:10:20");
    expect(f.calls.find((c) => c.name === "click")?.args).toMatchObject({
      x: 50,
      y: 20,
      force_synthetic: true,
      expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
    });
  });
  it("refuses a moved or closed window without injecting", async () => {
    const f = fixture();
    await f.backend.availability();
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    f.move();
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_geometry",
    });
    f.close();
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_target",
    });
    expect(f.calls.filter((c) => c.name === "click" || isTyping(c.name))).toHaveLength(0);
  });
  it("refuses background drag before reaching Cua", async () => {
    const f = fixture();
    await expect(
      f.backend.drag({ x: 0, y: 0 }, { x: 10, y: 10 }, 500, "cua:10:20"),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "foreground_required" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("Computer authority", () => {
  it("restores archived admission without reviving work or an explicit user revocation", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    await manager.setControlEnabled("fixture", false);
    await manager.handleThreadRemoved("fixture");
    await manager.handleThreadRestored("fixture");
    await expect(manager.withAgentActivity("fixture", async () => undefined)).rejects.toThrow(
      "revoked",
    );
    await manager.setControlEnabled("fixture", true);
    await expect(manager.withAgentActivity("fixture", async () => "new call")).resolves.toBe(
      "new call",
    );
    await manager.dispose();
  });
  it("ignores an older turn ending after the same thread took a new lease", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    await manager.withAgentActivity(
      "fixture",
      () => manager.click("fixture", { x: 5, y: 5 }),
      undefined,
      "turn-new",
    );
    await manager.releaseDesktopControl("fixture", "turn-old");
    await expect(manager.click("other", { x: 5, y: 5 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
    });
    await manager.releaseDesktopControl("fixture", "turn-new");
    await expect(manager.click("other", { x: 5, y: 5 })).resolves.toBeDefined();
    await manager.dispose();
  });
  it("revokes queued admission and aborts the active operation", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.withAgentActivity("fixture", async () => {
      entered();
      await blocked;
      return "ended";
    });
    await ready;
    const work = vi.fn(async () => "input");
    const queued = manager.withAgentActivity("fixture", work);
    const rejected = expect(queued).rejects.toThrow("revoked");
    await manager.setControlEnabled("fixture", false);
    await manager.setControlEnabled("fixture", true);
    release();
    await first;
    await rejected;
    expect(work).not.toHaveBeenCalled();
    await expect(manager.withAgentActivity("fixture", work)).resolves.toBe("input");
    await manager.dispose();
  });
});
