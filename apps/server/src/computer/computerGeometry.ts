/**
 * Desktop geometry and payload parsing shared by every computer backend.
 *
 * None of this is compositor-specific. The workspace rect, the screenshot
 * mapping (`desktop = region.origin + pixel / scale`), the PNG header read, and
 * the window-list shape are the coordinate contract the agent's tool surface is
 * written against, so a second backend has to produce exactly the same numbers
 * or every coordinate the model learned on one desktop is wrong on the other.
 *
 * The payload helpers live here because `parseWindows` is the reason they
 * exist: window JSON arrives either as a plain string or wrapped in a D-Bus
 * variant, depending on which transport carried it. The variant unwrapping
 * itself is `dbusPlumbing.ts`, shared with the callers that never touch
 * geometry, and re-exported here because this is the import every parser
 * already reaches for.
 */
import {
  COMPUTER_ID_MAX_LENGTH,
  COMPUTER_LABEL_MAX_LENGTH,
  COMPUTER_OCCLUDERS_MAX_LENGTH,
  COMPUTER_WINDOW_LIST_MAX_LENGTH,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerScreenSize,
  type ComputerWindow,
} from "@synara/contracts";

import { pngDimensions } from "../pngHeader.ts";
import { ComputerBackendError } from "./ComputerBackend.ts";
import { unwrapDbusValue } from "./dbusPlumbing.ts";
import { clampTextToLength } from "./utf8Truncation.ts";

/** Prefix of the message a capture failure carries when no backend names itself. */
const DEFAULT_CAPTURE_SOURCE = "The desktop capture";

// ── Payload decoding ─────────────────────────────────────────────────

export { unwrapDbusValue };

/**
 * A JSON document that may still be a string, a variant-wrapped string, or an
 * already-decoded value. Malformed JSON decodes to `null` rather than throwing:
 * every caller degrades to "the display server told us nothing", which is a
 * state they all have to handle anyway.
 */
export function parseJsonPayload(value: unknown): unknown {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped === "string") {
    try {
      return JSON.parse(unwrapped);
    } catch {
      return null;
    }
  }
  return unwrapped;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asNonNegativeInt(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  return numeric === undefined || numeric < 0 ? undefined : Math.trunc(numeric);
}

