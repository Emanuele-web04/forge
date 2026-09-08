import type {
  ComputerAvailability,
  ComputerCapabilities,
  ComputerHealth,
  ComputerPoint,
  ComputerRect,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerState,
  ComputerUiNode,
  ComputerWindow,
  ComputerInputModifier,
  ComputerInputPause,
  ComputerPermission,
} from "@synara/contracts";
import {
  cuaRequest,
  CUA_HOST_SOCKET_ENV,
  CuaTransportError,
  type CuaReply,
  type CuaToolResult,
  type CuaEffect,
} from "@synara/shared/cuaDriverProtocol";
import {
  ComputerBackendError,
  DEFAULT_COMPUTER_ID,
  NO_COMPUTER_CAPABILITIES,
  assertComputerClipboardWriteFits,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
  type ComputerBackendEventListener,
} from "./ComputerBackend.ts";
import {
  desktopOperationSignal,
  assertDesktopOperationActive,
  desktopDeliveryMode,
} from "./DesktopOperationQueue.ts";
import { StillFramePublisher } from "./stillFramePublisher.ts";
import { pngDimensions } from "../pngHeader.ts";

export class CuaActionError extends ComputerBackendError {
  constructor(
    message: string,
    readonly effect: CuaEffect,
    readonly code = "cua_action_failed",
    inputPause?: ComputerInputPause,
  ) {
    super(`${message} [effect=${effect}; automatic replay is forbidden]`, {
      retryable: false,
      ...(effect === "not-dispatched" && inputPause ? { inputPause } : {}),
    });
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 1024): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : NaN;
function optionalRect(value: unknown): ComputerRect | undefined {
  const r = record(value);
  const out = {
    x: number(r.x),
    y: number(r.y),
    width: number(r.width ?? r.w),
    height: number(r.height ?? r.h),
  };
  return Object.values(out).every(Number.isFinite) && out.width > 0 && out.height > 0
    ? out
    : undefined;
}
function rect(value: unknown): ComputerRect {
  const bounds = optionalRect(value);
  if (!bounds)
    throw new CuaActionError(
      "Cua returned invalid geometry.",
      "not-dispatched",
      "invalid_geometry",
    );
  return bounds;
}
const sameRect = (a: ComputerRect, b: ComputerRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
function cuaKey(value: string): string {
  const key = value.toLowerCase();
  if (key === "insert")
    throw new CuaActionError(
      "Cua 0.24.0 has no Insert key mapping on macOS.",
      "not-dispatched",
      "unsupported_operation",
    );
  const aliases: Record<string, string> = {
    meta: "command",
    super: "command",
    delete: "forward_delete",
    del: "forward_delete",
    arrowleft: "left",
    arrowright: "right",
    arrowup: "up",
    arrowdown: "down",
    " ": "space",
  };
  return aliases[key] ?? key;
}

/** The single macOS backend. Cua owns native actions; Synara owns admission,
 * session authority, explicit delivery policy and the provider result. */
export class CuaComputerBackend implements ComputerBackend {
  readonly computerId = DEFAULT_COMPUTER_ID;
  readonly agentDialect = "macos" as const;
  private readonly endpoint: string | undefined;
  private readonly capability: string | undefined;
  private windows: readonly ComputerWindow[] = [];
  private size: ComputerScreenSize = { width: 1, height: 1 };
  private permissions: ComputerPermission[] = [];
  private currentAvailability: ComputerAvailability = {
    kind: "backend-unavailable",
    message: "Computer has not connected to the Synara desktop app.",
  };
  private currentHealth: ComputerHealth = {
    status: "unavailable",
    consecutiveFailures: 0,
    reconnects: 0,
    captureAvailable: false,
  };
  private captureFailed = false;
  private readonly listeners = new Set<ComputerBackendEventListener>();
  private snapshotAt = 0;
  private snapshot: Promise<void> | undefined;
  private selectedWindow: string | undefined;
  private readonly elementTokens = new WeakMap<ComputerUiNode, string>();
  private readonly observedGeometry = new Map<string, ComputerRect>();
  private readonly stills: StillFramePublisher;
  private cachedImage: ComputerScreenshot | undefined;
  private disposed = false;
  constructor(
    options: {
      endpoint?: string;
      capability?: string | undefined;
      request?: typeof cuaRequest;
    } = {},
  ) {
    this.endpoint = options.endpoint ?? process.env[CUA_HOST_SOCKET_ENV];
    this.capability = options.capability;
    this.request = options.request ?? cuaRequest;
    this.stills = new StillFramePublisher({
      capture: async () => {
        // Reuse a recent tool observation; idle panes spend at most one capture
        // every two seconds and detached panes spend none.
        const image =
          this.cachedImage && Date.now() - Date.parse(this.cachedImage.capturedAt) < 1_500
            ? this.cachedImage
            : await this.captureOverview();
        return Buffer.from(image.bytesBase64, "base64");
      },
      prepare: async () => {
        await this.availability();
      },
      isCaptureAvailable: () => !this.disposed && !this.permissions.includes("screenRecording"),
      emit: () => undefined,
      now: Date.now,
      intervalMs: 2_000,
    });
  }
  private readonly request: typeof cuaRequest;
  onEvent(listener: ComputerBackendEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private setHealth(health: ComputerHealth): void {
    if (JSON.stringify(health) === JSON.stringify(this.currentHealth)) return;
    this.currentHealth = health;
    for (const listener of this.listeners) listener({ type: "health-changed", health });
  }
  private async host(request: Record<string, unknown>, mutation = false): Promise<CuaReply> {
    if (this.disposed || !this.endpoint)
      throw new CuaActionError(
        "Open this session in the Synara macOS desktop app to use Computer.",
        "not-dispatched",
        "gui_host_required",
      );
    assertDesktopOperationActive();
    try {
      const reply = await this.request<CuaReply>(
        this.endpoint,
        { ...request, capability: this.capability },
        { signal: desktopOperationSignal(), mutation, timeoutMs: 35_000 },
      );
      if (!reply.ok)
        throw new CuaActionError(
          reply.error ?? "Cua host failed.",
          reply.effect ?? "not-dispatched",
        );
      return reply;
    } catch (error) {
      if (error instanceof CuaTransportError) throw new CuaActionError(error.message, error.effect);
      throw error;
    }
  }
  private async call(
    name: string,
    args: Record<string, unknown> = {},
    mutation = false,
  ): Promise<CuaToolResult> {
    const reply = await this.host({ method: "call", name, args }, mutation);
    const result = reply.result ?? {};
    if (result.isError || result.structuredContent?.effect === "refused") {
      const structured = result.structuredContent ?? {};
      // Only a structured native admission refusal proves no dispatch. An
      // arbitrary native exception may follow partially delivered input.
      const refused = structured.effect === "refused";
      const message =
        (result.content ?? [])
          .map((c) => c.text ?? "")
          .join("\n")
          .slice(0, 2048) ||
        text(structured.message) ||
        text(structured.reason) ||
        "The native operation could not complete.";
      const code = text(structured.code) || "cua_refusal";
      const inputPause =
        refused &&
        code === "target_not_on_active_space" &&
        Number.isSafeInteger(args.pid) &&
        Number.isSafeInteger(args.window_id)
          ? { windowId: `cua:${args.pid}:${args.window_id}`, message }
          : undefined;
      throw new CuaActionError(
        message,
        mutation && !refused ? "dispatched-unknown" : "not-dispatched",
        code,
        inputPause,
      );
    }
    return result;
  }
  async probeAvailability(): Promise<ComputerAvailability> {
    if (!this.endpoint)
      return {
        kind: "backend-unavailable",
        message:
          "Computer requires the Synara macOS desktop app, which owns the native permissions.",
      };
    try {
      await this.host({ method: "probe" });
      return this.currentAvailability.kind === "backend-unavailable"
        ? { kind: "available", backend: "cua" }
        : this.currentAvailability;
    } catch (error) {
      return { kind: "backend-unavailable", message: String(error).slice(0, 2048) };
    }
  }
  async availability(): Promise<ComputerAvailability> {
    await this.refresh();
    return this.currentAvailability;
  }
  health(): ComputerHealth {
    return this.currentHealth;
  }
  capabilities(): ComputerCapabilities {
    return {
      ...NO_COMPUTER_CAPABILITIES,
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    };
  }
  async missingPermissions() {
    return this.permissions;
  }
  async provision(): Promise<string> {
    await this.host({ method: "setup" });
    this.snapshotAt = 0;
    await this.refresh();
    return "Enable Accessibility and Screen Recording for this Synara app in System Settings, then fully quit and reopen Synara. The bundled Cua driver needs no Xcode installation.";
  }
  private refresh(force = false): Promise<void> {
    if (this.snapshot) return this.snapshot;
    if (!force && Date.now() - this.snapshotAt < 250) return Promise.resolve();
    this.snapshot = (async () => {
      const permission =
        (await this.call("check_permissions", { prompt: false })).structuredContent ?? {};
      this.permissions = [];
      if (permission.accessibility !== true) this.permissions.push("accessibility");
      if (permission.screen_recording !== true) this.permissions.push("screenRecording");
      this.setHealth({
        ...this.currentHealth,
        status: this.captureFailed ? "unavailable" : "connected",
        captureAvailable: permission.screen_recording === true && !this.captureFailed,
        consecutiveFailures: this.captureFailed ? this.currentHealth.consecutiveFailures : 0,
      });
      this.currentAvailability = this.permissions.length
        ? {
            kind: "permission-required",
            missing: this.permissions,
            buildSignature: "unknown",
            message:
              "Enable Accessibility and Screen Recording for Synara in System Settings, then relaunch Synara.",
          }
        : { kind: "available", backend: "cua" };
      if (!this.permissions.length) {
        await this.readWindows();
        const geometry = (await this.call("get_screen_size")).structuredContent ?? {};
        const width = number(geometry.width),
          height = number(geometry.height);
        if (!(width > 0 && height > 0))
          throw new Error("Cua returned no primary display geometry.");
        this.size = { width, height, scale: number(geometry.scale_factor) };
      }
      this.snapshotAt = Date.now();
    })()
      .catch((error) => {
        this.setHealth({
          ...this.currentHealth,
          status: "unavailable",
          captureAvailable: false,
          consecutiveFailures: this.currentHealth.consecutiveFailures + 1,
          lastFailure: { at: new Date().toISOString(), message: String(error).slice(0, 2048) },
        });
        throw error;
      })
      .finally(() => {
        this.snapshot = undefined;
      });
    return this.snapshot;
  }
  private async readWindows(): Promise<readonly ComputerWindow[]> {
    const data = (await this.call("list_windows")).structuredContent ?? {};
    if (!Array.isArray(data.windows)) throw new Error("Invalid Cua window list.");
    const rows = data.windows
      .map(record)
      .sort((a, b) => (number(b.z_index) || 0) - (number(a.z_index) || 0));
    this.windows = rows
      .flatMap((w, i): ComputerWindow[] => {
        const pid = number(w.pid),
          windowId = number(w.window_id),
          bounds = optionalRect(w.bounds);
        // WindowServer can return zero-area placeholders. They are not input
        // targets and must not make every other application unavailable.
        if (
          !Number.isInteger(pid) ||
          pid <= 0 ||
          !Number.isInteger(windowId) ||
          windowId <= 0 ||
          !bounds
        )
          return [];
        return [
          {
            id: `cua:${pid}:${windowId}`,
            pid,
            title: text(w.title),
            appName: text(w.app_name),
            bounds,
            focused: this.selectedWindow === `cua:${pid}:${windowId}`,
            minimized: false,
            visible: w.is_on_screen === true && w.on_current_space !== false,
            ...(Number.isInteger(w.z_index) ? { stackingIndex: i } : {}),
          },
        ];
      })
      .slice(0, 512);
    return this.windows;
  }
  async listWindows() {
    await this.refresh();
    return this.windows;
  }
  async getScreenSize() {
    await this.refresh();
    return this.size;
  }
  private async target(
    windowId = this.selectedWindow,
    fresh = true,
  ): Promise<{ pid: number; window_id: number; window: ComputerWindow }> {
    if (!windowId || !/^cua:[1-9]\d*:[1-9]\d*$/.test(windowId))
      throw new CuaActionError(
        "Select an exact window before acting.",
        "not-dispatched",
        "window_required",
      );
    const windows = fresh ? await this.readWindows() : this.windows;
    const window = windows.find((w) => w.id === windowId);
    if (!window?.bounds || !window.pid)
      throw new CuaActionError(
        "The target window closed or its identity changed.",
        "not-dispatched",
        "stale_target",
      );
    return { pid: window.pid, window_id: Number(windowId.split(":")[2]), window };
  }
  async focusWindow(windowId: string): Promise<void> {
    await this.target(windowId);
    this.selectedWindow = windowId;
  }
  async checkInputReady(windowId: string): Promise<void> {
    const { pid, window_id } = await this.target(windowId);
    const result = await this.call("check_input_ready", { pid, window_id });
    const data = result.structuredContent ?? {};
    if (data.ready !== true || number(data.pid) !== pid || number(data.window_id) !== window_id) {
      throw new CuaActionError(
        "Cua did not confirm input readiness for the exact target window.",
        "not-dispatched",
        "invalid_readiness",
      );
    }
  }
  async raiseWindow(windowId: string): Promise<void> {
    if (desktopDeliveryMode() !== "foreground")
      throw new CuaActionError(
        "Window activation requires explicit foreground approval.",
        "not-dispatched",
        "foreground_required",
      );
    const { pid, window_id } = await this.target(windowId);
    const result = await this.call("bring_to_front", { pid, window_id }, true);
    if (result.structuredContent?.activated !== true)
      throw new CuaActionError(
        "Cua could not verify that the exact window became foreground. Do not repeat the activation blindly.",
        "dispatched-unknown",
      );
    this.snapshotAt = 0;
  }
  async clearFocusWindow(): Promise<void> {
    this.selectedWindow = undefined;
  }
  private screenshot(result: CuaToolResult, fallback?: ComputerRect): ComputerScreenshot {
    const data = result.structuredContent ?? {};
    const image = result.content?.find(
      (c) => c.type === "image" && c.mimeType === "image/png" && c.data,
    );
    if (!image?.data || data.screenshot_frame_valid === false)
      throw new CuaActionError(
        "Cua could not establish the screenshot geometry.",
        "not-dispatched",
        "capture_unavailable",
      );
    const bytes = Buffer.from(image.data, "base64");
    const dimensions = pngDimensions(bytes);
    const region = data.window_bounds ? rect(data.window_bounds) : fallback;
    if (!dimensions || !region) throw new Error("Cua screenshot is missing its coordinate frame.");
    const scale = dimensions.width / region.width;
    if (Math.abs(dimensions.height / region.height - scale) > 0.01)
      throw new Error("Cua screenshot dimensions disagree with its geometry.");
    return {
      mimeType: "image/png",
      ...dimensions,
      sizeBytes: bytes.length,
      bytesBase64: image.data,
      region,
      scale,
      capturedAt: new Date().toISOString(),
    };
  }
  private async captureOverview(): Promise<ComputerScreenshot> {
    try {
      const result = await this.call("get_desktop_state");
      const data = result.structuredContent ?? {};
      const image = this.screenshot(result, {
        x: 0,
        y: 0,
        width: number(data.screen_width),
        height: number(data.screen_height),
      });
      this.cachedImage = image;
      this.captureFailed = false;
      this.setHealth({
        ...this.currentHealth,
        status: "connected",
        captureAvailable: true,
        consecutiveFailures: 0,
      });
      return image;
    } catch (error) {
      this.captureFailed = true;
      this.setHealth({
        ...this.currentHealth,
        status: "unavailable",
        captureAvailable: false,
        consecutiveFailures: this.currentHealth.consecutiveFailures + 1,
        lastFailure: { at: new Date().toISOString(), message: String(error).slice(0, 2048) },
      });
      throw error;
    }
  }
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    if (request.kind === "region")
      throw new CuaActionError(
        "Region capture is not supported by this pinned Cua backend. Capture an exact window; the overview covers the primary display only.",
        "not-dispatched",
        "unsupported_operation",
      );
    const { pid, window_id, window } = await this.target(request.windowId);
    const result = await this.call("get_window_state", {
      pid,
      window_id,
      include_accessibility_tree: false,
      include_screenshot: true,
      max_dimension: request.maxDimension ?? 1536,
    });
    this.assertObservedWindow(result, pid, window_id);
    const image = { ...this.screenshot(result), windowId: window.id };
    this.observedGeometry.set(window.id, image.region!);
    return image;
  }
  private assertObservedWindow(result: CuaToolResult, pid: number, windowId: number): void {
    const data = result.structuredContent ?? {};
    if (number(data.pid) !== pid || number(data.window_id) !== windowId)
      throw new CuaActionError("Cua observation belongs to a different window.", "not-dispatched");
  }
  async getState(options: {
    includeScreenshot?: boolean;
    includeTree?: boolean;
    windowId?: string;
  }): Promise<ComputerState> {
    await this.refresh();
    const state: ComputerState = {
      computerId: this.computerId,
      windows: this.windows,
      screenSize: this.size,
      availability: this.currentAvailability,
      capturedAt: new Date().toISOString(),
    };
    if (this.permissions.length) return state;
    if (!options.windowId)
      return {
        ...state,
        ...(options.includeScreenshot ? { screenshot: await this.captureOverview() } : {}),
        accessibility: { status: "partial", unavailableWindowIds: this.windows.map((w) => w.id) },
      };
    const { pid, window_id, window } = await this.target(options.windowId);
    if (!options.includeTree && !options.includeScreenshot) return state;
    const result = await this.call("get_window_state", {
      pid,
      window_id,
      include_screenshot: options.includeScreenshot === true,
      include_accessibility_tree: options.includeTree === true,
      max_elements: 1024,
      max_depth: 25,
      max_dimension: 1536,
    });
    const data = result.structuredContent ?? {};
    this.assertObservedWindow(result, pid, window_id);
    const children: ComputerUiNode[] = [];
    if (Array.isArray(data.elements))
      for (const value of data.elements.slice(0, 1024)) {
        const element = record(value);
        if (!element.frame) continue;
        const frame = optionalRect(element.frame);
        if (!frame) continue;
        const node: ComputerUiNode = {
          role: text(element.role, 128),
          label: text(element.label) || null,
          value: typeof element.value === "string" ? text(element.value, 16384) : null,
          description: text(element.value_description) || null,
          frame,
          activationPoint: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
          onScreen: window.visible,
          windowId: window.id,
          children: [],
        };
        if (typeof element.element_token === "string")
          this.elementTokens.set(node, element.element_token);
        children.push(node);
      }
    const root: ComputerUiNode = {
      role: "AXWindow",
      label: window.title,
      value: null,
      description: null,
      frame: window.bounds!,
      activationPoint: null,
      onScreen: window.visible,
      windowId: window.id,
      truncated: data.elements_complete !== true,
      children,
    };
    const image = options.includeScreenshot
      ? { ...this.screenshot(result), windowId: window.id }
      : undefined;
    if (image?.region) this.observedGeometry.set(window.id, image.region);
    return {
      ...state,
      root,
      accessibility: { status: "partial", unavailableWindowIds: [] },
      ...(image ? { screenshot: image } : {}),
    };
  }
  private async input(
    name: string,
    args: Record<string, unknown>,
    windowId?: string,
    point?: ComputerPoint,
    preparedBounds?: ComputerRect,
  ): Promise<ComputerBackendActionResult> {
    const { pid, window_id, window } = await this.target(windowId);
    if (!window.visible) {
      const message =
        "The target window is not available on the current Space. Read its state after it becomes available before continuing.";
      throw new CuaActionError(message, "not-dispatched", "target_not_on_active_space", {
        windowId: window.id,
        message,
      });
    }
    const bounds = window.bounds!;
    if (preparedBounds && !sameRect(preparedBounds, bounds))
      throw new CuaActionError(
        "Target moved after drag preparation; obtain a new screenshot.",
        "not-dispatched",
        "stale_geometry",
      );
    const observed = this.observedGeometry.get(window.id);
    if (point && (!observed || !sameRect(observed, bounds)))
      throw new CuaActionError(
        "Window geometry changed since observation; obtain a new screenshot.",
        "not-dispatched",
        "stale_geometry",
      );
    let pixel: Record<string, unknown> = {};
    if (point) {
      // Cua accepts window-local screenshot pixels. Its fresh frame resolver
      // proves the current backing scale before native injection.
      const capture = await this.call("get_window_state", {
        pid,
        window_id,
        include_accessibility_tree: false,
        include_screenshot: true,
        max_dimension: 16384,
      });
      this.assertObservedWindow(capture, pid, window_id);
      const image = this.screenshot(capture);
      if (!sameRect(image.region!, bounds))
        throw new CuaActionError(
          "Target moved during action preparation.",
          "not-dispatched",
          "stale_geometry",
        );
      const x = (point.x - bounds.x) * image.scale!,
        y = (point.y - bounds.y) * image.scale!;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height)
        throw new CuaActionError("Point is outside the target window.", "not-dispatched");
      pixel = { x, y };
    }
    assertDesktopOperationActive();
    let result: CuaToolResult;
    try {
      result = await this.call(
        name,
        {
          pid,
          window_id,
          ...(name !== "set_value" ? { delivery_mode: desktopDeliveryMode() } : {}),
          ...args,
          ...pixel,
          ...(point || preparedBounds ? { expected_window_bounds: preparedBounds ?? bounds } : {}),
        },
        true,
      );
    } finally {
      // An error can follow partial input, so cached pixels cannot survive it.
      this.cachedImage = undefined;
      this.snapshotAt = 0;
    }
    const data = result.structuredContent ?? {};
    // Cua 0.24 publishes ActionResult, replacing internal `path` with `route`
    // and delivery metadata. Confirmed effects require its public evidence.
    const confirmed =
      data.effect === "confirmed" &&
      Array.isArray(data.evidence) &&
      data.evidence.some((item) =>
        ["value_readback", "window_change"].includes(text(record(item).kind)),
      );
    const mode = text(record(data.delivery).mode, 32) || "unknown";
    return {
      windowId: window.id,
      ...(point ? { point } : {}),
      deliveryPath: `cua-${text(data.route, 64) || "unknown"}-${mode}`,
      verified: confirmed
        ? "confirmed"
        : data.effect === "unconfirmed" || data.effect === "suspected_noop"
          ? "unconfirmed"
          : "unverifiable",
      effect: confirmed ? "verified" : "dispatched-unknown",
    };
  }
  click(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        count: 1,
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  doubleClick(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        count: 2,
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  tripleClick(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        count: 3,
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  rightClick(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        button: "right",
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  async moveCursor(p: ComputerPoint, w?: string): Promise<ComputerBackendActionResult> {
    if (w) await this.target(w);
    await this.call("move_cursor", { x: p.x, y: p.y }, true);
    return { point: p, deliveryPath: "cua-overlay-only", verified: "unverifiable" };
  }
  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    windowId?: string,
  ): Promise<ComputerBackendActionResult> {
    if (desktopDeliveryMode() !== "foreground")
      throw new CuaActionError(
        "Cua 0.24.0 cannot drag in the background on macOS. Explicit foreground authorization is required.",
        "not-dispatched",
        "foreground_required",
      );
    if (durationMs > 10_000)
      throw new CuaActionError(
        "Cua drag duration is limited to 10 seconds.",
        "not-dispatched",
        "unsupported_operation",
      );
    const target = await this.target(windowId);
    const observed = this.observedGeometry.get(target.window.id);
    if (!observed || !sameRect(observed, target.window.bounds!))
      throw new CuaActionError(
        "Window geometry changed since observation; obtain a new screenshot.",
        "not-dispatched",
        "stale_geometry",
      );
    const image = await this.captureScreenshot({
      kind: "window",
      windowId: target.window.id,
      maxDimension: 16384,
    });
    const bounds = image.region!;
    if (!sameRect(observed, bounds))
      throw new CuaActionError(
        "Target moved during drag preparation.",
        "not-dispatched",
        "stale_geometry",
      );
    const local = (p: ComputerPoint) => {
      const x = (p.x - bounds.x) * image.scale!,
        y = (p.y - bounds.y) * image.scale!;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height)
        throw new CuaActionError("Drag crosses outside its target window.", "not-dispatched");
      return { x, y };
    };
    const start = local(from),
      end = local(to);
    return this.input(
      "drag",
      { from_x: start.x, from_y: start.y, to_x: end.x, to_y: end.y, duration_ms: durationMs },
      target.window.id,
      undefined,
      bounds,
    );
  }
  async scroll(
    p: ComputerPoint | null,
    dx: number,
    dy: number,
    w?: string,
    modifiers?: readonly ComputerInputModifier[],
  ) {
    if (dx && dy)
      throw new CuaActionError(
        "Cua accepts one scroll axis per operation.",
        "not-dispatched",
        "unsupported_operation",
      );
    if (modifiers?.length)
      throw new CuaActionError(
        "Cua 0.24.0 does not support modified scroll on macOS.",
        "not-dispatched",
        "unsupported_operation",
      );
    if (!p)
      throw new CuaActionError("Scroll requires a screenshot target point.", "not-dispatched");
    if (!dx && !dy)
      return {
        ...(w ? { windowId: w } : {}),
        scrollDelta: { deltaX: 0, deltaY: 0 },
        deliveryPath: "cua-no-op",
        verified: "unverifiable" as const,
        effect: "not-dispatched" as const,
      };
    // Pinned macOS source defines one targeted line-notch as 120 wheel pixels.
    // Expose the quantization; never multiply a requested pixel into a notch.
    const amount = Math.max(1, Math.round(Math.abs(dx || dy) / 120));
    if (amount > 50)
      throw new CuaActionError(
        "Scroll exceeds Cua's 50-notch limit.",
        "not-dispatched",
        "unsupported_operation",
      );
    const result = await this.input(
      "scroll",
      { direction: dx ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up", amount, by: "line" },
      w,
      p,
    );
    return {
      ...result,
      scrollDelta: {
        deltaX: dx ? Math.sign(dx) * amount * 120 : 0,
        deltaY: dy ? Math.sign(dy) * amount * 120 : 0,
      },
    };
  }
  typeText(value: string, w?: string) {
    return this.input("type_text", { text: value, force_synthetic: true }, w);
  }
  pressKey(key: string, w?: string) {
    return this.input("press_key", { key: cuaKey(key) }, w);
  }
  hotkey(keys: readonly string[], w?: string) {
    const native = keys.map(cuaKey);
    const modifiers = new Set([
      "command",
      "cmd",
      "shift",
      "option",
      "alt",
      "ctrl",
      "control",
      "fn",
    ]);
    if (native.length < 2 || native.filter((key) => !modifiers.has(key)).length !== 1)
      throw new CuaActionError(
        "A shortcut requires modifiers and exactly one other key.",
        "not-dispatched",
        "invalid_chord",
      );
    return this.input("hotkey", { keys: native }, w);
  }
  async setValue(target: ComputerResolvedTarget, value: string) {
    const token = this.elementTokens.get(target.node);
    if (!token || !target.node.windowId)
      throw new CuaActionError(
        "The AX target is not bound to a live Cua token.",
        "not-dispatched",
        "stale_target",
      );
    return this.input("set_value", { element_token: token, value }, target.node.windowId);
  }
  async performAction(target: ComputerResolvedTarget, action: string) {
    if (action !== "AXPress")
      throw new CuaActionError(
        `Cua does not expose ${action} through this integration.`,
        "not-dispatched",
        "unsupported_operation",
      );
    const token = this.elementTokens.get(target.node);
    if (!token || !target.node.windowId)
      throw new CuaActionError(
        "The AX target is no longer valid.",
        "not-dispatched",
        "stale_target",
      );
    return this.input("click", { element_token: token }, target.node.windowId);
  }
  async readClipboard(): Promise<string> {
    const data =
      (await this.call("clipboard_read", { include_text: true }, true)).structuredContent ?? {};
    if (typeof data.text !== "string")
      throw new Error("The clipboard does not contain readable text.");
    if (data.text.length > 16384) throw new Error("Clipboard exceeds the tool's text limit.");
    return data.text;
  }
  async writeClipboard(value: string) {
    assertComputerClipboardWriteFits(value);
    await this.call("clipboard_write", { text: value }, true);
  }
  async launchApp(app: string, args?: readonly string[]) {
    if (app.startsWith("/"))
      throw new CuaActionError(
        "Use an installed app's name or bundle identifier with Cua.",
        "not-dispatched",
        "unsupported_operation",
      );
    await this.call(
      "launch_app",
      {
        ...(/^[a-zA-Z][\w-]*(\.[\w-]+)+$/.test(app) ? { bundle_id: app } : { name: app }),
        ...(args?.length ? { additional_arguments: args } : {}),
      },
      true,
    );
    return { computerId: this.computerId, app, window: null };
  }
  async attachStream(listener: ComputerFrameListener) {
    await this.stills.attach(listener);
  }
  async detachStream() {
    await this.stills.detach();
  }
  async requestKeyframe() {
    await this.stills.requestKeyframe();
  }
  async stopInput() {
    if (this.endpoint) {
      const result = await this.request<CuaReply>(this.endpoint, {
        method: "stop",
        capability: this.capability,
      });
      if (!result.ok)
        throw new CuaActionError(
          result.error ?? "Computer stop was not acknowledged.",
          "dispatched-unknown",
        );
    }
    this.observedGeometry.clear();
    this.snapshotAt = 0;
  }
  async dispose() {
    await this.stills.detach();
    await this.stopInput();
    this.disposed = true;
    this.listeners.clear();
  }
}
