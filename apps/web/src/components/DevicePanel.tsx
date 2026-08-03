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
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, XIcon } from "~/lib/icons";

import { selectThreadDeviceState, useDeviceStateStore } from "../deviceStateStore";
import {
  attachedDeviceFromThreadState,
  buildDevicePickerEntries,
  canvasPointToDevicePoint,
  deviceHidUsageForKey,
  deviceKeyModifiers,
  deviceSetupCheckingLabel,
  resolveDeviceAvailabilityView,
  resolveDeviceHardwareButtonShortcut,
  resolveDevicePointerGesture,
  resolveDeviceSetupAction,
  shouldSubscribeToDeviceStream,
  type DevicePoint,
} from "./DevicePanel.logic";
import { DeviceBezel } from "./device/DeviceBezel";
import { DeviceControlRail } from "./device/DeviceControlRail";
import {
  DeviceAgentPill,
  DeviceBootingScreen,
  DeviceEmptyScreen,
  DeviceSetupScreen,
} from "./device/DeviceScreenStates";
import { useDeviceVideoStream } from "./device/useDeviceVideoStream";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { anchoredToastManager as toastManager } from "./ui/toast";

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
  const [bootLimit, setBootLimit] = useState<{
    readonly limit: number;
    readonly candidates: readonly DeviceDescriptor[];
    /** Retried automatically once the user frees a slot. */
    readonly pendingUdid: DeviceUdid;
  } | null>(null);

  const attachedDevice = attachedDeviceFromThreadState(threadState);
  const availabilityView = resolveDeviceAvailabilityView(
    threadState?.availability ?? { kind: "available" },
  );

  // The pane is the only reader of this thread's device state, so it seeds the
  // store on mount; every later change arrives on the device.event push.
  useEffect(() => {
    let cancelled = false;
    void ensureNativeApi()
      .device.getThreadState({ threadId })
      .then((state) => {
        if (!cancelled) upsertThreadState(state);
      })
      .catch(() => {
        // A refusal here is the off-macOS / no-engine case; the pane keeps
        // rendering its blocked state from whatever availability it has.
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, upsertThreadState]);

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
      void runDeviceAction(async () => {
        if (entry.action.kind === "wait") return;
        if (entry.action.kind === "boot-then-attach") {
          const result = await ensureNativeApi().device.boot({ udid });
          if (result.kind === "boot-limit-reached") {
            // A refusal, not a failure: hand the user the devices they can free
            // instead of a dead end.
            setBootLimit({
              limit: result.limit,
              candidates: result.synaraBooted,
              pendingUdid: udid,
            });
            return;
          }
        }
        await attachDevice(udid);
      }, "Could not open that simulator");
    },
    [attachDevice, runDeviceAction],
  );

  const shutdownForBootLimit = useCallback(
    (candidate: DeviceDescriptor) => {
      const pending = bootLimit?.pendingUdid;
      setBootLimit(null);
      if (!pending) return;
      void runDeviceAction(async () => {
        const api = ensureNativeApi();
        await api.device.shutdown({ udid: candidate.udid });
        const result = await api.device.boot({ udid: pending });
        if (result.kind === "boot-limit-reached") {
          setBootLimit({
            limit: result.limit,
            candidates: result.synaraBooted,
            pendingUdid: pending,
          });
          return;
        }
        await attachDevice(pending);
      }, "Could not free a simulator slot");
    },
    [attachDevice, bootLimit?.pendingUdid, runDeviceAction],
  );

  const detachDevice = useCallback(() => {
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

  const saveScreenshot = useCallback(() => {
    if (!attachedDevice) return;
    void runDeviceAction(async () => {
      const shot = await ensureNativeApi().device.screenshot({ udid: attachedDevice.udid });
      const bytes = Uint8Array.from(atob(shot.bytesBase64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: shot.mimeType }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = shot.name;
        link.click();
      } finally {
        // Revoke on the next task so the click's navigation has taken the URL.
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    }, "Could not save the screenshot");
  }, [attachedDevice, runDeviceAction]);

  // ── Pointer input ──────────────────────────────────────────────────

  const pressRef = useRef<{ point: DevicePoint | null; startedAt: number } | null>(null);

  const pointFromEvent = useCallback(
    (event: { clientX: number; clientY: number }): DevicePoint | null => {
      const canvas = canvasRef.current;
      if (!canvas || !dimensions) return null;
      const rect = canvas.getBoundingClientRect();
      return canvasPointToDevicePoint(
        {
          frameWidth: dimensions.width,
          frameHeight: dimensions.height,
          displayWidth: rect.width,
          displayHeight: rect.height,
        },
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    },
    [dimensions],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!attachedDevice) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      // Focus on press so keyboard passthrough follows the click without a
      // separate tab stop.
      event.currentTarget.focus();
      pressRef.current = { point: pointFromEvent(event), startedAt: performance.now() };
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
        to: pointFromEvent(event),
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
            {attachedDevice ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={detachDevice}>Detach</MenuItem>
                <MenuItem onClick={shutdownAttached}>Shut down {attachedDevice.name}</MenuItem>
              </>
            ) : null}
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

    if (videoStatus.kind !== "streaming" && attachedDevice.state === "booting") {
      return <DeviceBootingScreen deviceName={attachedDevice.name} label="Starting up…" />;
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
              deviceState={attachedDevice.state}
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
        Phone and rail travel together as one centered group, so the controls
        stay tucked under the device instead of drifting to the pane's floor
        whenever the bezel is width-bound and leaves vertical slack.
      */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-3 py-3">
        <DeviceBezel
          className="min-h-0 w-full flex-1"
          overlay={
            threadState?.agentActive ? <DeviceAgentPill label="Agent is using this device" /> : null
          }
        >
          {screen}
        </DeviceBezel>

        <DeviceControlRail
          disabled={!attachedDevice || attachedDevice.state !== "booted" || busy}
          onPressButton={pressButton}
          onScreenshot={saveScreenshot}
        />
      </div>

      {threadState?.lastError ? (
        <p className="shrink-0 border-t border-border px-3 py-1.5 text-destructive text-xs">
          {threadState.lastError}
        </p>
      ) : null}

      <DeviceBootLimitDialog
        state={bootLimit}
        onDismiss={() => setBootLimit(null)}
        onShutdown={shutdownForBootLimit}
      />
    </DiffPanelShell>
  );
}

function DeviceVideoOverlay(props: {
  status: ReturnType<typeof useDeviceVideoStream>["status"];
  deviceState: DeviceDescriptor["state"];
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
      {props.deviceState === "booting" ? "Starting up…" : "Connecting…"}
    </span>
  );
}

function DeviceBootLimitDialog(props: {
  state: {
    readonly limit: number;
    readonly candidates: readonly DeviceDescriptor[];
  } | null;
  onDismiss: () => void;
  onShutdown: (candidate: DeviceDescriptor) => void;
}) {
  const { state } = props;

  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : props.onDismiss())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Too many simulators are running</DialogTitle>
          <DialogDescription>
            Synara keeps at most {state?.limit ?? 0} simulators booted at once. Shut one down to
            start the one you picked.
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
                <span className="truncate">{candidate.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs">{candidate.runtime}</span>
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={props.onDismiss}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
