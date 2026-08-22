// FILE: DevicePanel.tsx
// Purpose: Interactive iOS Simulator dock pane — live video, input injection, device picker, setup states.
// Layer: Right-dock pane component
// Depends on: deviceStateStore, nativeApi device namespace, useDeviceVideoStream, DevicePanel.logic
//
// Unlike BrowserPanel there is no native view to position: the simulator paints
// into a canvas we own, so no bounds sync or occlusion machinery is needed.

import type {
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceUdid,
  ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { addWsTransportStateListener } from "~/wsTransportEvents";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { selectThreadDeviceState, useDeviceStateStore } from "../deviceStateStore";
import {
  buildDevicePickerEntries,
  canvasPointToDevicePoint,
  createDeviceRecordingState,
  deviceAttachStatusLabel,
  deviceHidUsageForKey,
  deviceKeyModifiers,
  deviceRecordingClickIntent,
  deviceSetupCheckingLabel,
  isDeviceRecordingActive,
  resolveDeviceAvailabilityView,
  resolveDisplayedDevice,
  type PendingDeviceSelection,
  resolveDeviceHardwareButtonShortcut,
  resolveDevicePointerGesture,
  resolveDevicePointSize,
  resolveDeviceSetupAction,
  shouldSubscribeToDeviceStream,
  stepDeviceRecording,
  type DevicePoint,
} from "./DevicePanel.logic";
import { DeviceScreen, deviceKindFor, RESOLUTION_SCALE } from "./device/DeviceFrame";
import {
  DEVICE_RAIL_HEIGHT_CLASS,
  DeviceControlRail,
  type DeviceRailAction,
} from "./device/DeviceControlRail";
import {
  DeviceBootingScreen,
  DeviceEmptyScreen,
  DeviceSetupScreen,
} from "./device/DeviceScreenStates";
import { useDeviceVideoStream } from "./device/useDeviceVideoStream";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
// The plain manager, not the anchored one: anchored toasts are dropped unless
// they carry `positionerProps.anchor`, so every notification this pane raised —
// save confirmations and input errors alike — was silently discarded.
import { toastManager } from "./ui/toast";

/**
 * How often the pane re-reads setup state while the checklist is up.
 *
 * Installing Xcode takes many minutes, so this only has to be faster than a
 * person's patience, not fast. It stops the moment setup completes.
 */
const DEVICE_SETUP_POLL_INTERVAL_MS = 5_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export default function DevicePanel(props: {
  mode: DiffPanelMode;
  threadId: ThreadId;
  runtimeMode: DockPaneRuntimeMode;
  isVisible: boolean;
  onClosePanel: () => void;
  onRequestLive?: () => void;
}) {
  const { threadId, runtimeMode, isVisible } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const threadState = useDeviceStateStore(selectThreadDeviceState(threadId));
  const upsertThreadState = useDeviceStateStore((store) => store.upsertThreadState);
  const [busy, setBusy] = useState(false);
  const [shutdownConfirm, setShutdownConfirm] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const [bootLimit, setBootLimit] = useState<{
    readonly limit: number;
    readonly candidates: readonly DeviceDescriptor[];
    /** Retried automatically once the user frees a slot. */
    readonly pendingUdid: DeviceUdid;
    /** Named in the dialog, so the trade being offered is concrete. */
    readonly pendingName: string;
  } | null>(null);

  // The device the user just picked, shown until the server's thread state
  // names it. Without this the picker read "Choose a simulator" and the screen
  // stayed blank for the whole of a cold boot, so the click looked ignored.
  const [pendingDevice, setPendingDevice] = useState<PendingDeviceSelection | null>(null);
  const attachedDevice = resolveDisplayedDevice({ threadState, pending: pendingDevice });
  const availabilityView = resolveDeviceAvailabilityView(
    threadState?.availability ?? { kind: "available" },
  );

  // The server has answered — with this device or another — so the optimistic
  // one has done its job and the thread state takes over from here.
  const reportedUdid = threadState?.attachedDeviceUdid ?? null;
  useEffect(() => {
    setPendingDevice((current) =>
      current && reportedUdid !== current.supersedes ? null : current,
    );
  }, [reportedUdid]);

  // A stable primitive rather than the view object: the effect below depends on
  // it, and a fresh object each render would tear down and restart the poll.
  const pollSetupState =
    availabilityView.kind === "blocked" && availabilityView.retryable ? "blocked" : null;

  // The pane is the only reader of this thread's device state, so it seeds the
  // store on mount; every later change arrives on the device.event push.
  //
  // Re-seeded whenever the socket comes back, because that push carries no
  // snapshot: a boot, attach or shutdown that completed while the browser was
  // disconnected is simply missed, and the pane would sit on the pre-outage
  // phase and device list until some unrelated device event arrived.
  useEffect(() => {
    let cancelled = false;
    const seed = () => {
      void ensureNativeApi()
        .device.getThreadState({ threadId })
        .then((state) => {
          if (!cancelled) upsertThreadState(state);
        })
        .catch(() => {
          // A refusal here is the off-macOS / no-engine case; the pane keeps
          // rendering its blocked state from whatever availability it has.
        });
    };
    seed();
    const unsubscribe = addWsTransportStateListener((state) => {
      if (state === "open") seed();
    });
    // Setup progress is the one state nothing pushes. Installing Xcode,
    // accepting its licence or downloading a runtime all happen outside Synara
    // and raise no device event, so a pane opened on the checklist would sit on
    // a stale list and a spinner forever on a perfectly healthy connection.
    // Polling only while the checklist is up and retryable, and only every few
    // seconds, costs nothing once the environment is ready.
    const poll = pollSetupState !== null ? setInterval(seed, DEVICE_SETUP_POLL_INTERVAL_MS) : null;
    return () => {
      cancelled = true;
      unsubscribe();
      if (poll !== null) clearInterval(poll);
    };
  }, [threadId, upsertThreadState, pollSetupState]);

  // Non-null while the attachment is still coming up, and names which stage: a
  // cold boot spends most of a minute here, and "Starting up…" versus "Waiting
  // for the screen…" is the difference between progress and a hang.
  const attachStatusLabel = attachedDevice
    ? deviceAttachStatusLabel({
        phase: threadState?.attachPhase,
        deviceState: attachedDevice.state,
        pendingSelection: pendingDevice !== null,
      })
    : null;

  const streamEnabled = shouldSubscribeToDeviceStream({
    runtimeMode,
    isVisible,
    attachedDevice,
  });

  // Resync is owned by the frame socket, not this component: `device.attach` on
  // an already-attached device early-returns server-side, so it could never
  // have recovered a frozen canvas.
  const { status: videoStatus, dimensions } = useDeviceVideoStream({
    canvasRef,
    udid: streamEnabled && attachedDevice ? attachedDevice.udid : null,
    enabled: streamEnabled,
  });

  const pickerEntries = useMemo(
    () =>
      buildDevicePickerEntries({
        devices: threadState?.devices ?? [],
        attachedDeviceUdid: threadState?.attachedDeviceUdid ?? null,
      }),
    [threadState?.devices, threadState?.attachedDeviceUdid],
  );

  const runDeviceAction = useCallback(async (action: () => Promise<void>, failureTitle: string) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: errorMessage(error, "The simulator did not respond."),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const attachDevice = useCallback(
    async (udid: DeviceUdid) => {
      const api = ensureNativeApi();
      upsertThreadState(await api.device.attach({ threadId, udid }));
    },
    [threadId, upsertThreadState],
  );

  const selectDevice = useCallback(
    (entry: (typeof pickerEntries)[number]) => {
      const udid = entry.device.udid;
      if (entry.action.kind === "wait") return;
      // Set before the first await: the whole point is that the picker and the
      // screen change on the click, not when a minute-long boot resolves.
      setPendingDevice({ device: entry.device, supersedes: reportedUdid });
      void runDeviceAction(async () => {
        try {
          if (entry.action.kind === "boot-then-attach") {
            const result = await ensureNativeApi().device.boot({ udid });
            if (result.kind === "boot-limit-reached") {
              // A refusal, not a failure: hand the user the devices they can
              // free instead of a dead end.
              setPendingDevice(null);
              setBootLimit({
                limit: result.limit,
                candidates: result.synaraBooted,
                pendingUdid: udid,
                pendingName: entry.device.name,
              });
              return;
            }
          }
          await attachDevice(udid);
        } catch (error) {
          // The optimistic device would otherwise outlive the failure and leave
          // the pane naming a simulator it never opened.
          setPendingDevice(null);
          throw error;
        }
      }, "Could not open that simulator");
    },
    [attachDevice, reportedUdid, runDeviceAction],
  );

  const shutdownForBootLimit = useCallback(
    (candidate: DeviceDescriptor) => {
      const pending = bootLimit;
      setBootLimit(null);
      if (!pending) return;
      const requested = threadState?.devices.find((device) => device.udid === pending.pendingUdid);
      // Freeing a slot is the second half of a selection, so the pane commits
      // to the device here too rather than going blank until the boot lands.
      if (requested) setPendingDevice({ device: requested, supersedes: reportedUdid });
      void runDeviceAction(async () => {
        try {
          const api = ensureNativeApi();
          await api.device.shutdown({ udid: candidate.udid });
          const result = await api.device.boot({ udid: pending.pendingUdid });
          if (result.kind === "boot-limit-reached") {
            setPendingDevice(null);
            setBootLimit({ ...pending, limit: result.limit, candidates: result.synaraBooted });
            return;
          }
          await attachDevice(pending.pendingUdid);
        } catch (error) {
          setPendingDevice(null);
          throw error;
        }
      }, "Could not free a simulator slot");
    },
    [attachDevice, bootLimit, reportedUdid, runDeviceAction, threadState?.devices],
  );

  const detachDevice = useCallback(() => {
    setPendingDevice(null);
    void runDeviceAction(async () => {
      upsertThreadState(await ensureNativeApi().device.detach({ threadId }));
    }, "Could not detach the simulator");
  }, [runDeviceAction, threadId, upsertThreadState]);

  const shutdownAttached = useCallback(() => {
    if (!attachedDevice) return;
    void runDeviceAction(async () => {
      await ensureNativeApi().device.shutdown({ udid: attachedDevice.udid });
    }, "Could not shut down the simulator");
  }, [attachedDevice, runDeviceAction]);

  const pressButton = useCallback(
    (button: DeviceHardwareButton) => {
      if (!attachedDevice) return;
      void runDeviceAction(async () => {
        await ensureNativeApi().device.pressButton({ udid: attachedDevice.udid, button });
      }, "Could not press that button");
    },
    [attachedDevice, runDeviceAction],
  );

  // ── Recording ──────────────────────────────────────────────────────

  const [recording, setRecording] = useState(createDeviceRecordingState);

  // A recording belongs to the device it was started on. When that device goes
  // away the server has already stopped and finalised the file, so the pane
  // drops its state rather than leaving a red button no click can clear.
  useEffect(() => {
    if (attachedDevice?.state === "booted") return;
    setRecording((state) => stepDeviceRecording(state, { kind: "device-lost" }));
  }, [attachedDevice?.state]);

  const toggleRecording = useCallback(() => {
    if (!attachedDevice) return;
    const intent = deviceRecordingClickIntent(recording);
    if (!intent) return;
    const udid = attachedDevice.udid;
    const api = ensureNativeApi();

    if (intent === "start") {
      setRecording((state) => stepDeviceRecording(state, { kind: "start-requested" }));
      void api.device
        .startRecording({ udid })
        .then((result) => {
          setRecording((state) =>
            stepDeviceRecording(state, {
              kind: "started",
              path: result.path,
              startedAtMs: Date.parse(result.startedAt),
            }),
          );
        })
        .catch((error: unknown) => {
          setRecording((state) => stepDeviceRecording(state, { kind: "failed" }));
          toastManager.add({
            type: "error",
            title: "Could not start recording",
            description: errorMessage(error, "The simulator did not start recording."),
          });
        });
      return;
    }

    setRecording((state) => stepDeviceRecording(state, { kind: "stop-requested" }));
    void api.device
      .stopRecording({ udid })
      .then((result) => {
        setRecording((state) => stepDeviceRecording(state, { kind: "stopped" }));
        toastManager.add({
          type: "success",
          title: "Recording saved",
          description: result.path,
          data: { copyText: result.path },
        });
      })
      .catch((error: unknown) => {
        setRecording((state) => stepDeviceRecording(state, { kind: "failed" }));
        toastManager.add({
          type: "error",
          title: "Could not stop recording",
          description: errorMessage(error, "The recording may be incomplete."),
        });
      });
  }, [attachedDevice, recording]);

  const saveScreenshot = useCallback(() => {
    if (!attachedDevice) return;
    void runDeviceAction(async () => {
      // Saved by the server, beside the screen recordings. This used to hand
      // the base64 to a browser download, which put the PNG wherever the
      // browser chose — or nowhere at all where downloads are unavailable —
      // while the record button wrote to the Desktop. Two capture buttons on
      // one rail have to leave their output in the same place.
      const shot = await ensureNativeApi().device.screenshot({
        udid: attachedDevice.udid,
        save: true,
      });
      // `copyText` both expands the toast past its compact form — which shows
      // only the title — and puts the path on the clipboard, which is the one
      // thing you want after saving a file somewhere.
      toastManager.add({
        type: "success",
        title: "Screenshot saved",
        description: shot.path ?? shot.name,
        ...(shot.path ? { data: { copyText: shot.path } } : {}),
      });
    }, "Could not save the screenshot");
  }, [attachedDevice, runDeviceAction]);

  // ── Pointer input ──────────────────────────────────────────────────

  const pressRef = useRef<{ point: DevicePoint | null; startedAt: number } | null>(null);

  // The accessibility tree's root frame is the device's screen in points, which
  // is the unit the backend injects input in. Frames arrive in pixels (3x on a
  // Retina phone), so without this the pane sends coordinates triple their true
  // value and every tap lands off-screen, where the helper clamps it silently.
  const [measuredPointSize, setMeasuredPointSize] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const attachedUdid = attachedDevice?.udid ?? null;

  // Only a fallback: when the descriptor carries geometry, resolveDevicePointSize
  // prefers it and this round trip would be spent on a value we discard.
  const needsMeasuredPointSize = attachedDevice?.geometry === undefined;

  useEffect(() => {
    setMeasuredPointSize(null);
    if (!attachedUdid || attachedDevice?.state !== "booted" || !needsMeasuredPointSize) return;
    let cancelled = false;
    void ensureNativeApi()
      .device.describeUi({ udid: attachedUdid })
      .then((result) => {
        if (cancelled) return;
        const { width, height } = result.root.frame;
        if (width > 0 && height > 0) setMeasuredPointSize({ width, height });
      })
      .catch(() => {
        // Accessibility can be degraded while streaming and input still work;
        // the inferred scale below keeps taps landing in that case.
      });
    return () => {
      cancelled = true;
    };
  }, [attachedUdid, attachedDevice?.state, needsMeasuredPointSize]);

  const devicePointSize = resolveDevicePointSize({
    framePixelWidth: dimensions?.width ?? 0,
    framePixelHeight: dimensions?.height ?? 0,
    geometry: attachedDevice?.geometry,
    measured: measuredPointSize,
  });

  // The frame is drawn in device pixels. Derived from the point size rather
  // than the stream's frame dimensions so the chassis keeps its shape before
  // the first frame arrives and across stream restarts.
  const deviceKind = attachedDevice ? deviceKindFor(attachedDevice) : "iPhone";
  const deviceScale = attachedDevice?.geometry?.scale ?? RESOLUTION_SCALE[deviceKind];
  const devicePixelSize = devicePointSize
    ? {
        width: Math.round(devicePointSize.width * deviceScale),
        height: Math.round(devicePointSize.height * deviceScale),
      }
    : null;

  const pointFromEvent = useCallback(
    (event: { offsetX: number; offsetY: number }): DevicePoint | null => {
      const canvas = canvasRef.current;
      if (!canvas || !dimensions) return null;
      const pointSize = resolveDevicePointSize({
        framePixelWidth: dimensions.width,
        framePixelHeight: dimensions.height,
        geometry: attachedDevice?.geometry,
        measured: measuredPointSize,
      });
      // offsetX/offsetY rather than clientX minus the bounding rect: the canvas
      // may be rotated for landscape, and offsets are reported in the target's
      // own pre-transform box, so this needs no inverse rotation while the
      // bounding rect would.
      return canvasPointToDevicePoint(
        {
          frameWidth: dimensions.width,
          frameHeight: dimensions.height,
          displayWidth: canvas.clientWidth,
          displayHeight: canvas.clientHeight,
          ...(pointSize
            ? { devicePointWidth: pointSize.width, devicePointHeight: pointSize.height }
            : {}),
        },
        event.offsetX,
        event.offsetY,
      );
    },
    [dimensions, measuredPointSize, attachedDevice?.geometry],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!attachedDevice) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      // Focus on press so keyboard passthrough follows the click without a
      // separate tab stop.
      event.currentTarget.focus();
      pressRef.current = { point: pointFromEvent(event.nativeEvent), startedAt: performance.now() };
    },
    [attachedDevice, pointFromEvent],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press || !attachedDevice) return;
      event.currentTarget.releasePointerCapture(event.pointerId);

      const gesture = resolveDevicePointerGesture({
        from: press.point,
        to: pointFromEvent(event.nativeEvent),
        durationMs: performance.now() - press.startedAt,
      });
      if (!gesture) return;

      const api = ensureNativeApi();
      const udid = attachedDevice.udid;
      const sent =
        gesture.kind === "tap"
          ? api.device.tap({ udid, x: gesture.point.x, y: gesture.point.y })
          : api.device.swipe({
              udid,
              fromX: gesture.from.x,
              fromY: gesture.from.y,
              toX: gesture.to.x,
              toY: gesture.to.y,
              durationMs: gesture.durationMs,
            });
      void sent.catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "The simulator did not accept that input",
          description: errorMessage(error, "The input could not be delivered."),
        });
      });
    },
    [attachedDevice, pointFromEvent],
  );

  // ── Keyboard passthrough ───────────────────────────────────────────

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>, direction: "down" | "up") => {
      if (!attachedDevice) return;

      const hardwareButton = resolveDeviceHardwareButtonShortcut(event);
      if (hardwareButton) {
        event.preventDefault();
        // Fire once per chord, on the way down.
        if (direction === "down") pressButton(hardwareButton);
        return;
      }
      // Every other Cmd chord belongs to Synara (Cmd+W, Cmd+R, the dock
      // shortcuts), so it is deliberately not injected.
      if (event.metaKey || event.ctrlKey) return;

      const keyCode = deviceHidUsageForKey(event.key);
      if (keyCode === null) return;
      event.preventDefault();
      void ensureNativeApi()
        .device.keyEvent({
          udid: attachedDevice.udid,
          keyCode,
          modifiers: deviceKeyModifiers(event),
          direction,
        })
        .catch(() => {
          // Dropping a keystroke is preferable to a toast per key; a broken
          // input path already surfaces through the pointer handler.
        });
    },
    [attachedDevice, pressButton],
  );

  // ── Toolbar ────────────────────────────────────────────────────────

  const deviceControlsDisabled = !attachedDevice || attachedDevice.state !== "booted" || busy;

  const runRailAction = useCallback(
    (action: DeviceRailAction) => {
      switch (action) {
        case "home":
          pressButton("home");
          return;
        case "screenshot":
          saveScreenshot();
          return;
        case "record":
          toggleRecording();
          return;
        case "rotate":
          setLandscape((current) => !current);
          return;
        case "shutdown":
          setShutdownConfirm(true);
          return;
        case "detach":
          detachDevice();
      }
    },
    [detachDevice, pressButton, saveScreenshot, toggleRecording],
  );

  // ── Render ─────────────────────────────────────────────────────────

  // Nothing is selectable until the backend can list devices, so a blocked pane
  // shows the pane's name where the picker would be rather than a menu whose
  // every entry would be empty.
  const header = (
    <div className="flex h-full w-full min-w-0 items-center gap-1.5">
      {availabilityView.kind === "blocked" ? (
        <span className="truncate px-2 font-medium text-muted-foreground text-xs">
          iOS Simulator
        </span>
      ) : (
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="sm" className="min-w-0 gap-1" disabled={busy}>
                <span className="truncate">{attachedDevice?.name ?? "Choose a simulator"}</span>
                <ChevronDownIcon />
              </Button>
            }
          />
          <ComposerPickerMenuPopup align="start">
            {pickerEntries.length === 0 ? (
              <MenuItem disabled>No simulators found</MenuItem>
            ) : (
              pickerEntries.map((entry) => (
                <MenuItem
                  key={entry.device.udid}
                  disabled={entry.action.kind === "wait"}
                  onClick={() => selectDevice(entry)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{entry.device.name}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      {entry.detail}
                    </span>
                    {entry.attached ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                  </span>
                </MenuItem>
              ))
            )}
            {/* Detach and shut down live on the toolbar below the bezel, with
                the rest of the device actions, rather than being duplicated here. */}
          </ComposerPickerMenuPopup>
        </Menu>
      )}

      {/* Screenshot moved to the control rail, where it sits with the other
          device actions; the header keeps only picker and close. */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={props.onClosePanel}
          title="Close"
          aria-label="Close simulator panel"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );

  // Every state renders on the phone's screen, so the pane reads as one object
  // rather than a video rectangle with chrome stacked around it.
  const screen = (() => {
    if (availabilityView.kind === "blocked") {
      const action = resolveDeviceSetupAction(availabilityView.steps);
      return (
        <DeviceSetupScreen
          title={availabilityView.title}
          description={availabilityView.description}
          steps={availabilityView.steps}
          checkingLabel={
            availabilityView.retryable ? deviceSetupCheckingLabel(availabilityView.steps) : null
          }
          footnote={
            availabilityView.steps.length > 0
              ? "Xcode is a free download from Apple and needs about 10 GB of disk space."
              : null
          }
          action={
            action
              ? {
                  label: action.label,
                  onClick: () => {
                    void ensureNativeApi().shell.openExternal(action.url);
                  },
                }
              : null
          }
        />
      );
    }

    if (!attachedDevice) {
      return <DeviceEmptyScreen message="Choose a simulator to start streaming it here." />;
    }

    // Anything that is not yet a picture belongs on the boot screen, which
    // names the device: the canvas has nothing to paint, and a blank rectangle
    // for the length of a cold boot is what made the pane look broken.
    if (videoStatus.kind !== "streaming" && attachStatusLabel) {
      return <DeviceBootingScreen deviceName={attachedDevice.name} label={attachStatusLabel} />;
    }

    return (
      <>
        {/*
          biome-ignore lint/a11y/noNoninteractiveElementInteractions: the canvas
          is the device surface; pointer and key handlers are the feature.
        */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`${attachedDevice.name} screen`}
          // object-cover so the frame is filled edge to edge: the canvas already
          // carries the device's own aspect ratio, so nothing is actually cropped.
          className="h-full w-full object-cover outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring/70"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            pressRef.current = null;
          }}
          onKeyDown={(event) => handleKey(event, "down")}
          onKeyUp={(event) => handleKey(event, "up")}
        />
        {videoStatus.kind !== "streaming" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-[12%]">
            <DeviceVideoOverlay
              status={videoStatus}
              label={attachStatusLabel ?? "Connecting…"}
              runtimeMode={runtimeMode}
              {...(props.onRequestLive ? { onRequestLive: props.onRequestLive } : {})}
            />
          </div>
        ) : null}
        {/*
          A degraded capability is a notice, not a wall. As a chip on the screen
          it costs no layout and cannot push the phone around.
        */}
        {availabilityView.kind === "degraded" ? (
          <p
            role="status"
            className="absolute inset-x-[6%] top-[4%] rounded-full bg-black/70 px-2.5 py-1 text-center text-[9.5px] text-white/75 backdrop-blur-sm"
          >
            {availabilityView.notice}
          </p>
        ) : null}
      </>
    );
  })();

  return (
    <DiffPanelShell mode={props.mode} header={header}>
      {/*
        Phone and rail travel together as one group centered in the space
        between header and error row. The rail is balanced by an equal spacer
        above, so the *phone* reads as centered rather than the group — without
        it the device sits visibly high by half the rail's height.
      */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 py-3">
        <div aria-hidden className={DEVICE_RAIL_HEIGHT_CLASS} />
        <DeviceScreen
          className="min-h-0 w-full flex-1"
          kind={deviceKind}
          pixelWidth={devicePixelSize?.width}
          pixelHeight={devicePixelSize?.height}
          buttonsDisabled={deviceControlsDisabled}
          onPressButton={pressButton}
          landscape={landscape}
        >
          {screen}
        </DeviceScreen>
        {/*
          Above the device's shadow rather than beside it: the shadow bleeds
          past the frame, and a rail in normal flow cut a hard line across it.
        */}
        <div className="relative z-10">
          <DeviceControlRail
            disabled={deviceControlsDisabled}
            recording={isDeviceRecordingActive(recording)}
            landscape={landscape}
            onAction={runRailAction}
          />
        </div>
      </div>

      {/*
        Only errors the person watching can act on reach this row; the server
        keeps the agent's own recoverable tool failures out of thread state.

        Space is reserved rather than conditionally inserted: a message that
        appears and clears would otherwise resize the bezel's container on
        every transition. The row keeps its height always and only paints its
        rule and text when there is something to say.
      */}
      <p
        role="status"
        className={cn(
          "line-clamp-2 flex shrink-0 items-center px-3 text-destructive text-xs transition-opacity duration-220 motion-reduce:transition-none",
          threadState?.lastError
            ? "border-border border-t opacity-100"
            : "border-transparent border-t opacity-0",
        )}
        style={{ height: "1.875rem" }}
      >
        {threadState?.lastError ?? ""}
      </p>

      <DeviceBootLimitDialog
        state={bootLimit}
        deviceName={bootLimit?.pendingName ?? "that simulator"}
        onDismiss={() => setBootLimit(null)}
        onShutdown={shutdownForBootLimit}
      />

      {/*
        Shutting down loses whatever is running on the device — an app mid-flow,
        a build the agent just installed — and booting it back takes a minute,
        so it asks first, the way every other destructive action here does.
      */}
      <AlertDialog open={shutdownConfirm} onOpenChange={setShutdownConfirm}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Shut down {attachedDevice?.name ?? "this simulator"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Anything running on the simulator closes. Booting it again takes about a minute.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setShutdownConfirm(false);
                shutdownAttached();
              }}
            >
              Shut down
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </DiffPanelShell>
  );
}