export function parseComputerRect(value: unknown): ComputerRect | undefined {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  const width = asFiniteNumber(record.width);
  const height = asFiniteNumber(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

export function parseComputerPoint(value: unknown): ComputerPoint | null {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  return x === undefined || y === undefined ? null : { x, y };
}

/**
 * Occluder ids from a source that reports them. Both the field and its
 * individual entries degrade to absent rather than failing the whole window
 * list, because stacking metadata is an optional hint and a backend may omit
 * it entirely. An empty list is dropped: "nothing above this
 * window" is what an absent field already means. The list is clamped well
 * below the contract's ceiling because an occluder enumeration can be
 * N² in the worst case, and no caller can use hundreds of entries.
 */
function asWindowIds(value: unknown): readonly ComputerWindow["id"][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, COMPUTER_OCCLUDERS_MAX_LENGTH)
    .map((id) => clampTextToLength(id, COMPUTER_ID_MAX_LENGTH));
  return ids.length > 0 ? (ids as ComputerWindow["id"][]) : undefined;
}

/**
 * The window list emitted by a backend enumerator.
 *
 * An entry without an id or without a parseable rect is dropped rather than
 * reported bounds-less. `ComputerWindow.bounds` being optional describes a
 * display server that has no geometry to give at all, which is a property of
 * the provider and is declared through `ComputerCapabilities.windowBounds`; a
 * single malformed entry from a source that does report geometry is a bug in
 * that entry, and admitting it would put an unlocatable window in front of a
 * model that has no way to tell the two cases apart.
 *
 * Every free-form string — id, title, app name — is clamped to its contract
 * bound before an object is constructed: one application with a paragraph-long
 * window title (browsers and SPAs do this) must cost that title's tail, not
 * fail the schema encode of every state payload and push event for the whole
 * session. The list itself is clamped to the same ceiling the contract checks.
 */
/**
 * A cheap identity for a window-list payload, used to decide whether to emit a
 * `windows-changed` event.
 *
 * It fingerprints the payload the desktop sent, not the parsed and translated
 * list: parsing is the expensive half, the raw document already reflects every
 * change worth reporting, and re-serialising the parsed list on this path costs
 * a full JSON encode per state read on both backends. The focused id travels
 * with it because focus moving is a change even when no window did.
 */
export function windowsPayloadFingerprint(
  payload: unknown,
  focusedWindowId: string | null,
): string {
  const unwrapped = unwrapDbusValue(payload);
  const body = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
  return `${focusedWindowId ?? ""} ${body}`;
}

/**
 * The same identity, built from the parsed list instead of the payload it came
 * from.
 *
 * The macOS helper answers `list-windows` with a decoded JSON object rather than
 * the string document the KWin plugin sends, so `windowsPayloadFingerprint`
 * there means "re-encode the whole array" — on a call that runs several times
 * per action and per publish. This digests only the fields a `windows-changed`
 * event is about: identity, geometry, stacking, focus, visibility, and the
 * labels a viewer reads. Anything else the desktop reports (occluders, for one)
 * is derived from those, so a change it would catch is a change these catch
 * first.
 */
export function windowsDigestFingerprint(
  windows: readonly ComputerWindow[],
  focusedWindowId: string | null,
): string {
  const parts = [focusedWindowId ?? ""];
  for (const window of windows) {
    const bounds = window.bounds;
    parts.push(
      [
        window.id,
        bounds?.x ?? "",
        bounds?.y ?? "",
        bounds?.width ?? "",
        bounds?.height ?? "",
        window.stackingIndex ?? "",
        window.focused ? 1 : 0,
        window.active === true ? 1 : window.active === false ? 0 : "",
        window.minimized ? 1 : 0,
        window.visible ? 1 : 0,
        window.title,
        window.appName ?? "",
      ].join("\u0001"),
    );
  }
  return parts.join("\u0002");
}

/**
 * Emits `windows-changed` only when an enumeration differs from the last one.
 *
 * Every backend enumerates windows several times per action, and every
 * enumeration that reported a change schedules a state publish — which
 * enumerates again. Both backends therefore kept a "previous fingerprint" field
 * and the same three-line compare beside it; this is that loop, owned once, so
 * the two cannot drift on what counts as a change.
 */
export class WindowListChangeNotifier {
  #fingerprint: string | undefined;

  constructor(private readonly emit: (windows: readonly ComputerWindow[]) => void) {}

  observe(fingerprint: string, windows: readonly ComputerWindow[]): void {
    if (fingerprint === this.#fingerprint) return;
    this.#fingerprint = fingerprint;
    this.emit(windows);
  }
}

/**
 * How far a landed pointer may sit from the requested point before it counts as
 * a clamp. A display server that puts the pointer in the nearest output when a
 * coordinate falls in a gap between monitors lands a pixel or two off for
 * ordinary rounding reasons; past this it moved the action somewhere else and
 * the agent has to be told.
 */
export const POINTER_CLAMP_TOLERANCE_PX = 2;

/**
 * The action result for a pointer request, reporting `clampedTo` when the
 * desktop put the pointer somewhere other than where it was asked to.
 * Shared so every backend answers the same question the same way; `actual` is
 * null when the backend cannot observe where the pointer ended up.
 */
export function pointerClampResult(
  requested: ComputerPoint,
  actual: ComputerPoint | null,
): { readonly point: ComputerPoint; readonly clampedTo?: ComputerPoint } {
  if (
    !actual ||
    (Math.abs(actual.x - requested.x) <= POINTER_CLAMP_TOLERANCE_PX &&
      Math.abs(actual.y - requested.y) <= POINTER_CLAMP_TOLERANCE_PX)
  ) {
    return { point: requested };
  }
  return { point: requested, clampedTo: actual };
}

export function parseWindows(value: unknown, focusedWindowId: string | null): ComputerWindow[] {
  const parsed = parseJsonPayload(value);
  const items = Array.isArray(parsed) ? parsed : [];
  const windows: ComputerWindow[] = [];
  for (const item of items.slice(0, COMPUTER_WINDOW_LIST_MAX_LENGTH)) {
    const record = asRecord(item);
    const rawId = asString(record.id) ?? asString(record.windowId);
    const bounds = parseComputerRect(record.bounds);
    if (!rawId || !bounds) continue;
    // An oversized id cannot be addressed through the schema either way, so
    // the tail is cut rather than the whole window dropped.
    const id = clampTextToLength(rawId, COMPUTER_ID_MAX_LENGTH);
    // Every backend names the owning application, but not with the same key:
    // KWin reports `resourceClass`, Hyprland an `appId`, and the macOS helper an
    // `appName` taken from `kCGWindowOwnerName`. All three land in `appName`,
    // which is the only field the contract has — reading just the two Linux
    // spellings silently dropped the app name from every macOS window.
    const appNameSource =
      asString(record.appName) ?? asString(record.appId) ?? asString(record.resourceClass);
    const stackingIndex = asNonNegativeInt(record.stackingIndex);
    const occludedBy = asWindowIds(record.occludedBy);
    windows.push({
      id: id as ComputerWindow["id"],
      title: clampTextToLength(asString(record.title) ?? "", COMPUTER_LABEL_MAX_LENGTH),
      ...(appNameSource
        ? { appName: clampTextToLength(appNameSource, COMPUTER_LABEL_MAX_LENGTH) }
        : {}),
      ...(typeof record.pid === "number" && record.pid > 0 ? { pid: Math.trunc(record.pid) } : {}),
      bounds,
      focused: record.focused === true || rawId === focusedWindowId,
      ...(typeof record.active === "boolean" ? { active: record.active } : {}),
      minimized: record.minimized === true,
      visible: record.visible !== false,
      ...(stackingIndex !== undefined ? { stackingIndex } : {}),
      ...(occludedBy ? { occludedBy } : {}),
    });
  }
  return windows;
}

/**
 * Windows stacked above `windowId` whose bounds contain `point` — what a bare
 * coordinate click at that point would hit instead of the named window.
 *
 * Empty when the display server reports no stacking order, or none for the
 * named window: an unknown order cannot establish that anything is above
 * anything, and inventing occlusion from bounds alone would refuse clicks that
 * are perfectly safe. Bounds are frame rects, so an overlap is an upper bound
 * on real occlusion — the covering window may be translucent or shaped — which
 * is the safe direction, because the remedy is raising the target either way.
 */
export function windowsCoveringPoint(
  windows: readonly ComputerWindow[],
  windowId: string,
  point: ComputerPoint,
): readonly ComputerWindow[] {
  const depth = windows.find((window) => window.id === windowId)?.stackingIndex;
  if (depth === undefined) return [];
  return windows.filter(
    (window) =>
      window.id !== windowId &&
      window.visible &&
      !window.minimized &&
      window.stackingIndex !== undefined &&
      window.stackingIndex < depth &&
      rectContainsPoint(window.bounds, point),
  );
}

/**
 * The window a bare coordinate action at `point` was delivered to: the topmost
 * visible, unminimized window whose frame contains the point — the same
 * stacking rule the compositor applies to an unscoped click.
 *
 * With one candidate the stacking order is irrelevant. With several, every
 * candidate must report a stacking index: ranking only the windows that have
 * one could crown a window that an unranked one actually covers, and a wrong
 * answer here photographs a window the action never touched.
 */
export function topmostWindowAtPoint(
  windows: readonly ComputerWindow[],
  point: ComputerPoint,
): ComputerWindow | undefined {
  const candidates = windows.filter(
    (window) => window.visible && !window.minimized && rectContainsPoint(window.bounds, point),
  );
  if (candidates.length <= 1) return candidates[0];
  if (candidates.some((window) => window.stackingIndex === undefined)) return undefined;
  return candidates.reduce((top, window) =>
    (window.stackingIndex as number) < (top.stackingIndex as number) ? window : top,
  );
}

export function rectContainsPoint(rect: ComputerRect | undefined, point: ComputerPoint): boolean {
  if (!rect) return false;
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

// ── Workspace geometry ───────────────────────────────────────────────

/**
 * Shifts a rect between the display server's global space and the agent's
 * 0-based one. A multi-monitor layout may place monitors left of or above the
 * primary, so the workspace's top-left can sit at negative globals; every
 * backend translates at its own boundary so agent space stays 0..screenSize.
 */
export function shiftRect(rect: ComputerRect, dx: number, dy: number): ComputerRect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

export function shiftPoint(point: ComputerPoint, dx: number, dy: number): ComputerPoint {
  return { x: point.x + dx, y: point.y + dy };
}

/** One window's bounds moved into agent space; identity and flags ride along. */
export function windowInAgentSpace(window: ComputerWindow, origin: ComputerPoint): ComputerWindow {
  if (window.bounds === undefined) return window;
  return { ...window, bounds: shiftRect(window.bounds, -origin.x, -origin.y) };
}

/**
 * Resolves the global desktop rect. The display server's reported workspace
 * geometry is the source of truth; the window bounding box is the fallback for
 * a source that does not report it yet. Windows with no bounds contribute
 * nothing, which is the only honest thing an unlocatable window can do to a
 * bounding box.
 */
export function workspaceRectFromWindows(
  windows: readonly ComputerWindow[],
  workspace?: ComputerRect | null,
): ComputerRect {
  if (workspace && workspace.width > 0 && workspace.height > 0) {
    return {
      x: Math.floor(workspace.x),
      y: Math.floor(workspace.y),
      width: Math.max(1, Math.ceil(workspace.width)),
      height: Math.max(1, Math.ceil(workspace.height)),
    };
  }
  const bounds = windows
    .map((window) => window.bounds)
    .filter((rect): rect is ComputerRect => rect !== undefined);
  const left = Math.min(0, ...bounds.map((rect) => Math.floor(rect.x)));
  const top = Math.min(0, ...bounds.map((rect) => Math.floor(rect.y)));
  const right = Math.max(left + 1, ...bounds.map((rect) => Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(top + 1, ...bounds.map((rect) => Math.ceil(rect.y + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A window's rect, or a refusal that names why there is none.
 *
 * Absent bounds are a property of the backend, not of the window. Every caller
 * here needs a rect to do arithmetic on, and the alternatives are both
 * lies — treating the origin as the window's position puts a click on the wrong
 * monitor, and returning an empty capture tells a model the window is blank. So
 * the geometry-dependent paths refuse, and say which capability is missing so
 * the caller can pick a coordinate-based approach instead.
 */
export function requireWindowBounds(
  window: Pick<ComputerWindow, "id" | "bounds">,
  action: string,
): ComputerRect {
  if (window.bounds) return window.bounds;
  throw new ComputerBackendError(
    `This desktop reports no geometry for window ${JSON.stringify(window.id)}, so ${action} cannot be resolved. ` +
      "The display server exposes window titles and activation but no position or size " +
      "(capabilities.windowBounds is false); use full-screen capture and desktop coordinates instead.",
  );
}

export function screenSizeFromWindows(
  windows: readonly ComputerWindow[],
  workspace?: ComputerRect | null,
  /**
   * The desktop's backing-store scale, when the backend knows it. Defaults to 1
   * because a display server that reports logical pixels and nothing else has
   * no better answer — but on a Retina Mac 1 is simply false, and a caller
   * reading the reported size cannot tell a truthful 1 from a placeholder.
   */
  scale = 1,
): ComputerScreenSize {
  const rect = workspaceRectFromWindows(windows, workspace);
  return { width: rect.width, height: rect.height, scale: scale > 0 ? scale : 1 };
}

/**
 * Snaps a requested region onto whole logical pixels without losing coverage:
 * capture APIs take integers, so a fractional rect must grow outward instead of
 * cropping the edge the caller asked for.
 */
export function alignRect(rect: ComputerRect): ComputerRect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(rect.x + rect.width) - x),
    height: Math.max(1, Math.ceil(rect.y + rect.height) - y),
  };
}

export function formatRect(rect: ComputerRect): string {
  return `${rect.width}x${rect.height} at (${rect.x}, ${rect.y})`;
}

// ── Capture ──────────────────────────────────────────────────────────

/**
 * Dimensions from a PNG's IHDR chunk, which is at a fixed offset in every
 * conformant file. Reading them from the encoding rather than assuming the
 * requested size is what keeps `scale` honest: a backend renders at the
 * output's device pixel ratio and only then downscales to `maxDimension`.
 *
 * `source` names the backend in the failure, because this message is what a
 * tool call and an availability card both end up showing.
 */
export function readPngDimensions(
  bytes: Uint8Array,
  options: { readonly source?: string } = {},
): { readonly width: number; readonly height: number } {
  const dimensions = pngDimensions(bytes);
  if (!dimensions) {
    throw new ComputerBackendError(
      `${options.source ?? DEFAULT_CAPTURE_SOURCE} did not return a usable PNG image.`,
    );
  }
  return dimensions;
}

/**
 * The screenshot payload is only useful to a model when the desktop rect it
 * covers travels with it, so every capture path in every backend builds it the
 * same way: `desktop = region.origin + screenshot_pixel / scale`.
 */
export function screenshotFromPng(input: {
  readonly bytes: Uint8Array;
  readonly region: ComputerRect;
  readonly capturedAt: string;
  readonly source?: string;
  /**
   * The same image already encoded, when the caller was handed base64 to begin
   * with. A backend whose transport speaks base64 decoded it only to read the
   * PNG header, and re-encoding it here made every screenshot a base64 → bytes
   * → base64 round trip over a multi-megabyte payload. Omitted by callers that
   * genuinely hold only bytes.
   */
  readonly bytesBase64?: string;
}): ComputerScreenshot {
  const dimensions = readPngDimensions(
    input.bytes,
    input.source === undefined ? {} : { source: input.source },
  );
  return {
    mimeType: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    sizeBytes: input.bytes.byteLength,
    bytesBase64: input.bytesBase64 ?? Buffer.from(input.bytes).toString("base64"),
    region: input.region,
    scale: dimensions.width / input.region.width,
    capturedAt: input.capturedAt,
  };
}
