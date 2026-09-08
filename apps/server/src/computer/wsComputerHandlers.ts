/** WebSocket handlers for the Linux computer RPC group. */
import {
  COMPUTER_WS_METHODS,
  type ComputerActionResult,
  type ComputerClickInput,
  type ComputerDoubleClickInput,
  type ComputerDragInput,
  type ComputerGetScreenSizeInput,
  type ComputerGetScreenSizeResult,
  type ComputerGetStateInput,
  type ComputerGetStatusInput,
  type ComputerHotkeyInput,
  type ComputerInputClickInput,
  type ComputerInputKeyInput,
  type ComputerInputScrollInput,
  type ComputerLaunchAppInput,
  type ComputerLaunchAppResult,
  type ComputerListWindowsInput,
  type ComputerListWindowsResult,
  type ComputerMoveCursorInput,
  type ComputerPerformActionInput,
  type ComputerPressKeyInput,
  type ComputerProvisionInput,
  type ComputerProvisionResult,
  type ComputerRightClickInput,
  type ComputerScrollInput,
  type ComputerSetValueInput,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerThreadInput,
  type ComputerTypeTextInput,
  type ThreadComputerState,
  WsRpcError,
} from "@synara/contracts";
import { Effect } from "effect";

import { NO_COMPUTER_CAPABILITIES } from "./ComputerBackend.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import type { ComputerServiceShape } from "./Services/ComputerService.ts";

/**
 * Shown only when no computer service started at all, so it cannot name the
 * missing piece the way a live backend's `availability()` does — a backend that
 * exists always reports its own reason, and this is the case where there is no
 * backend to ask. It therefore names the requirement every tier shares rather
 * than any one tier's dependencies.
 */
const UNSUPPORTED_MESSAGE = "No computer backend is available on this server.";

function unsupported<A>(): Effect.Effect<A, WsRpcError> {
  return Effect.fail(new WsRpcError({ message: UNSUPPORTED_MESSAGE }));
}

function attempt<A>(
  promise: () => Promise<A>,
  fallbackMessage: string,
): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: promise,
    catch: (cause) =>
      new WsRpcError({
        message: cause instanceof Error && cause.message ? cause.message : fallbackMessage,
      }),
  });
}

export interface WsComputerHandlers {
  readonly [COMPUTER_WS_METHODS.getStatus]: (
    input: ComputerGetStatusInput,
  ) => Effect.Effect<ComputerStatusResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.provision]: (
    input: ComputerProvisionInput,
  ) => Effect.Effect<ComputerProvisionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.listWindows]: (
    input: ComputerListWindowsInput,
  ) => Effect.Effect<ComputerListWindowsResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.getState]: (
    input: ComputerGetStateInput,
  ) => Effect.Effect<ComputerState, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.getScreenSize]: (
    input: ComputerGetScreenSizeInput,
  ) => Effect.Effect<ComputerGetScreenSizeResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.launchApp]: (
    input: ComputerLaunchAppInput,
  ) => Effect.Effect<ComputerLaunchAppResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.click]: (
    input: ComputerClickInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.doubleClick]: (
    input: ComputerDoubleClickInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.rightClick]: (
    input: ComputerRightClickInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.moveCursor]: (
    input: ComputerMoveCursorInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.drag]: (
    input: ComputerDragInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.scroll]: (
    input: ComputerScrollInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.typeText]: (
    input: ComputerTypeTextInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.pressKey]: (
    input: ComputerPressKeyInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.hotkey]: (
    input: ComputerHotkeyInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.setValue]: (
    input: ComputerSetValueInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.performAction]: (
    input: ComputerPerformActionInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.getThreadState]: (
    input: ComputerThreadInput,
  ) => Effect.Effect<ThreadComputerState, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.inputClick]: (
    input: ComputerInputClickInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.inputScroll]: (
    input: ComputerInputScrollInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
  readonly [COMPUTER_WS_METHODS.inputKey]: (
    input: ComputerInputKeyInput,
  ) => Effect.Effect<ComputerActionResult, WsRpcError>;
}

