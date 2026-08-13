import { webContents as electronWebContents } from "electron";
import type { KeyboardInputEvent } from "electron";

import type {
  BrowserAutomationExpectedInput,
  BrowserAutomationVisibleRuntime,
} from "../browserManager";
import type { ActionablePoint } from "./actionability";
import { abortReason, drainOnAbort, sendCdpCommand, throwIfAborted } from "./cdpRuntime";

export type TrustedMouseButton = "left" | "right" | "middle";
export type TrustedInputModifier = "Alt" | "Control" | "Meta" | "Shift";

export interface TrustedClickOptions {
  readonly button?: TrustedMouseButton | undefined;
  readonly clickCount?: number | undefined;
  readonly modifiers?: readonly TrustedInputModifier[] | undefined;
}

interface IsolatedKeyboardInputEvent extends KeyboardInputEvent {
  /** Chromium's NativeWebKeyboardEvent escape hatch: never bubble an
   * unhandled guest key into Synara's renderer or application menu. */
  readonly skipIfUnhandled: true;
}

const MODIFIER_MASKS: Record<TrustedInputModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const ELECTRON_MODIFIERS: Record<
  TrustedInputModifier,
  NonNullable<KeyboardInputEvent["modifiers"]>[number]
> = {
  Alt: "alt",
  Control: "control",
  Meta: "meta",
  Shift: "shift",
};

const KEY_CODE_ALIASES: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
};

function mouseButtonMask(button: TrustedMouseButton): number {
  switch (button) {
    case "right":
      return 2;
    case "middle":
      return 4;
    default:
      return 1;
  }
}

const modifierMask = (modifiers: readonly TrustedInputModifier[] | undefined): number =>
  (modifiers ?? []).reduce((mask, modifier) => mask | MODIFIER_MASKS[modifier], 0);

const expectInput = (
  runtime: BrowserAutomationVisibleRuntime,
  signal: BrowserAutomationExpectedInput,
): (() => void) => runtime.expectAgentInput?.(signal) ?? (() => undefined);

const dispatchInputCommand = <Result = unknown>(
  runtime: BrowserAutomationVisibleRuntime,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Result> =>
  sendCdpCommand<Result>(runtime, method, params, signal, {
    effectMayHaveCommitted: true,
  });

export const dispatchTrustedClick = async (
  runtime: BrowserAutomationVisibleRuntime,
  point: ActionablePoint,
  options: TrustedClickOptions = {},
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const button = options.button ?? "left";
  const clickCount = Math.max(1, Math.min(3, Math.trunc(options.clickCount ?? 1)));
  const modifiers = modifierMask(options.modifiers);
  const releases: Array<() => void> = [];
  for (let index = 0; index < clickCount; index += 1) {
    releases.push(
      expectInput(runtime, {
        kind: "mouse",
        type: "mouseDown",
        button,
        x: point.x,
        y: point.y,
      }),
    );
  }
  if (button === "right") {
    releases.push(
      expectInput(runtime, {
        kind: "mouse",
        type: "contextMenu",
        button,
        x: point.x,
        y: point.y,
      }),
    );
  }
  try {
    await dispatchInputCommand(
      runtime,
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        modifiers,
      },
      signal,
    );
    for (let index = 1; index <= clickCount; index += 1) {
      await dispatchInputCommand(
        runtime,
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button,
          buttons: mouseButtonMask(button),
          clickCount: index,
          modifiers,
        },
        signal,
      );
      await dispatchInputCommand(
        runtime,
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button,
          buttons: 0,
          clickCount: index,
          modifiers,
        },
        signal,
      );
    }
  } finally {
    for (const release of releases) release();
  }
};

export const dispatchTrustedHover = async (
  runtime: BrowserAutomationVisibleRuntime,
  point: ActionablePoint,
  signal?: AbortSignal,
): Promise<void> => {
  await dispatchInputCommand(
    runtime,
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    },
    signal,
  );
};

