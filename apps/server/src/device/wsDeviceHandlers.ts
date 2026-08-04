/**
 * WebSocket handlers for the device RPC group.
 *
 * Kept out of `wsRpc.ts` because the device engine is optional and
 * platform-gated: this module answers all twenty methods whether or not a
 * backend exists, so the RPC group stays exhaustively handled everywhere and
 * off-macOS clients get one clear refusal instead of a transport error.
 *
 * @module device/wsDeviceHandlers
 */
import {
  DEVICE_WS_METHODS,
  ThreadId,
  WsRpcError,
  type DeviceAttachInput,
  type DeviceBootInput,
  type DeviceBootResult,
  type DeviceDescribeUiInput,
  type DeviceDescribeUiResult,
  type DeviceDetachInput,
  type DeviceInstallAppInput,
  type DeviceInstallAppResult,
  type DeviceKeyEventInput,
  type DeviceLaunchAppInput,
  type DeviceLaunchAppResult,
  type DeviceListInput,
  type DeviceListResult,
  type DeviceOpenUrlInput,
  type DevicePressButtonInput,
  type DeviceScreenshotInput,
  type DeviceScreenshotResult,
  type DeviceStartRecordingInput,
  type DeviceStartRecordingResult,
  type DeviceStopRecordingInput,
  type DeviceStopRecordingResult,
  type DeviceScrollToElementInput,
  type DeviceScrollToElementResult,
  type DeviceShutdownInput,
  type DeviceSwipeInput,
  type DeviceTapInput,
  type DeviceThreadInput,
  type DeviceTypeTextInput,
  type ThreadDeviceState,
} from "@synara/contracts";
import { Effect } from "effect";

import type { DeviceServiceShape } from "./Services/DeviceService.ts";
import { readTapRequest } from "./uiTreeTargeting.ts";

/** Shared by the pane (always a point) and agents (usually a label). */
async function tapFromInput(
  manager: DeviceServiceShape["manager"],
  input: DeviceTapInput,
): Promise<void> {
  const request = readTapRequest(input);
  if (request.kind === "point") {
    await manager.tap(input.udid, request.x, request.y);
    return;
  }
  await manager.tapElement(input.udid, request.target);
}

const UNSUPPORTED_MESSAGE =
  "The device pane requires macOS with Xcode and an iOS simulator runtime.";

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

export interface WsDeviceHandlers {
  readonly [DEVICE_WS_METHODS.list]: (
    input: DeviceListInput,
  ) => Effect.Effect<DeviceListResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.boot]: (
    input: DeviceBootInput,
  ) => Effect.Effect<DeviceBootResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.shutdown]: (
    input: DeviceShutdownInput,
  ) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.attach]: (
    input: DeviceAttachInput,
  ) => Effect.Effect<ThreadDeviceState, WsRpcError>;
  readonly [DEVICE_WS_METHODS.detach]: (
    input: DeviceDetachInput,
  ) => Effect.Effect<ThreadDeviceState, WsRpcError>;
  readonly [DEVICE_WS_METHODS.getThreadState]: (
    input: DeviceThreadInput,
  ) => Effect.Effect<ThreadDeviceState, WsRpcError>;
  readonly [DEVICE_WS_METHODS.tap]: (input: DeviceTapInput) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.swipe]: (input: DeviceSwipeInput) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.typeText]: (
    input: DeviceTypeTextInput,
  ) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.keyEvent]: (
    input: DeviceKeyEventInput,
  ) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.pressButton]: (
    input: DevicePressButtonInput,
  ) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.installApp]: (
    input: DeviceInstallAppInput,
  ) => Effect.Effect<DeviceInstallAppResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.launchApp]: (
    input: DeviceLaunchAppInput,
  ) => Effect.Effect<DeviceLaunchAppResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.openUrl]: (
    input: DeviceOpenUrlInput,
  ) => Effect.Effect<void, WsRpcError>;
  readonly [DEVICE_WS_METHODS.screenshot]: (
    input: DeviceScreenshotInput,
  ) => Effect.Effect<DeviceScreenshotResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.startRecording]: (
    input: DeviceStartRecordingInput,
  ) => Effect.Effect<DeviceStartRecordingResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.stopRecording]: (
    input: DeviceStopRecordingInput,
  ) => Effect.Effect<DeviceStopRecordingResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.scrollToElement]: (
    input: DeviceScrollToElementInput,
  ) => Effect.Effect<DeviceScrollToElementResult, WsRpcError>;
  readonly [DEVICE_WS_METHODS.describeUi]: (
    input: DeviceDescribeUiInput,
  ) => Effect.Effect<DeviceDescribeUiResult, WsRpcError>;
}

/**
 * Build the nineteen request handlers. The twentieth method
 * (`subscribeEvents`) is a stream and is wired in `wsRpc.ts` where the stream
 * admission guard lives.
 */