export function makeWsComputerHandlers(
  computerService: ComputerServiceShape | undefined,
): WsComputerHandlers {
  if (!computerService?.supported) {
    const unsupportedStatus = {
      computerId: computerService?.manager.computerId ?? "desktop",
      availability: computerService?.availability ?? {
        kind: "backend-unavailable" as const,
        message: UNSUPPORTED_MESSAGE,
      },
      // Nothing supervises a backend that was never started, so the health
      // of one is permanently the boot-time verdict.
      health: {
        status: "unavailable" as const,
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: false,
      },
      // A backend that was never started can do nothing, and saying so is
      // what keeps the panel's badges and the tool descriptions from
      // advertising a desktop this host has not got.
      capabilities: NO_COMPUTER_CAPABILITIES,
    } satisfies ComputerStatusResult;
    const unsupportedState = (input: ComputerThreadInput) =>
      attempt(async () => {
        return {
          ...unsupportedStatus,
          threadId: input.threadId,
          version: 0,
          windows: [],
          screenSize: { width: 1, height: 1 },
          agentActive: false,
          controlledByOtherThread: false,
          lastError: null,
        } satisfies ThreadComputerState;
      }, "Failed to read computer availability");
    return {
      [COMPUTER_WS_METHODS.getStatus]: () => Effect.succeed(unsupportedStatus),
      [COMPUTER_WS_METHODS.provision]: () => unsupported(),
      [COMPUTER_WS_METHODS.listWindows]: () => unsupported(),
      [COMPUTER_WS_METHODS.getState]: () => unsupported(),
      [COMPUTER_WS_METHODS.getScreenSize]: () => unsupported(),
      [COMPUTER_WS_METHODS.launchApp]: () => unsupported(),
      [COMPUTER_WS_METHODS.click]: () => unsupported(),
      [COMPUTER_WS_METHODS.doubleClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.rightClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.moveCursor]: () => unsupported(),
      [COMPUTER_WS_METHODS.drag]: () => unsupported(),
      [COMPUTER_WS_METHODS.scroll]: () => unsupported(),
      [COMPUTER_WS_METHODS.typeText]: () => unsupported(),
      [COMPUTER_WS_METHODS.pressKey]: () => unsupported(),
      [COMPUTER_WS_METHODS.hotkey]: () => unsupported(),
      [COMPUTER_WS_METHODS.setValue]: () => unsupported(),
      [COMPUTER_WS_METHODS.performAction]: () => unsupported(),
      [COMPUTER_WS_METHODS.getThreadState]: unsupportedState,
      [COMPUTER_WS_METHODS.inputClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.inputScroll]: () => unsupported(),
      [COMPUTER_WS_METHODS.inputKey]: () => unsupported(),
    };
  }

  const manager = computerService.manager;
  return {
    [COMPUTER_WS_METHODS.getStatus]: () =>
      attempt(() => manager.getStatus(), "Failed to read computer status"),
    [COMPUTER_WS_METHODS.provision]: () =>
      attempt(() => manager.provision(), "Failed to set up computer control"),
    [COMPUTER_WS_METHODS.listWindows]: () =>
      attempt(() => manager.listWindows(), "Failed to list computer windows"),
    [COMPUTER_WS_METHODS.getState]: (input) =>
      attempt(
        () =>
          manager.getState({
            ...(input.includeScreenshot !== undefined
              ? { includeScreenshot: input.includeScreenshot }
              : {}),
            ...(input.includeText !== undefined ? { includeText: input.includeText } : {}),
            ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
          }),
        "Failed to read computer perception state",
      ),
    [COMPUTER_WS_METHODS.getScreenSize]: () =>
      attempt(() => manager.getScreenSize(), "Failed to read computer screen size"),
    [COMPUTER_WS_METHODS.launchApp]: (input) =>
      attempt(
        () => manager.launchApp(undefined, input.app, input.arguments ?? []),
        "Failed to launch computer application",
      ),
    [COMPUTER_WS_METHODS.click]: (input) =>
      attempt(() => manager.click(undefined, input), "Failed to click on computer"),
    [COMPUTER_WS_METHODS.doubleClick]: (input) =>
      attempt(() => manager.doubleClick(undefined, input), "Failed to double-click on computer"),
    [COMPUTER_WS_METHODS.rightClick]: (input) =>
      attempt(() => manager.rightClick(undefined, input), "Failed to right-click on computer"),
    [COMPUTER_WS_METHODS.moveCursor]: (input) =>
      attempt(() => manager.moveCursor(undefined, input), "Failed to move computer cursor"),
    [COMPUTER_WS_METHODS.drag]: (input) =>
      attempt(
        () => manager.drag(undefined, input.from, input.to, input.durationMs ?? 250),
        "Failed to drag on computer",
      ),
    [COMPUTER_WS_METHODS.scroll]: (input) =>
      attempt(
        () => manager.scroll(undefined, scrollTarget(input), input.deltaX, input.deltaY),
        "Failed to scroll on computer",
      ),
    [COMPUTER_WS_METHODS.typeText]: (input) =>
      attempt(() => manager.typeText(undefined, input.text), "Failed to type on computer"),
    [COMPUTER_WS_METHODS.pressKey]: (input) =>
      attempt(() => manager.pressKey(undefined, input.key), "Failed to press computer key"),
    [COMPUTER_WS_METHODS.hotkey]: (input) =>
      attempt(() => manager.hotkey(undefined, input.keys), "Failed to send computer hotkey"),
    [COMPUTER_WS_METHODS.setValue]: (input) =>
      attempt(
        () => manager.setValue(undefined, input, input.value),
        "Failed to set computer value",
      ),
    [COMPUTER_WS_METHODS.performAction]: (input) =>
      attempt(
        () => manager.performAction(undefined, input, input.action),
        "Failed to perform computer action",
      ),
    [COMPUTER_WS_METHODS.getThreadState]: (input) =>
      attempt(() => manager.getThreadState(input.threadId), "Failed to read computer state"),
    [COMPUTER_WS_METHODS.inputClick]: (input) =>
      attempt(() => userInputClick(manager, input), "Failed to click on computer"),
    [COMPUTER_WS_METHODS.inputScroll]: (input) =>
      attempt(
        () => manager.scroll(undefined, { x: input.x, y: input.y }, input.deltaX, input.deltaY),
        "Failed to scroll on computer",
      ),
    [COMPUTER_WS_METHODS.inputKey]: (input) =>
      attempt(() => userInputKey(manager, input), "Failed to press computer key"),
  };
}