export const dispatchTrustedDrag = async (
  runtime: BrowserAutomationVisibleRuntime,
  source: ActionablePoint,
  target: ActionablePoint,
  options: { readonly steps?: number | undefined } = {},
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const releaseExpected = expectInput(runtime, {
    kind: "mouse",
    type: "mouseDown",
    button: "left",
    x: source.x,
    y: source.y,
  });
  let resolveDragData!: (data: Record<string, unknown>) => void;
  let rejectDragData!: (error: Error) => void;
  const dragDataPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveDragData = resolve;
    rejectDragData = reject;
  });
  void dragDataPromise.catch(() => undefined);
  let interceptedDragData: Record<string, unknown> | undefined;
  let dragListenerActive = true;
  const onDebuggerMessage = (...args: unknown[]) => {
    if (args[1] !== "Input.dragIntercepted") return;
    const params = args[2];
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    const data = (params as { readonly data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    interceptedDragData = data as Record<string, unknown>;
    releaseDragListener();
    resolveDragData(interceptedDragData);
  };
  const onAbort = () => {
    releaseDragListener();
    rejectDragData(signal ? abortReason(signal) : new Error("Browser operation cancelled."));
  };
  const releaseDragListener = () => {
    if (!dragListenerActive) return;
    dragListenerActive = false;
    runtime.webContents.debugger.off("message", onDebuggerMessage);
    signal?.removeEventListener("abort", onAbort);
  };
  runtime.webContents.debugger.on("message", onDebuggerMessage);
  signal?.addEventListener("abort", onAbort, { once: true });

  let interceptionEnabled = false;
  let pressed = false;
  let dragStarted = false;
  let dropped = false;
  try {
    await dispatchInputCommand(
      runtime,
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: source.x,
        y: source.y,
        button: "none",
      },
      signal,
    );
    pressed = true;
    await dispatchInputCommand(
      runtime,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: source.x,
        y: source.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        force: 0.5,
      },
      signal,
    );
    // Chromium only starts interception for the move that actually crosses the
    // HTML drag threshold. Enable it after mouseDown, matching Chromium's own
    // Playwright driver, so the source activation is not swallowed.
    await sendCdpCommand(runtime, "Input.setInterceptDrags", { enabled: true }, signal);
    interceptionEnabled = true;
    const steps = Math.max(1, Math.min(100, Math.trunc(options.steps ?? 12)));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      await dispatchInputCommand(
        runtime,
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: source.x + (target.x - source.x) * progress,
          y: source.y + (target.y - source.y) * progress,
          button: "left",
          buttons: 1,
          force: 0.5,
        },
        signal,
      );
      if (interceptedDragData) break;
    }
    const dragData =
      interceptedDragData ??
      (await Promise.race([
        dragDataPromise,
        new Promise<undefined>((resolve) => setTimeout(resolve, 25)),
      ]));
    if (!dragData) return;
    dragStarted = true;
    throwIfAborted(signal);
    await sendCdpCommand(runtime, "Input.setInterceptDrags", { enabled: false }, signal);
    interceptionEnabled = false;
    await dispatchInputCommand(
      runtime,
      "Input.dispatchDragEvent",
      {
        type: "dragEnter",
        x: target.x,
        y: target.y,
        data: dragData,
        modifiers: 0,
      },
      signal,
    );
    await dispatchInputCommand(
      runtime,
      "Input.dispatchDragEvent",
      {
        type: "dragOver",
        x: target.x,
        y: target.y,
        data: dragData,
        modifiers: 0,
      },
      signal,
    );
    await dispatchInputCommand(
      runtime,
      "Input.dispatchDragEvent",
      {
        type: "drop",
        x: target.x,
        y: target.y,
        data: dragData,
        modifiers: 0,
      },
      signal,
    );
    dropped = true;
  } finally {
    releaseDragListener();
    if (!dropped && (dragStarted || interceptionEnabled) && !runtime.webContents.isDestroyed()) {
      try {
        await runtime.webContents.debugger.sendCommand("Input.cancelDragging");
      } catch {
        // Older Chromium builds may not expose cancelDragging. Pointer release
        // and disabling interception below still restore a safe input state.
      }
    }
    if (pressed && !dropped && !runtime.webContents.isDestroyed()) {
      try {
        await dispatchInputCommand(runtime, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: target.x,
          y: target.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      } catch {
        // Releasing a possibly committed press is best-effort during teardown.
      }
    }
    if (interceptionEnabled && !runtime.webContents.isDestroyed()) {
      try {
        await runtime.webContents.debugger.sendCommand("Input.setInterceptDrags", {
          enabled: false,
        });
      } catch {
        // The guest is disconnecting; no input interception survives its CDP session.
      }
    }
    releaseExpected();
  }
};