export function makeWsDeviceHandlers(
  deviceService: DeviceServiceShape | undefined,
): WsDeviceHandlers {
  if (!deviceService?.supported) {
    return {
      [DEVICE_WS_METHODS.list]: () => unsupported(),
      [DEVICE_WS_METHODS.boot]: () => unsupported(),
      [DEVICE_WS_METHODS.shutdown]: () => unsupported(),
      [DEVICE_WS_METHODS.attach]: () => unsupported(),
      [DEVICE_WS_METHODS.detach]: () => unsupported(),
      // The pane calls this on open to decide what to render, so it answers
      // with a real snapshot naming the unsupported platform rather than an
      // error the pane would have to translate.
      [DEVICE_WS_METHODS.getThreadState]: (input) =>
        Effect.succeed({
          threadId: input.threadId,
          version: 0,
          attachedDeviceUdid: null,
          devices: [],
          agentActive: false,
          availability: { kind: "unsupported-platform", platform: process.platform },
          lastError: null,
        } satisfies ThreadDeviceState),
      [DEVICE_WS_METHODS.tap]: () => unsupported(),
      [DEVICE_WS_METHODS.swipe]: () => unsupported(),
      [DEVICE_WS_METHODS.typeText]: () => unsupported(),
      [DEVICE_WS_METHODS.keyEvent]: () => unsupported(),
      [DEVICE_WS_METHODS.pressButton]: () => unsupported(),
      [DEVICE_WS_METHODS.installApp]: () => unsupported(),
      [DEVICE_WS_METHODS.launchApp]: () => unsupported(),
      [DEVICE_WS_METHODS.openUrl]: () => unsupported(),
      [DEVICE_WS_METHODS.screenshot]: () => unsupported(),
      [DEVICE_WS_METHODS.startRecording]: () => unsupported(),
      [DEVICE_WS_METHODS.stopRecording]: () => unsupported(),
      [DEVICE_WS_METHODS.describeUi]: () => unsupported(),
      [DEVICE_WS_METHODS.scrollToElement]: () => unsupported(),
    };
  }

  const manager = deviceService.manager;
  const threadState = (state: ThreadDeviceState): ThreadDeviceState => ({
    ...state,
    threadId: ThreadId.makeUnsafe(state.threadId),
  });

  return {
    [DEVICE_WS_METHODS.list]: (input) =>
      attempt(
        () => manager.list({ includeShutdown: input.includeShutdown ?? false }),
        "Failed to list devices",
      ),
    [DEVICE_WS_METHODS.boot]: (input) =>
      attempt(() => manager.boot(input.udid), "Failed to boot device"),
    [DEVICE_WS_METHODS.shutdown]: (input) =>
      attempt(() => manager.shutdown(input.udid), "Failed to shut down device"),
    [DEVICE_WS_METHODS.attach]: (input) =>
      attempt(
        () => manager.attach(input.threadId, input.udid).then(threadState),
        "Failed to attach device",
      ),
    [DEVICE_WS_METHODS.detach]: (input) =>
      attempt(() => manager.detach(input.threadId).then(threadState), "Failed to detach device"),
    [DEVICE_WS_METHODS.getThreadState]: (input) =>
      attempt(
        () => manager.getThreadState(input.threadId).then(threadState),
        "Failed to read device state",
      ),
    [DEVICE_WS_METHODS.tap]: (input) =>
      attempt(() => tapFromInput(manager, input), "Failed to tap device"),
    [DEVICE_WS_METHODS.swipe]: (input) =>
      attempt(
        () =>
          manager.swipe(input.udid, {
            fromX: input.fromX,
            fromY: input.fromY,
            toX: input.toX,
            toY: input.toY,
            durationMs: input.durationMs,
          }),
        "Failed to swipe on device",
      ),
    [DEVICE_WS_METHODS.typeText]: (input) =>
      attempt(() => manager.typeText(input.udid, input.text), "Failed to type on device"),
    [DEVICE_WS_METHODS.keyEvent]: (input) =>
      attempt(
        () =>
          manager.keyEvent(input.udid, {
            keyCode: input.keyCode,
            modifiers: input.modifiers,
            direction: input.direction,
          }),
        "Failed to send key event to device",
      ),
    [DEVICE_WS_METHODS.pressButton]: (input) =>
      attempt(
        () => manager.pressButton(input.udid, input.button),
        "Failed to press device hardware button",
      ),
    [DEVICE_WS_METHODS.installApp]: (input) =>
      attempt(() => manager.install(input.udid, input.appPath), "Failed to install app"),
    [DEVICE_WS_METHODS.launchApp]: (input) =>
      attempt(
        () => manager.launch(input.udid, input.bundleId, input.arguments),
        "Failed to launch app",
      ),
    [DEVICE_WS_METHODS.openUrl]: (input) =>
      attempt(() => manager.openUrl(input.udid, input.url), "Failed to open URL on device"),
    [DEVICE_WS_METHODS.screenshot]: (input) =>
      attempt(
        () => manager.screenshot(input.udid, { save: input.save ?? false }),
        "Failed to capture device screenshot",
      ),
    [DEVICE_WS_METHODS.startRecording]: (input) =>
      attempt(() => manager.startRecording(input.udid), "Failed to start device recording"),
    [DEVICE_WS_METHODS.stopRecording]: (input) =>
      attempt(() => manager.stopRecording(input.udid), "Failed to stop device recording"),
    [DEVICE_WS_METHODS.describeUi]: (input) =>
      attempt(() => manager.describeUi(input.udid), "Failed to read device accessibility tree"),
    [DEVICE_WS_METHODS.scrollToElement]: (input) =>
      attempt(async () => {
        const match = await manager.scrollToElement(
          input.udid,
          { label: input.label, role: input.role },
          { maxScrolls: input.maxSwipes },
        );
        return { udid: input.udid, element: match.node, tapPoint: match.point };
      }, "Failed to scroll to element"),
  };
}