function DeviceVideoOverlay(props: {
  status: ReturnType<typeof useDeviceVideoStream>["status"];
  /** What the pane is waiting on, from the server's attach phase. */
  label: string;
  runtimeMode: DockPaneRuntimeMode;
  onRequestLive?: () => void;
}) {
  const { status } = props;

  if (props.runtimeMode === "preview") {
    return (
      <button
        type="button"
        className="pointer-events-auto rounded-full bg-white/95 px-3 py-1.5 font-medium text-[10px] text-black"
        onClick={props.onRequestLive}
      >
        Show the live simulator
      </button>
    );
  }

  if (status.kind === "unsupported") {
    return (
      <p className="text-balance text-center text-[10px] text-white/70 leading-snug">
        This browser cannot decode the simulator stream. Chrome, Edge, or Safari 17+ support the
        WebCodecs video decoder Synara uses.
      </p>
    );
  }

  if (status.kind === "error") {
    return (
      <p className="text-balance text-center text-[10px] text-white/70 leading-snug">
        {status.message}
      </p>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-[10px] text-white/45">
      <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />
      {props.label}
    </span>
  );
}

function DeviceBootLimitDialog(props: {
  state: {
    readonly limit: number;
    readonly candidates: readonly DeviceDescriptor[];
  } | null;
  /** The simulator the user asked for, named so the trade is concrete. */
  deviceName: string;
  onDismiss: () => void;
  onShutdown: (candidate: DeviceDescriptor) => void;
}) {
  const { state } = props;

  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : props.onDismiss())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Shut down a simulator to start {props.deviceName}</DialogTitle>
          {/*
            The cap is about memory, and saying so is what makes it read as a
            guardrail rather than an arbitrary refusal. The consequence of the
            click is spelled out too: these are the user's running simulators,
            and one of them is about to lose whatever is on it.
          */}
          <DialogDescription>
            Synara keeps at most {state?.limit ?? 0} simulators running at once, because each one
            holds a few gigabytes of memory. Pick one to shut down — anything running on it closes —
            and {props.deviceName} starts in its place.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1">
          {(state?.candidates ?? []).map((candidate) => (
            <li key={candidate.udid}>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between"
                onClick={() => props.onShutdown(candidate)}
              >
                <span className="truncate">Shut down {candidate.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs">{candidate.runtime}</span>
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={props.onDismiss}>
            Keep them all running
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