export const dispatchTrustedScroll = async (
  runtime: BrowserAutomationVisibleRuntime,
  point: ActionablePoint,
  deltaX: number,
  deltaY: number,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const releaseExpected = expectInput(runtime, {
    kind: "mouse",
    type: "mouseWheel",
    x: point.x,
    y: point.y,
  });
  try {
    await dispatchInputCommand(
      runtime,
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX,
        deltaY,
      },
      signal,
    );
  } finally {
    releaseExpected();
  }
};

export const dispatchTrustedText = async (
  runtime: BrowserAutomationVisibleRuntime,
  text: string,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  if (text.length === 0) return;
  // Electron's CDP Input.insertText can follow the embedder's native focus and
  // type into Synara's composer when a <webview> guest is visible but the user
  // last focused the shell. WebContents.insertText is explicitly bound to this
  // adopted guest, preserving trusted editing semantics without crossing the
  // browser boundary.
  await drainOnAbort(runtime.webContents.insertText(text), signal);
};

interface ParsedKeyChord {
  readonly rawKey: string;
  readonly keyCode: string;
  readonly character: string | null;
  readonly modifiers: readonly TrustedInputModifier[];
}

function keyCharacter(rawKey: string, modifiers: readonly TrustedInputModifier[]): string | null {
  const hasTextBlockingModifier = modifiers.some(
    (modifier) => modifier === "Alt" || modifier === "Control" || modifier === "Meta",
  );
  if (hasTextBlockingModifier) {
    return null;
  }
  if (rawKey === "Space") {
    return " ";
  }
  if (rawKey.length !== 1) {
    return null;
  }
  return modifiers.includes("Shift") ? rawKey.toUpperCase() : rawKey;
}

function parseKeyChord(chord: string): ParsedKeyChord {
  const parts = chord.split("+");
  const rawKey = parts.pop() ?? "";
  let modifiers = parts as TrustedInputModifier[];
  // Agents overwhelmingly use the documented Control+A chord as a portable
  // select-all intention. Chromium follows macOS native editing semantics,
  // where the equivalent accelerator is Meta+A; keep all other explicit
  // Control chords literal so web-app shortcuts retain their platform meaning.
  if (
    process.platform === "darwin" &&
    rawKey.toLowerCase() === "a" &&
    modifiers.length === 1 &&
    modifiers[0] === "Control"
  ) {
    modifiers = ["Meta"];
  }
  const keyCode = KEY_CODE_ALIASES[rawKey] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  return {
    rawKey,
    keyCode,
    character: keyCharacter(rawKey, modifiers),
    modifiers,
  };
}

const expectedKeySignal = (key: ParsedKeyChord): BrowserAutomationExpectedInput => ({
  kind: "key",
  key: key.rawKey === "Space" ? " " : key.rawKey,
  alt: key.modifiers.includes("Alt"),
  control: key.modifiers.includes("Control"),
  meta: key.modifiers.includes("Meta"),
  shift: key.modifiers.includes("Shift"),
});

const SELECT_ALL_IN_ACTIVE_EDITABLE = String.raw`(() => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    try { active.select(); return true; } catch { return false; }
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(active);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
})()`;

