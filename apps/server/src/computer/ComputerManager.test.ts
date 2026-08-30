import { describe, expect, it } from "vitest";

import type { ComputerWindow, ThreadComputerState } from "@synara/contracts";
import { decodeComputerFrame } from "@synara/shared/computerFrame";

import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  ComputerBackendError,
} from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import type { FrameSink } from "@synara/shared/frameTransport";

class RecordingSink implements FrameSink {
  readonly received: Uint8Array[] = [];
  open = true;

  send = (bytes: Uint8Array): void => {
    this.received.push(bytes);
  };
  bufferedAmount = (): number => 0;
  isOpen = (): boolean => this.open;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  return Promise.withResolvers<void>();
}

/**
 * A calculator buried under a full-screen browser: the live failure window
 * scoping exists for, where a bare coordinate click lands on the browser.
 */
function coveredCalculatorWindows(): readonly ComputerWindow[] {
  return [
    {
      id: "fake-browser",
      title: "Browser",
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      focused: true,
      minimized: false,
      visible: true,
      stackingIndex: 0,
      occludedBy: [],
    },
    {
      id: "fake-calculator",
      title: "Calculator",
      bounds: { x: 1_050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
      stackingIndex: 1,
      occludedBy: ["fake-browser"],
    },
  ];
}

const overlapping = (stacked: boolean): ComputerWindow[] => [
  {
    id: "under",
    title: "Under",
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    focused: false,
    minimized: false,
    visible: true,
    ...(stacked ? { stackingIndex: 1 } : {}),
  },
  {
    id: "over",
    title: "Over",
    bounds: { x: 300, y: 200, width: 400, height: 300 },
    focused: false,
    minimized: false,
    visible: true,
    ...(stacked ? { stackingIndex: 0 } : {}),
  },
];

describe("ComputerManager and FakeComputerBackend", () => {
  it("publishes thread snapshots, activity transitions, and backend window events", async () => {
    const backend = new FakeComputerBackend({ now: () => "2026-08-15T00:00:00.000Z" });
    const manager = new ComputerManager({ backend });
    const events: Array<{ type: string; state?: { agentActive: boolean } }> = [];
    manager.onEvent((event) => {
      events.push({
        type: event.type,
        ...("state" in event ? { state: { agentActive: event.state.agentActive } } : {}),
      });
    });

    const initial = await manager.getThreadState("thread-1");
    expect(initial.threadId).toBe("thread-1");
    expect(initial.version).toBe(0);
    // Seeding a panel is not a use of the desktop, so it costs the desktop
    // nothing: the passive probe answers whether the feature works, and the
    // window list stays empty until something really asks for the backend.
    expect(initial.windows).toEqual([]);
    expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);
    expect(initial.availability).toEqual({ kind: "available", backend: "fake" });

    const result = await manager.withAgentActivity("thread-1", async () => {
      const active = events.findLast((event) => event.type === "computer.thread-state");
      expect(active?.state?.agentActive).toBe(true);
      return await manager.click("thread-1", { label: "Calculate", role: "button" });
    });
    expect(result.point).toEqual({ x: 1_180, y: 228 });
    expect(
      events.filter((event) => event.type === "computer.thread-state").length,
    ).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)?.state?.agentActive).toBe(false);

    const newWindow = {
      id: "fake-notes",
      title: "Notes",
      appName: "org.kde.kwrite",
      bounds: { x: 200, y: 200, width: 500, height: 400 },
      focused: true,
      minimized: false,
      visible: true,
    };
    backend.emitWindowsChanged([newWindow]);
    await Promise.resolve();
    await Promise.resolve();
    const refreshed = await manager.getThreadState("thread-1");
    expect(refreshed.windows).toEqual([newWindow]);
    expect(events.some((event) => event.type === "computer.windows-changed")).toBe(true);

    await manager.dispose();
  });

  it("republishes every thread when backend health changes, without touching the backend", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    // Health only corrects the availability of a backend something has actually
    // asked for; before that there is nothing to be disconnected from.
    await manager.listWindows();
    const seeded = await Promise.all([
      manager.getThreadState("thread-a"),
      manager.getThreadState("thread-b"),
    ]);
    expect(seeded.map((state) => state.health.status)).toEqual(["connected", "connected"]);
    const callsBeforeHealth = backend.calls.length;

    backend.emitHealthChanged({
      status: "reconnecting",
      consecutiveFailures: 1,
      reconnects: 0,
      lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
      captureAvailable: false,
    });

    // A supervision event is answered from cache: asking the backend anything
    // here would put a round trip — and a connect attempt — on every failure.
    expect(backend.calls).toHaveLength(callsBeforeHealth);
    const degraded = ["thread-a", "thread-b"].map((threadId) =>
      states.findLast((state) => state.threadId === threadId),
    );
    expect(degraded.map((state) => state?.health.status)).toEqual(["reconnecting", "reconnecting"]);
    expect(degraded.map((state) => state?.availability.kind)).toEqual([
      "backend-unavailable",
      "backend-unavailable",
    ]);
    expect(degraded[0]?.availability).toMatchObject({
      message: expect.stringContaining("The backend vanished"),
    });
    // Panels drop stale snapshots by version, so a live change must move it.
    expect(degraded[0]?.version).toBeGreaterThan(seeded[0]!.version);

    backend.emitHealthChanged({
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 1,
      lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
      captureAvailable: true,
    });

    const recovered = await manager.getThreadState("thread-a");
    expect(recovered.availability).toEqual({ kind: "available", backend: "fake" });
    expect(recovered.health).toMatchObject({ status: "connected", reconnects: 1 });

    await manager.dispose();
  });

  it("answers getStatus without a thread, corrected by live health", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    const status = await manager.getStatus();
    expect(status.computerId).toBe("desktop");
    expect(status.availability).toEqual({ kind: "available", backend: "fake" });
    expect(status.health.status).toBe("connected");
    expect(status.capabilities.input).toBe(true);
    // No thread state was created as a side effect of asking, and merely
    // opening settings must not be the thing that establishes (and on a cold
    // backend: pre-engagement it is the probe.
    expect(backend.calls.map((call) => call.method)).not.toContain("getState");
    expect(backend.calls.map((call) => call.method)).toContain("probeAvailability");
    expect(backend.calls.map((call) => call.method)).not.toContain("availability");

    // Health corrections only apply once something real engaged the backend —
    // supervision cannot report on connections that were never made.
    await manager.listWindows();

    backend.emitHealthChanged({
      status: "reconnecting",
      consecutiveFailures: 2,
      reconnects: 1,
      lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
      captureAvailable: false,
    });
    const degraded = await manager.getStatus();
    expect(degraded.health.status).toBe("reconnecting");
    expect(degraded.availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("The backend vanished"),
    });

    await manager.dispose();
  });

  it("reports a failed availability probe as backend-unavailable instead of throwing", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    // Both reads degrade the same way: the pre-engagement probe and the
    // establishing read a live backend answers with.
    backend.failNext("probeAvailability", new Error("probe exploded"));
    const status = await manager.getStatus();
    expect(status.availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("probe exploded"),
    });

    await manager.listWindows();
    backend.failNext("availability", new Error("live read exploded"));
    const engaged = await manager.getStatus();
    expect(engaged.availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("live read exploded"),
    });

    await manager.dispose();
  });

  /**
   * `lastError` and availability messages are schema-bounded at 2048
   * characters, and both are composed from backend error text nothing here
   * controls. One oversized D-Bus diagnostic used to fail the encode of the
   * whole getThreadState payload — breaking thread-state pushes for that
   * thread until the message changed.
   */
  it("clamps an oversized backend error before it reaches a state payload", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    const oversized = "E".repeat(100_000);
    backend.failNext("probeAvailability", new Error(oversized));
    const state = await manager.getThreadState("thread-oversize");

    expect(state.lastError).toBeDefined();
    expect(state.lastError!.length).toBeLessThanOrEqual(2_048);
    // The availability verdict on the same payload is clamped the same way,
    // so encoding the state succeeds end to end.
    expect(state.availability.kind).toBe("backend-unavailable");
    if (state.availability.kind === "backend-unavailable") {
      expect(state.availability.message.length).toBeLessThanOrEqual(2_048);
    }

    await manager.dispose();
  });

  it("performs semantic writes only against a fresh, unambiguous snapshot", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    await expect(manager.setValue("thread-1", { label: "Display" }, "468")).resolves.toMatchObject({
      action: "computer_set_value",
      value: "468",
    });
    await expect(
      manager.performAction("thread-1", { label: "Calculate", role: "button" }, "activate"),
    ).resolves.toMatchObject({ action: "computer_perform_action", point: { x: 1_180, y: 228 } });

    await expect(manager.click("thread-1", { x: 1_920, y: 1_080 })).rejects.toMatchObject({
      code: "computer_target_offscreen",
    });
    await expect(manager.click("thread-1", { x: 10 })).rejects.toMatchObject({
      code: "computer_target_invalid",
    });

    // A bare window id is a real scroll target — the window itself, at its
    // own point — while for the semantic writes below a target that names no
    // control refuses up front with what is missing, instead of matching
    // every node in scope and dumping the whole tree as an ambiguity refusal.
    await expect(
      manager.scroll("thread-1", { windowId: "fake-calculator" }, 0, 300),
    ).resolves.toMatchObject({ action: "computer_scroll", point: { x: 1_260, y: 430 } });
    await expect(manager.setValue("thread-1", {}, "468")).rejects.toMatchObject({
      code: "computer_target_invalid",
    });
    await expect(manager.performAction("thread-1", {}, "activate")).rejects.toMatchObject({
      code: "computer_target_invalid",
    });

    await manager.dispose();
  });

  it("raises a target window before focusing it and scopes a coordinate click to it", async () => {
    const backend = new FakeComputerBackend({ windows: coveredCalculatorWindows() });
    const manager = new ComputerManager({ backend });

    await manager.click("thread-1", { label: "Calculate", role: "button" });
    expect(
      backend.calls
        .map((call) => call.method)
        .filter((method) => ["raiseWindow", "focusWindow", "click"].includes(method)),
    ).toEqual(["raiseWindow", "focusWindow", "click"]);
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    const perceptionCalls = backend.callsFor("getState").length;
    const scoped = await manager.click("thread-1", {
      x: 1_100,
      y: 200,
      windowId: "fake-calculator",
    });
    expect(scoped.point).toEqual({ x: 1_100, y: 200 });
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1_100, y: 200 });
    // The coordinate is authoritative, so no accessibility tree is read for it.
    expect(backend.callsFor("getState")).toHaveLength(perceptionCalls);

    // A coordinate that misses the window is refused rather than clicked
    // wherever it happens to land.
    await expect(
      manager.click("thread-1", { x: 40, y: 40, windowId: "fake-calculator" }),
    ).rejects.toMatchObject({ code: "computer_target_offscreen" });
    await expect(
      manager.click("thread-1", { x: 40, y: 40, windowId: "gone" }),
    ).rejects.toMatchObject({ code: "computer_target_not_found", notFound: true });

    await manager.dispose();
  });

  it("keeps window targeting working on a backend that cannot raise windows", async () => {
    const backend = new FakeComputerBackend();
    (backend as unknown as { raiseWindow?: undefined }).raiseWindow = undefined;
    const manager = new ComputerManager({ backend });

    await expect(
      manager.click("thread-1", { label: "Calculate", role: "button" }),
    ).resolves.toMatchObject({ point: { x: 1_180, y: 228 } });
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    await manager.dispose();
  });

  it("refuses a covered target the desktop cannot raise, and clicks it once it can", async () => {
    const backend = new FakeComputerBackend({ windows: coveredCalculatorWindows() });
    (backend as unknown as { raiseWindow?: undefined }).raiseWindow = undefined;
    const manager = new ComputerManager({ backend });

    const covered = manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-calculator" });
    await expect(covered).rejects.toMatchObject({ code: "computer_target_occluded" });
    // The refusal has to name what is in the way, or the model has nothing to
    // act on but a retry.
    await expect(covered).rejects.toThrow(/Browser/);
    // Nothing was injected: the point of refusing is that no click lands in the
    // covering window.
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("focusWindow")).toHaveLength(0);

    // A label target resolves to the same buried window and is refused too.
    await expect(
      manager.click("thread-1", { label: "Calculate", role: "button" }),
    ).rejects.toMatchObject({ code: "computer_target_occluded" });

    // A point the covering window does not contain is safe to click without a
    // raise, so it goes through.
    await expect(
      manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-browser" }),
    ).resolves.toMatchObject({ point: { x: 1_100, y: 200 }, windowId: "fake-browser" });

    await manager.dispose();
  });

  it("refuses a covered target when the raise itself fails", async () => {
    const backend = new FakeComputerBackend({ windows: coveredCalculatorWindows() });
    const manager = new ComputerManager({ backend });
    backend.failNext("raiseWindow", new Error("plugin has no raiseWindow"));

    await expect(
      manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-calculator" }),
    ).rejects.toThrow(/plugin has no raiseWindow/);
    expect(backend.callsFor("click")).toHaveLength(0);

    // The next call raises normally and is not held against the target.
    await expect(
      manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-calculator" }),
    ).resolves.toMatchObject({ point: { x: 1_100, y: 200 }, windowId: "fake-calculator" });

    await manager.dispose();
  });

  it("routes keyboard input to a named window and leaves focus alone without one", async () => {
    const backend = new FakeComputerBackend({ windows: coveredCalculatorWindows() });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    await expect(manager.typeText("thread-1", "12", "fake-calculator")).resolves.toMatchObject({
      action: "computer_type_text",
      windowId: "fake-calculator",
    });
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    await expect(manager.pressKey("thread-1", "enter", "fake-browser")).resolves.toMatchObject({
      windowId: "fake-browser",
    });
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-browser"]);
    await expect(manager.hotkey("thread-1", ["ctrl", "t"], "fake-browser")).resolves.toMatchObject({
      windowId: "fake-browser",
    });

    // Without a window the keystroke follows whatever focus the last action
    // left, which is what click-then-type depends on: focus is never cleared.
    const focusCalls = backend.callsFor("focusWindow").length;
    await expect(manager.typeText("thread-1", "9")).resolves.not.toHaveProperty("windowId");
    expect(backend.callsFor("focusWindow")).toHaveLength(focusCalls);
    expect(backend.callsFor("clearFocusWindow")).toHaveLength(0);

    // A stale id fails before any key is sent rather than typing into whatever
    // holds focus instead.
    const typeCalls = backend.callsFor("typeText").length;
    await expect(manager.typeText("thread-1", "9", "gone")).rejects.toMatchObject({
      code: "computer_target_not_found",
      notFound: true,
    });
    expect(backend.callsFor("typeText")).toHaveLength(typeCalls);

    await manager.dispose();
  });

  it("explains a scoped injection the desktop refused, and passes other failures through", async () => {
    const backend = new FakeComputerBackend({ windows: coveredCalculatorWindows() });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // A refusal means nothing was delivered, so the caller has to be told that
    // and told what to change; the compositor only names the call it declined.
    backend.failNext(
      "click",
      new ComputerBackendError("The computer backend rejected pressButton.", {
        retryable: true,
        rejectedOperation: "pressButton",
      }),
    );
    const refused = manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-calculator" });
    await expect(refused).rejects.toMatchObject({ code: "computer_target_refused" });
    await expect(refused).rejects.toThrow(/no input was sent/);
    await expect(refused).rejects.toThrow(/label instead of a coordinate/);

    // An unscoped action has no window to blame, so its error is left alone.
    backend.failNext(
      "click",
      new ComputerBackendError("The computer backend rejected pressButton.", {
        rejectedOperation: "pressButton",
      }),
    );
    await expect(manager.click("thread-1", { x: 1_100, y: 200 })).rejects.toThrow(
      /computer backend rejected pressButton/,
    );

    // A fault is not a refusal: rewriting it would claim an injection never
    // happened when it may well have.
    backend.failNext("click", new ComputerBackendError("session bus disconnected"));
    await expect(
      manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-calculator" }),
    ).rejects.toThrow(/session bus disconnected/);

    await manager.dispose();
  });

  it("attributes every action event to the thread that drove it", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const actions: Array<{ action: string; threadId?: string }> = [];
    manager.onEvent((event) => {
      if (event.type !== "computer.action") return;
      actions.push({
        action: event.action,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      });
    });

    await manager.launchApp("thread-1", "kcalc");
    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.doubleClick("thread-1", { x: 10, y: 10 });
    await manager.rightClick("thread-1", { x: 10, y: 10 });
    await manager.moveCursor("thread-1", { x: 10, y: 10 });
    await manager.drag("thread-1", { x: 10, y: 10 }, { x: 20, y: 20 });
    await manager.scroll("thread-1", null, 0, 12);
    await manager.typeText("thread-1", "hi");
    await manager.pressKey("thread-1", "enter");
    await manager.hotkey("thread-1", ["ctrl", "s"]);
    await manager.writeClipboard("thread-1", "clip");
    await manager.readClipboard("thread-1");
    await manager.setValue("thread-1", { label: "Display" }, "12");
    await manager.performAction("thread-1", { label: "Calculate", role: "button" }, "activate");

    expect(actions).toEqual([
      { action: "computer_launch_app", threadId: "thread-1" },
      { action: "computer_click", threadId: "thread-1" },
      { action: "computer_double_click", threadId: "thread-1" },
      { action: "computer_right_click", threadId: "thread-1" },
      { action: "computer_move_cursor", threadId: "thread-1" },
      { action: "computer_drag", threadId: "thread-1" },
      { action: "computer_scroll", threadId: "thread-1" },
      { action: "computer_type_text", threadId: "thread-1" },
      { action: "computer_press_key", threadId: "thread-1" },
      { action: "computer_hotkey", threadId: "thread-1" },
      { action: "computer_write_clipboard", threadId: "thread-1" },
      { action: "computer_read_clipboard", threadId: "thread-1" },
      { action: "computer_set_value", threadId: "thread-1" },
      { action: "computer_perform_action", threadId: "thread-1" },
    ]);

    await manager.dispose();
  });

  it("carries clipboard text on the shared action result, and refuses it without backend support", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    await manager.writeClipboard("thread-1", "shared text");
    await expect(manager.readClipboard("thread-1")).resolves.toMatchObject({
      action: "computer_read_clipboard",
      value: "shared text",
    });

    // Reads are bounded by the contract limit on `value`; writes are not, so a
    // large paste is fine but cannot come back through the result field.
    await manager.writeClipboard("thread-1", "x".repeat(16 * 1024 + 1));
    await expect(manager.readClipboard("thread-1")).rejects.toThrow(/more than the 16384/);

    const withoutClipboard = new ComputerManager({
      backend: new Proxy(new FakeComputerBackend(), {
        get: (target, property, receiver) =>
          property === "readClipboard" || property === "writeClipboard"
            ? undefined
            : Reflect.get(target, property, receiver),
      }),
    });
    await expect(withoutClipboard.readClipboard("thread-1")).rejects.toThrow(
      /does not support clipboard access/,
    );
    await expect(withoutClipboard.writeClipboard("thread-1", "nope")).rejects.toThrow(
      /does not support clipboard access/,
    );

    await manager.dispose();
    await withoutClipboard.dispose();
  });

  it("tells the backend which thread is driving, so the agent cursor can name it", async () => {
    const backend = new FakeComputerBackend();
    const names: Array<string | null> = [];
    const drivable = Object.assign(backend, {
      setDrivingAgent: async (name: string | null) => {
        names.push(name);
      },
    });
    const manager = new ComputerManager({ backend: drivable });

    // Pane input belongs to the human, who is not an agent and takes no lease.
    await manager.click(undefined, { x: 10, y: 10 });
    expect(names).toEqual([]);

    manager.setThreadLabel("thread-1", "Luna");
    await manager.click("thread-1", { x: 10, y: 10 });
    expect(names).toEqual(["Luna"]);

    // A rename while this thread is on screen reaches the badge immediately.
    manager.setThreadLabel("thread-1", "Luna · seat fix");
    expect(names).toEqual(["Luna", "Luna · seat fix"]);

    // A thread the tool layer never named still takes the desktop; the plugin
    // falls back to a generic label rather than showing a thread id.
    await manager.releaseDesktopControl("thread-1");
    await manager.click("thread-2", { x: 10, y: 10 });
    expect(names).toEqual(["Luna", "Luna · seat fix", null, null]);

    // Labelling a thread that is not driving records it without touching the
    // badge the human is currently looking at.
    manager.setThreadLabel("thread-1", "Luna again");
    expect(names).toHaveLength(4);

    await manager.dispose();
  });

  it("asks the UI to open the pane once per thread, and only for agent actions", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const openRequests: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.open-pane-requested") openRequests.push(event.threadId);
    });

    // Pane input carries no thread and must never summon the pane.
    await manager.click(undefined, { x: 10, y: 10 });
    expect(openRequests).toEqual([]);

    // The first attributed action surfaces the pane; the rest of the turn is
    // silent so a user who closed the pane is not yanked back per click.
    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.typeText("thread-1", "hi");
    expect(openRequests).toEqual(["thread-1"]);

    // A second thread surfaces independently of the first.
    await manager.releaseDesktopControl("thread-1");
    await manager.pressKey("thread-2", "enter");
    expect(openRequests).toEqual(["thread-1", "thread-2"]);

    // Removal clears the once-per-thread latch with the rest of thread state.
    await manager.handleThreadRemoved("thread-2");
    await manager.pressKey("thread-2", "enter");
    expect(openRequests).toEqual(["thread-1", "thread-2", "thread-2"]);

    await manager.dispose();
  });

  it("never asks for the pane when the agent drives the human's visible desktop", async () => {
    // Every action is already happening on the screen the user is looking at,
    // so pushing a preview of their own display open would only be noise.
    const backend = new FakeComputerBackend({
      capabilities: { ...new FakeComputerBackend().capabilities(), visibleDesktop: true },
    });
    const manager = new ComputerManager({ backend });
    const openRequests: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.open-pane-requested") openRequests.push(event.threadId);
    });

    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.typeText("thread-1", "hi");

    expect(openRequests).toEqual([]);
    await manager.dispose();
  });

  it("leaves pane input unattributed instead of borrowing a thread", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const actions: Array<Record<string, unknown>> = [];
    manager.onEvent((event) => {
      if (event.type === "computer.action") actions.push({ ...event });
    });

    await manager.click(undefined, { x: 10, y: 10 });
    await manager.launchApp(undefined, "kcalc");
    // A whitespace-only caller is not a thread either.
    await manager.pressKey("  ", "enter");

    expect(actions.every((action) => !("threadId" in action))).toBe(true);
    expect(actions).toHaveLength(3);

    await manager.dispose();
  });

  it("gives the desktop to the first thread that drives it and refuses the second", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.click("thread-a", { x: 10, y: 10 });
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
      retryable: true,
      message: expect.stringMatching(/another conversation; try again when it is free/),
    });

    // Watching is safe while someone else drives, so nothing read-only is gated
    // — including the blocked thread's own state.
    await expect(manager.listWindows()).resolves.toMatchObject({ computerId: backend.computerId });
    await expect(manager.getState({})).resolves.toMatchObject({ computerId: backend.computerId });
    await expect(manager.getScreenSize()).resolves.toMatchObject({
      computerId: backend.computerId,
    });
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });
    await expect(manager.getThreadState("thread-a")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    // The human at the pane is not a competing agent: their input carries no
    // thread, and it neither waits for the lease nor takes it.
    await expect(manager.click(undefined, { x: 30, y: 30 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
    });

    // Both panels learned about the handover without polling.
    expect(
      states.some((state) => state.threadId === "thread-b" && state.controlledByOtherThread),
    ).toBe(true);
    expect(states.findLast((state) => state.threadId === "thread-a")?.controlledByOtherThread).toBe(
      false,
    );

    await manager.dispose();
  });

  it("hands the desktop to the next thread when the owner's turn ends", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.launchApp("thread-a", "kcalc");
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);

    // What the lease reactor calls on turn.completed / turn.aborted /
    // session.exited.
    await manager.releaseDesktopControl("thread-a");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    // A's next turn now waits on B, and a release from a thread that no longer
    // owns the desktop cannot take it away from B.
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );
    await manager.releaseDesktopControl("thread-a");
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );
    await expect(manager.getThreadState("thread-a")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    // Removing the owning thread frees the desktop the same way.
    await manager.handleThreadRemoved("thread-b");
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  /**
   * The release the lease reactor sends on session.exited can land while the
   * dead session's last call is still executing — a gateway call cannot be
   * aborted. Handing the desktop over at that moment would put two threads on
   * the same pointer, so the release waits for the call to drain.
   */
  it("defers a release until the owner's in-flight call drains", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await finish.promise;
    });
    await started.promise;

    await manager.releaseDesktopControl("thread-a");
    // Still A's desktop: the release is recorded, not applied.
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    finish.resolve();
    await inFlight;
    // The drain completed the release, and told every thread so.
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });
    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );

    await manager.dispose();
  });

  it("keeps a deferred release when the owner renews the lease mid-drain", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const started = deferred();
    const releaseRecorded = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await releaseRecorded.promise;
      // The dead session's operation keeps acting after the release was
      // recorded. Renewing the lease must not forget that release.
      await manager.click("thread-a", { x: 11, y: 11 });
    });
    await started.promise;
    await manager.releaseDesktopControl("thread-a");
    releaseRecorded.resolve();
    await inFlight;

    expect(backend.callsFor("click")).toHaveLength(2);
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });
    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });

    await manager.dispose();
  });

  it("reacquires the lease for a new turn after the previous operation drains", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");

    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await manager.releaseDesktopControl("thread-a");
    // The next turn waits for the old operation, then takes a fresh lease.
    const nextTurn = manager.click("thread-a", { x: 20, y: 20 });
    expect(backend.callsFor("click")).toHaveLength(1);
    finish.resolve();
    await inFlight;
    await nextTurn;

    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    await manager.dispose();
  });

  it("expires an idle lease as a backstop, but never one whose owner is still acting", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({ backend, now: () => nowMs, leaseIdleMs: 1_000 });
    await manager.getThreadState("thread-a");

    await manager.click("thread-a", { x: 10, y: 10 });
    nowMs = 999;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );

    // An owner that is mid-call still holds the pointer, however long ago the
    // call started — the crash this backstop exists for leaves nothing running.
    nowMs = 10_000;
    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );
    finish.resolve();
    await inFlight;

    await expect(manager.click("thread-b", { x: 20, y: 20 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );

    await manager.dispose();
  });

  /**
   * The same backstop, on the backend that ships: a visible desktop surfaces no
   * pane, so nothing ever created a runtime record for an agent thread, and the
   * in-flight guard read zero from a thread that was mid-drag. The desktop could
   * then be taken from under it by another conversation.
   */
  it("counts an agent's in-flight call even when no panel ever asked about it", async () => {
    const backend = new FakeComputerBackend({
      capabilities: { ...new FakeComputerBackend().capabilities(), visibleDesktop: true },
    });
    let nowMs = 0;
    const manager = new ComputerManager({ backend, now: () => nowMs, leaseIdleMs: 1_000 });

    const started = deferred();
    const finish = deferred();
    // Nothing here asks for thread state: this is a thread whose only contact
    // with the manager is the tool calls it makes.
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await finish.promise;
    });
    await started.promise;

    nowMs = 10_000;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );

    finish.resolve();
    await inFlight;
    // Once the call really has finished, the idle lease is up for grabs again.
    await expect(manager.click("thread-b", { x: 20, y: 20 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  /**
   * Every publish reads the window list, and every window read can report a
   * change, so one change used to schedule a pass whose own reads scheduled the
   * next — multiplied by thread count, on a desktop where nothing more than a
   * clock title was moving.
   */
  it("coalesces a burst of window changes into a single publish pass", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, windowsPublishDebounceMs: 5 });
    // The churn this coalesces comes from a live backend, which by definition
    // something has already used. Engaging before either thread exists keeps the
    // republish that engagement triggers out of the count below.
    await manager.listWindows();
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const publishes: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") publishes.push(event.state.threadId);
    });
    const readsBefore = backend.callsFor("listWindows").length;

    for (let index = 0; index < 20; index += 1) {
      backend.emitWindowsChanged([
        {
          id: "clock",
          title: `Clock — 12:00:${index}`,
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          focused: false,
          minimized: false,
          visible: true,
        },
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    // One pass, one thread state each, one window read each — not twenty.
    expect(publishes).toEqual(["thread-a", "thread-b"]);
    expect(backend.callsFor("listWindows").length - readsBefore).toBe(2);

    await manager.dispose();
  });

  it("lets one thread keep driving across a long think, and keeps perception free", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({ backend, now: () => nowMs, leaseIdleMs: 1_000 });

    await manager.click("thread-a", { x: 10, y: 10 });
    // Nobody else asked for the desktop while the model thought, so the owner
    // simply picks it back up: expiry is a chance for others, not a revocation.
    nowMs = 60_000;
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });
    // Perception from another thread neither takes the lease nor renews it.
    await manager.getState({});
    await manager.listWindows();
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  it("runs the synthetic frame attach, publish, and detach loop", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const sink = new RecordingSink();
    const eventTypes: string[] = [];
    manager.onEvent((event) => eventTypes.push(event.type));
    const unsubscribe = manager.subscribeFrames(sink);
    await manager.flushStreamTransitions();

    expect(backend.callsFor("attachStream")).toHaveLength(1);
    expect(sink.received).toHaveLength(2);
    expect(decodeComputerFrame(sink.received[0]!).ok).toBe(true);
    backend.emitFrame(false, false, Uint8Array.of(7, 8));
    expect(sink.received).toHaveLength(3);

    unsubscribe();
    await manager.flushStreamTransitions();
    expect(backend.callsFor("detachStream")).toHaveLength(1);
    const count = sink.received.length;
    backend.emitFrame(true, false);
    expect(sink.received).toHaveLength(count);

    // Frames ride the binary transport alone. The JSON event channel used to
    // carry a `computer.frame` header beside every one of them, which its only
    // consumer read and dropped.
    expect(eventTypes).not.toContain("computer.frame");

    await manager.dispose();
  });

  it("drops late frames and state updates after a thread is removed", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const sink = new RecordingSink();
    const unsubscribe = manager.subscribeFrames(sink);
    await manager.flushStreamTransitions();
    await manager.getThreadState("thread-removed");
    await manager.handleThreadRemoved("thread-removed");

    backend.emitFrame(false, false, Uint8Array.of(9));
    await manager.withAgentActivity("thread-removed", async () => undefined);
    await manager.recordThreadError("thread-removed", "late error");

    const threads = (manager as unknown as { threads: Map<string, unknown> }).threads;
    expect(threads.has("thread-removed")).toBe(false);

    unsubscribe();
    await manager.dispose();
  });

  it("does not reattach a stream after disposal wins during keyframe recovery", async () => {
    const backend = new FakeComputerBackend();
    const detachStarted = deferred();
    const allowDetach = deferred();
    const detachStream = backend.detachStream.bind(backend);
    (backend as unknown as { requestKeyframe?: undefined }).requestKeyframe = undefined;
    backend.detachStream = async () => {
      detachStarted.resolve();
      await allowDetach.promise;
      await detachStream();
    };
    const manager = new ComputerManager({ backend });
    const unsubscribe = manager.subscribeFrames(new RecordingSink());
    await manager.flushStreamTransitions();

    const request = manager.requestKeyframe();
    await detachStarted.promise;
    const disposal = manager.dispose();
    allowDetach.resolve();
    await Promise.all([request, disposal]);

    expect(backend.callsFor("attachStream")).toHaveLength(1);
    expect(backend.callsFor("detachStream")).toHaveLength(1);
    unsubscribe();
  });

  it("carries the backend's capabilities onto every thread snapshot", async () => {
    // The panel decides which controls to offer from this field alone, so a
    // backend that cannot report geometry has to say so in the snapshot rather
    // than let the panel offer window-scoped actions that will be refused.
    const backend = new FakeComputerBackend({
      capabilities: {
        windows: true,
        windowBounds: false,
        stacking: false,
        capture: true,
        input: true,
        clipboard: false,
        activation: false,
        ghostCursor: false,
        visibleDesktop: false,
      },
    });
    const manager = new ComputerManager({ backend });

    const state = await manager.getThreadState("thread-1");

    expect(state.capabilities).toEqual(backend.capabilities());
    await manager.dispose();
  });

  it("refuses a window-scoped click when the desktop reports no geometry", async () => {
    // Passing window_id is a request for a guarantee — that the point lands in
    // that window. Without bounds nothing can check it, and clicking anyway
    // would drop the guarantee silently instead of telling the agent to drop
    // the scope or target by label.
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "boundless",
          title: "Calculator",
          appName: "org.kde.kcalc",
          focused: true,
          minimized: false,
          visible: true,
        },
      ],
    });
    const manager = new ComputerManager({ backend });

    await expect(
      manager.click("thread-1", { x: 100, y: 100, windowId: "boundless" }),
    ).rejects.toMatchObject({ code: "computer_target_offscreen" });
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("returns perception payloads with optional text and screenshot", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const state = await manager.getState({ includeScreenshot: true, includeText: true });

    expect(state.screenshot?.mimeType).toBe("image/png");
    expect(state.screenshot?.bytesBase64.length).toBeGreaterThan(0);
    expect(state.text).toContain("Calculate");
    expect(state.root?.children.length).toBeGreaterThan(0);

    await manager.dispose();
  });

  it("captures the focused window, and the workspace when nothing capturable has focus", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const focused = await manager.captureFocusedWindow();
    expect(focused.windowId).toBe("fake-terminal");
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
    });

    // A minimized focus holder and an unfocused rest leave nothing with focus
    // on screen except the calculator, the topmost visible window.
    backend.emitWindowsChanged([
      {
        id: "fake-terminal",
        title: "Terminal",
        bounds: { x: 40, y: 40, width: 960, height: 720 },
        focused: true,
        minimized: true,
        visible: false,
        stackingIndex: 1,
      },
      {
        id: "fake-calculator",
        title: "Calculator",
        bounds: { x: 1_050, y: 120, width: 420, height: 620 },
        focused: false,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
    ]);
    const topmost = await manager.captureFocusedWindow();
    expect(topmost.windowId).toBe("fake-calculator");

    // With no capturable window at all, the whole workspace is the answer.
    backend.emitWindowsChanged([]);
    const workspace = await manager.captureFocusedWindow(1_024);
    expect(workspace.windowId).toBeUndefined();
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 0, y: 0, width: 1_920, height: 1_080 },
      maxDimension: 1_024,
    });

    await manager.dispose();
  });

  it("captures the action's window on a hint, reports a vanished target, and never throws", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const hinted = await manager.captureActionScreenshot("fake-calculator");
    expect(hinted !== undefined && "windowId" in hinted ? hinted.windowId : undefined).toBe(
      "fake-calculator",
    );

    // A hint naming a window the action closed is a result in its own right,
    // never a substitute capture of whatever holds focus — on a live desktop
    // the focused window is the human's once the agent's target is gone.
    const closed = await manager.captureActionScreenshot("gone-window");
    expect(closed).toEqual({ targetWindowClosed: true });

    // A transient capture failure on a window that still exists yields no
    // screenshot, not a picture of some other window.
    backend.failNext("captureScreenshot");
    expect(await manager.captureActionScreenshot("fake-calculator")).toBeUndefined();

    // A capture failure returns nothing rather than failing the finished action.
    backend.failNext("captureScreenshot");
    expect(await manager.captureActionScreenshot()).toBeUndefined();

    await manager.dispose();
  });

  it("observes only the agent's focus target after an untargeted action, never the active window", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // No window holds the agent's focus; the human's browser is active and
    // topmost. Action observation must widen to the workspace rather than
    // zoom into the human's window.
    backend.emitWindowsChanged([
      {
        id: "human-browser",
        title: "Browser",
        bounds: { x: 100, y: 100, width: 1_200, height: 800 },
        focused: false,
        active: true,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
    ]);
    const observed = await manager.captureActionScreenshot();
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      undefined,
    );
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toMatchObject({
      kind: "region",
    });

    // The perception path keeps its wider fallback: an explicit untargeted
    // screenshot request may still show the active window.
    const perception = await manager.captureFocusedWindow();
    expect(perception.windowId).toBe("human-browser");

    await manager.dispose();
  });

  it("photographs the window under an untargeted action's point instead of the workspace", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // The scroll-hunting run this fixes: an unscoped pointer action cleared
    // the agent's explicit target, and the old fallback answered with a
    // workspace-wide downscale too small to read. The action's own
    // coordinates name the window it touched, so that window is the picture.
    const observed = await manager.captureActionScreenshot(undefined, { x: 1_100, y: 200 });
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      "fake-calculator",
    );
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });

    // A point over bare desktop identifies no window; the agent-focus step
    // still answers (the fake terminal holds the agent's focus by default).
    const desktop = await manager.captureActionScreenshot(undefined, { x: 1_800, y: 1_000 });
    expect(desktop !== undefined && "windowId" in desktop ? desktop.windowId : undefined).toBe(
      "fake-terminal",
    );

    await manager.dispose();
  });

  it("resolves overlapping point candidates by stacking order and refuses to guess without one", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    backend.emitWindowsChanged(overlapping(true));
    const observed = await manager.captureActionScreenshot(undefined, { x: 400, y: 300 });
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      "over",
    );

    // The same overlap with no stacking order: a guess could photograph a
    // window the action never touched, so the workspace fallback answers.
    backend.emitWindowsChanged(overlapping(false));
    const widened = await manager.captureActionScreenshot(undefined, { x: 400, y: 300 });
    expect(widened !== undefined && "windowId" in widened ? widened.windowId : undefined).toBe(
      undefined,
    );
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toMatchObject({
      kind: "region",
    });

    await manager.dispose();
  });

  it("falls back to the focus path when the point window vanishes before its capture", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // The point resolved to the calculator, but its capture fails — the
    // window closed in the race. The caller never named it, so the answer is
    // the ordinary focus fallback, not targetWindowClosed and not an error.
    backend.failNext("captureScreenshot");
    const observed = await manager.captureActionScreenshot(undefined, { x: 1_100, y: 200 });
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      "fake-terminal",
    );

    await manager.dispose();
  });

  it("skips the post-action capture entirely on a backend that cannot capture", async () => {
    const backend = new FakeComputerBackend({
      capabilities: {
        ...new FakeComputerBackend().capabilities(),
        capture: false,
      },
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    expect(await manager.captureActionScreenshot("fake-terminal")).toBeUndefined();
    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);

    await manager.dispose();
  });

  /**
   * The first backend call establishes the backend.
   * Panels are seeded for every chat the web app renders, so the seeding path
   * must stay passive, and the first real use is what pays.
   */
  it("seeds panels from the passive probe, and goes live from the first real use", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });

    const seeded = await manager.getThreadState("thread-1");
    expect(seeded.availability).toEqual({ kind: "available", backend: "fake" });
    expect(seeded.windows).toEqual([]);
    expect(seeded.screenSize).toEqual({ width: 1, height: 1 });
    expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);

    // The panel is asked again and again while the chat is open; none of that
    // reaches the desktop either.
    await manager.getThreadState("thread-1");
    await manager.getThreadState("thread-2");
    expect(backend.calls.map((call) => call.method)).toEqual([
      "probeAvailability",
      "probeAvailability",
      "probeAvailability",
    ]);

    // One agent tool call, and every panel gets the real desktop.
    await manager.withAgentActivity("thread-1", () => manager.listWindows());
    const live = await manager.getThreadState("thread-1");
    expect(live.windows.map((window) => window.title)).toEqual(["Terminal", "Calculator"]);
    expect(live.screenSize).toEqual({ width: 1_920, height: 1_080, scale: 1 });
    expect(backend.callsFor("availability").length).toBeGreaterThan(0);
    // The engagement republish reaches the thread nobody acted in, too.
    expect(states.findLast((state) => state.threadId === "thread-2")?.windows).toHaveLength(2);

    await manager.dispose();
  });

  it("engages the backend when the pane attaches or the human drives it", async () => {
    const paneBackend = new FakeComputerBackend();
    const paneManager = new ComputerManager({ backend: paneBackend });
    const sink = new RecordingSink();
    const detach = paneManager.subscribeFrames(sink);
    await paneManager.flushStreamTransitions();
    expect(paneBackend.callsFor("attachStream")).toHaveLength(1);
    expect((await paneManager.getThreadState("thread-pane")).windows).toHaveLength(2);
    detach();
    await paneManager.dispose();

    // Pane input carries no thread and takes no lease, and is still the human
    // asking this backend to drive their desktop.
    const inputBackend = new FakeComputerBackend();
    const inputManager = new ComputerManager({ backend: inputBackend });
    await inputManager.click(undefined, { x: 10, y: 10 });
    expect((await inputManager.getThreadState("thread-pane")).windows).toHaveLength(2);
    await inputManager.dispose();
  });

  /**
   * Image tokens scale with pixel area, and a mutating action attaches a shot
   * every time, so the observation spends a quarter of the perception budget.
   * The mapping metadata is what keeps that free: the agent converts pixels to
   * desktop coordinates through region and scale either way.
   */
  it("downscales large action observations while keeping the coordinate mapping exact", async () => {
    const tall = COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION + 1_000;
    const backend = new FakeComputerBackend({
      screenSize: { width: 3_000, height: tall + 400, scale: 1 },
      windows: [
        {
          id: "fake-editor",
          title: "Editor",
          bounds: { x: 100, y: 100, width: 1_280, height: tall },
          focused: true,
          minimized: false,
          visible: true,
        },
      ],
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const observed = await manager.captureActionScreenshot("fake-editor");
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-editor",
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });
    if (observed === undefined || !("screenshot" in observed)) {
      throw new Error("the action observation carried no screenshot");
    }
    const { region, scale, width, height } = observed.screenshot;
    // A window taller than the budget scales down to it, and the region still
    // names the window's own rect, so screenshot (x, y) maps back exactly.
    expect(scale).toBeCloseTo(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION / tall, 10);
    expect(region).toEqual({ x: 100, y: 100, width: 1_280, height: tall });
    // The middle of the image is still the middle of the window: region.x +
    // screenshot_x / scale, the mapping every computer tool describes.
    if (region === undefined || scale === undefined) throw new Error("no coordinate mapping");
    expect(region.x + width / 2 / scale).toBeCloseTo(region.x + region.width / 2, 0);
    expect(region.y + height / 2 / scale).toBeCloseTo(region.y + region.height / 2, 0);

    // Perception keeps the full budget: zooming back in is how the agent reads
    // detail the observation lost.
    await manager.captureFocusedWindow();
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-editor",
    });

    await manager.dispose();
  });

  it("returns every capture for the gateway to compare with delivered screenshots", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      const first = await manager.captureActionScreenshot("fake-terminal");
      const second = await manager.captureActionScreenshot("fake-terminal");
      expect(first).toHaveProperty("screenshot");
      expect(second).toEqual(first);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(2);
    } finally {
      await manager.dispose();
    }
  });

  /**
   * A manager whose travel measurement is scripted, so the tests exercise the
   * closed loop rather than the correlator (which has its own unit tests). Each
   * queued screenshot makes one capture's bytes differ from the last, because
   * byte-identical captures short-circuit to "did not move" before measuring.
   */
  function calibratedScrollFixture(
    travels: readonly (number | undefined)[],
    backend = new FakeComputerBackend(),
  ) {
    const measured: number[] = [];
    const manager = new ComputerManager({
      backend,
      actionSettleMs: 0,
      measureScrollTravel: () => travels[measured.push(0) - 1],
    });
    backend.queueScreenshots(Array.from({ length: 12 }, (_unused, index) => `capture-${index}`));
    return { backend, manager, measurements: measured };
  }

  it("probes an unmeasured window, then delivers the remainder pre-corrected", async () => {
    // A GTK-hosted browser gears a pixel delta up by ~7x, and nothing in the
    // protocol says so. Sending the whole request first would travel beyond
    // what the correlator can measure, so the first large scroll goes out as a
    // 48px probe (which travels 336 at 7x — measurable), and the remainder —
    // the request minus what the probe already covered — is divided by the
    // gearing the probe just taught. The first scroll lands on target.
    const { backend, manager } = calibratedScrollFixture([336, 64, 400]);

    const first = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(first.result.scroll).toEqual({
      requested: { deltaX: 0, deltaY: 400 },
      // Reported to two decimals; the backend gets the unrounded deltas.
      injected: { deltaX: 0, deltaY: 57.14 },
      traveledY: 400,
      gearing: 7,
    });
    const legs = backend.callsFor("scroll").map((entry) => entry.args[2]);
    expect(legs[0]).toBe(48);
    expect(legs[1]).toBeCloseTo(64 / 7, 6);
    expect(first.observation !== undefined && "screenshot" in first.observation).toBe(true);

    // A measured window is trusted in one delivery: no probe, one injection.
    const second = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(second.result.scroll?.injected.deltaY).toBe(57.14);
    expect(second.result.scroll?.traveledY).toBe(400);
    expect(second.result.scroll?.gearing).toBe(7);
    expect(backend.callsFor("scroll")).toHaveLength(3);
    expect(backend.callsFor("scroll").at(-1)?.args[2]).toBeCloseTo(400 / 7, 6);

    await manager.dispose();
  });

  it("falls back to the full request when the probe cannot be measured", async () => {
    const { backend, manager } = calibratedScrollFixture([undefined, undefined]);

    const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });

    // The unmeasured probe deducts only its own request: 48 went out, so the
    // remaining 352 follows at gearing 1, and the client got the 400 it would
    // have gotten without the probe.
    expect(result.result.scroll?.injected).toEqual({ deltaX: 0, deltaY: 400 });
    expect(result.result.scroll?.traveledY).toBeUndefined();
    expect(result.result.scroll?.gearing).toBe(1);
    expect(backend.callsFor("scroll").map((entry) => entry.args[2])).toEqual([48, 352]);

    await manager.dispose();
  });

  it("still identifies the window for an untargeted scroll after the clear", async () => {
    // Preparing an untargeted action clears the pinned focus, and the focus
    // fallback used to be read only afterwards — so a bare delta scroll could
    // never name its window, observed an unreadable workspace downscale, and
    // calibrated nothing. The cursor the thread last drove to fills the gap.
    const { backend, manager } = calibratedScrollFixture([336, 64]);

    await manager.click("thread-1", { x: 1_100, y: 200 });
    const result = await manager.scrollCalibrated("thread-1", null, 0, 400, { observe: true });

    // The focus really was cleared; the window came from the cursor position.
    expect(backend.callsFor("clearFocusWindow").length).toBeGreaterThan(0);
    expect(result.result.scroll?.gearing).toBe(7);
    expect(result.result.scroll?.traveledY).toBe(400);
    expect(result.observation !== undefined && "screenshot" in result.observation).toBe(true);

    await manager.dispose();
  });

  it("converts measured travel out of capture pixels before reporting or learning it", async () => {
    // A window wider than the observation budget is captured downscaled, so the
    // correlator's answer is in capture pixels and means less travel than it
    // says. Reporting it unconverted would teach the store a gearing that is
    // really the zoom factor.
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "fake-browser",
          title: "Browser",
          bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
          focused: true,
          minimized: false,
          visible: true,
          stackingIndex: 0,
        },
      ],
    });
    const { manager } = calibratedScrollFixture([800], backend);

    // Probe-sized on purpose, so the request goes out in one measured leg.
    const result = await manager.scrollCalibrated("thread-1", { x: 900, y: 500 }, 0, 40, {
      observe: true,
    });

    // 1536/1920 = 0.8, so 800 capture pixels of travel are 1000 logical ones.
    expect(result.result.scroll?.traveledY).toBe(1_000);
    expect(result.result.scroll?.gearing).toBe(25);

    await manager.dispose();
  });

  it("suppresses a wrong-way measurement instead of reporting or learning it", async () => {
    // The live footer-alias case: the correlator locked onto repetitive
    // content and answered with travel opposing the injection. That number
    // must reach neither the caller nor the store.
    const { backend, manager } = calibratedScrollFixture([-752, undefined]);

    const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 100, {
      observe: true,
    });

    expect(result.result.scroll?.traveledY).toBeUndefined();
    expect(result.result.scroll?.gearing).toBe(1);
    expect(backend.callsFor("scroll").map((entry) => entry.args[2])).toEqual([48, 52]);

    await manager.dispose();
  });

  it("reads byte-identical captures as no movement, and learns nothing from it", async () => {
    const backend = new FakeComputerBackend();
    const measurements: number[] = [];
    const manager = new ComputerManager({
      backend,
      actionSettleMs: 0,
      measureScrollTravel: () => measurements.push(0) && undefined,
    });

    // No queued captures: the fake returns the same fixture every time, which is
    // what the end of a page looks like — pixels that did not change did not
    // move, and no correlation is needed to know it.
    const first = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(first.result.scroll?.traveledY).toBe(0);
    expect(first.result.scroll?.gearing).toBe(1);
    expect(measurements).toEqual([]);

    const second = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(second.result.scroll?.injected).toEqual({ deltaX: 0, deltaY: 400 });
    expect(second.result.scroll?.traveledY).toBe(0);
    // Delivery decides whether the caller can reuse its previous image.
    expect(second.observation).toHaveProperty("screenshot");
    expect(second.observation).toHaveProperty("windowId", "fake-calculator");
    expect(measurements).toEqual([]);

    await manager.dispose();
  });

  it("keeps the correction but takes no captures when the caller wants no observation", async () => {
    const { backend, manager } = calibratedScrollFixture([336, 64]);

    await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, { observe: true });
    // Three on the probing first scroll: before, after the probe, after the rest.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(3);

    const unobserved = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: false,
    });
    expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
    expect(unobserved.observation).toBeUndefined();
    expect(unobserved.result.scroll?.traveledY).toBeUndefined();
    expect(unobserved.result.scroll?.injected.deltaY).toBe(57.14);
    expect(backend.callsFor("scroll").at(-1)?.args[2]).toBeCloseTo(400 / 7, 6);

    await manager.dispose();
  });

  it("never re-gears the pane's own scroll, whatever the agent learned", async () => {
    const { backend, manager } = calibratedScrollFixture([336, 64]);
    await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, { observe: true });
    const capturesAfterLearning = backend.callsFor("captureScreenshot").length;

    // The human is watching the result and closing the loop themselves; a
    // correction applied under their hand would fight them.
    await manager.scroll(undefined, { x: 1_100, y: 200 }, 0, 400);
    expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 1_100, y: 200 }, 0, 400]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesAfterLearning);

    await manager.dispose();
  });

  it("delivers the scroll unmeasured when the capture fails", async () => {
    const { backend, manager } = calibratedScrollFixture([336]);
    backend.failNext("captureScreenshot");

    const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });

    expect(result.result).toMatchObject({ action: "computer_scroll" });
    expect(result.result.scroll?.traveledY).toBeUndefined();
    expect(result.observation).toBeUndefined();
    expect(backend.callsFor("scroll")).toHaveLength(1);
    // The before-capture failed, so nothing to compare an after-capture against.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(1);

    await manager.dispose();
  });
});