/**
 * A pane click carries a resolved desktop point, so it goes straight to the
 * coordinate path of the manager — no AT-SPI tree read, no semantic matching.
 */
function userInputClick(
  manager: ComputerManager,
  input: ComputerInputClickInput,
): Promise<ComputerActionResult> {
  const target = { x: input.x, y: input.y };
  if (input.button === "right") return manager.rightClick(undefined, target);
  return (input.clickCount ?? 1) >= 2
    ? manager.doubleClick(undefined, target)
    : manager.click(undefined, target);
}

function userInputKey(
  manager: ComputerManager,
  input: ComputerInputKeyInput,
): Promise<ComputerActionResult> {
  // A repeated modifier would be pressed twice and released twice, which reads
  // as a tap of that modifier on the way out of the chord.
  const modifiers = [...new Set(input.modifiers ?? [])];
  return modifiers.length === 0
    ? manager.pressKey(undefined, input.key)
    : manager.hotkey(undefined, [...modifiers, input.key]);
}

function scrollTarget(input: ComputerScrollInput) {
  const target = {
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
  };
  const hasTarget =
    target.x !== undefined ||
    target.y !== undefined ||
    target.label !== undefined ||
    target.role !== undefined ||
    target.windowId !== undefined;
  return hasTarget ? target : null;
}