const isolatedKeyEvent = (
  type: IsolatedKeyboardInputEvent["type"],
  keyCode: string,
  modifiers: ParsedKeyChord["modifiers"],
): IsolatedKeyboardInputEvent => ({
  type,
  keyCode,
  modifiers: modifiers.map((modifier) => ELECTRON_MODIFIERS[modifier]),
  skipIfUnhandled: true,
});

export const withTrustedGuestFocus = async <T>(
  runtime: BrowserAutomationVisibleRuntime,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  throwIfAborted(signal);
  const previouslyFocused = electronWebContents.getFocusedWebContents();
  runtime.webContents.focus();
  await sendCdpCommand(runtime, "Page.bringToFront", {}, signal);
  await sendCdpCommand(runtime, "Emulation.setFocusEmulationEnabled", { enabled: true }, signal);
  try {
    return await operation();
  } finally {
    try {
      if (!runtime.webContents.isDestroyed()) {
        await sendCdpCommand(runtime, "Emulation.setFocusEmulationEnabled", { enabled: false });
      }
    } catch {
      // Focus cleanup is best-effort if the click navigated or closed the tab.
    }
    if (
      previouslyFocused &&
      previouslyFocused.id !== runtime.webContents.id &&
      !previouslyFocused.isDestroyed()
    ) {
      previouslyFocused.focus();
    }
  }
};

export const dispatchTrustedKeySequence = async (
  runtime: BrowserAutomationVisibleRuntime,
  chords: readonly string[],
  signal?: AbortSignal,
): Promise<void> =>
  withTrustedGuestFocus(
    runtime,
    async () => {
      for (const chord of chords) {
        throwIfAborted(signal);
        const key = parseKeyChord(chord);
        const releaseExpected = expectInput(runtime, expectedKeySignal(key));
        let downTransport: "cdp" | "native" | null = null;
        const selectAll =
          key.rawKey.toLowerCase() === "a" &&
          key.modifiers.length === 1 &&
          (key.modifiers[0] === "Control" || key.modifiers[0] === "Meta");
        try {
          if (selectAll) {
            // The guest's native shortcut mapping is platform/focus dependent for
            // embedded WebViews. CDP's editor command is scoped to this exact page
            // and deterministically applies the documented portable Control+A.
            await dispatchInputCommand(
              runtime,
              "Runtime.evaluate",
              {
                expression: SELECT_ALL_IN_ACTIVE_EDITABLE,
                awaitPromise: false,
                returnByValue: true,
                userGesture: true,
                generatePreview: false,
              },
              signal,
            );
            await dispatchInputCommand(
              runtime,
              "Input.dispatchKeyEvent",
              {
                type: "rawKeyDown",
                modifiers: modifierMask(key.modifiers),
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                nativeVirtualKeyCode: 65,
                commands: ["selectAll"],
              },
              signal,
            );
            downTransport = "cdp";
          } else {
            runtime.webContents.sendInputEvent(
              isolatedKeyEvent("keyDown", key.keyCode, key.modifiers),
            );
            downTransport = "native";
            if (key.character !== null) {
              runtime.webContents.sendInputEvent(
                isolatedKeyEvent("char", key.character, key.modifiers),
              );
            }
          }
        } finally {
          if (downTransport && !runtime.webContents.isDestroyed()) {
            if (downTransport === "cdp") {
              try {
                await runtime.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
                  type: "keyUp",
                  modifiers: modifierMask(key.modifiers),
                  key: "a",
                  code: "KeyA",
                  windowsVirtualKeyCode: 65,
                  nativeVirtualKeyCode: 65,
                });
              } catch {
                // The guest may have navigated or closed after the editing command.
              }
            } else {
              runtime.webContents.sendInputEvent(
                isolatedKeyEvent("keyUp", key.keyCode, key.modifiers),
              );
            }
          }
          releaseExpected();
        }
      }
    },
    signal,
  );
