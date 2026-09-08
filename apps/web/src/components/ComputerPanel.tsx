import type { ComputerActionResult, ComputerScreenSize, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useComputerDesktopControl } from "~/hooks/useComputerDesktopControl";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import { useThreadComputerStateSeed } from "~/hooks/useThreadComputerStateSeed";
import { disclosureFadeClassName } from "~/lib/disclosureMotion";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { CursorClickIcon, LoaderCircleIcon, MonitorIcon, StopIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

import {
  selectThreadComputerAction,
  selectThreadComputerState,
  useComputerStateStore,
} from "../computerStateStore";
import {
  clampComputerScrollDelta,
  computerActionStatusLabel,
  computerCanvasLabel,
  computerContainRect,
  computerCursorPosition,
  computerDeliveryWarning,
  computerKeyCommand,
  computerPaneInputMode,
  computerReleaseControlHint,
  computerStopControlLabel,
  computerStreamRegion,
  computerViewportPointToDesktop,
  computerWheelScrollDelta,
  resolveComputerAvailabilityView,
  shouldSubscribeToComputerStream,
} from "./ComputerPanel.logic";
import { Badge } from "./ui/badge";
import { createComputerInputQueue } from "./computer/computerInputQueue";
import { createComputerClickDispatch } from "./computer/computerClickDispatch";
import { ComputerStatusBadge } from "./computer/ComputerStatusBadge";
import { ComputerInputPauseNotice } from "./computer/ComputerInputPauseNotice";
import { useComputerImageStream } from "./computer/useComputerImageStream";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";

/**
 * Wheel events arrive far faster than the seat can inject them, so a burst is
 * summed and sent once per window. Long enough to coalesce a trackpad flick,
 * short enough that scrolling still tracks the hand.
 */
const COMPUTER_SCROLL_FLUSH_MS = 50;

function inputErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The desktop did not accept that input.";
}

export default function ComputerPanel(props: {
  mode: DiffPanelMode;
  threadId: ThreadId;
  runtimeMode: DockPaneRuntimeMode;
  isVisible: boolean;
  onClosePanel: () => void;
  onRequestLive?: () => void;
}) {
  const { threadId, runtimeMode, isVisible } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useThreadComputerStateSeed(threadId);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const availabilityView = resolveComputerAvailabilityView(
    threadState?.availability,
    threadState?.health,
  );
  const streamEnabled = shouldSubscribeToComputerStream({
    runtimeMode,
    isVisible,
    threadState,
  });
  const { status: streamStatus, dimensions } = useComputerImageStream({
    canvasRef,
    computerId: streamEnabled && threadState ? threadState.computerId : null,
    enabled: streamEnabled,
  });

  const screenSize: ComputerScreenSize | undefined =
    threadState?.screenSize ?? dimensions ?? undefined;
  const containRect = useMemo(
    () =>
      screenSize
        ? computerContainRect({
            source: screenSize,
            containerWidth: viewportSize.width,
            containerHeight: viewportSize.height,
          })
        : null,
    [screenSize, viewportSize.height, viewportSize.width],
  );
  const cursorPosition = computerCursorPosition({
    cursor: threadState?.cursor,
    screenSize,
    containRect,
  });
  const lastAction = useComputerStateStore(selectThreadComputerAction(threadId));
  const lastActionLabel = computerActionStatusLabel(lastAction, threadState?.windows);
  // Shared with the chat-level banner so the two cannot disagree about whether
  // the machine is being driven, or about what stopping means.
  const desktopControl = useComputerDesktopControl(threadId);
  const { agentActive, visibleDesktop, stopRequested } = desktopControl;
  // The one blocked state the user can clear without leaving the pane. Same
  // server-side provision, same single-flight, same words as the chat card's
  // Set up and the settings panel's.
  const permissionRequired =
    threadState?.availability.kind === "permission-required" ? threadState.availability : null;
  const needsPermissionSetup = permissionRequired !== null;
  const setup = useProvisionComputer({
    ...(permissionRequired ? { missing: permissionRequired.missing } : {}),
    notify: true,
  });
  // The emergency release is a KWin compositor shortcut, so this is null on
  // every other backend rather than an unbound key the human would trust.
  const releaseControlHint = computerReleaseControlHint({
    availability: threadState?.availability,
    visibleDesktop,
    agentActive,
  });
  // ── User input ─────────────────────────────────────────────────────
  //
  // Input is opt-in: a pane that forwarded clicks while it was merely being
  // watched would fight the agent for the same seat, and a stray click on a
  // live desktop is not undoable. On a visible desktop it is not offered at all
  // — see `computerPaneInputMode`.
  const [interactive, setInteractive] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const inputMode = computerPaneInputMode({
    streamEnabled,
    visibleDesktop,
    agentActive,
  });
  const canInteract = inputMode === "available";

  // The pane's own stop, for the case the compositor hotkey cannot cover — see
  // `computerStopControlLabel`.
  const stopControlLabel = computerStopControlLabel({ agentActive, visibleDesktop });

  const inputQueue = useMemo(
    () =>
      createComputerInputQueue({
        onError: (error) => setInputError(inputErrorMessage(error)),
        onDrop: () =>
          setInputError(
            "The desktop is busy, so that input was dropped. Wait for it to catch up and try again.",
          ),
      }),
    [],
  );

  const sendInput = useCallback(
    (send: () => Promise<ComputerActionResult>) => {
      inputQueue.push(async () => {
        const result = await send();
        setInputError(null);
        // The backend answers every input with what it could establish about
        // delivery, and the pane used to throw that away — so an input the
        // desktop accepted but could not see arrive looked identical to one that
        // worked. Only `unconfirmed` is worth saying; see
        // `computerDeliveryWarning`.
        setInputWarning(computerDeliveryWarning(result));
      });
    },
    [inputQueue],
  );
  const clickDispatch = useMemo(
    () =>
      createComputerClickDispatch({
        dispatch: (command) => sendInput(() => ensureNativeApi().computer.inputClick(command)),
      }),
    [sendInput],
  );

  const region = useMemo(() => computerStreamRegion(screenSize), [screenSize]);
  // offsetX/offsetY are in the canvas's own box, which is the letterbox
  // geometry `containRect` describes, so no bounding-rect arithmetic is needed.
  const desktopPointFromEvent = useCallback(
    (event: { readonly offsetX: number; readonly offsetY: number }) =>
      computerViewportPointToDesktop({
        pointer: { x: event.offsetX, y: event.offsetY },
        containRect,
        region,
      }),
    [containRect, region],
  );

  useEffect(() => {
    if (canInteract) return;
    setInteractive(false);
    setInputError(null);
    setInputWarning(null);
  }, [canInteract]);

  useEffect(() => {
    if (interactive && canInteract) canvasRef.current?.focus();
    // Stopping control means stop: input the desktop has not seen yet is
    // forgotten rather than trickling out after the user let go.
    else {
      clickDispatch.cancel();
      inputQueue.clear();
    }
  }, [interactive, canInteract, clickDispatch, inputQueue]);
  useEffect(() => {
    const cancelInput = () => {
      clickDispatch.cancel();
      inputQueue.clear();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancelInput();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelInput();
    };
  }, [clickDispatch, inputQueue, threadId, threadState?.computerId]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      // Focus on press so keyboard passthrough follows the click.
      event.currentTarget.focus();
    },
    [interactive],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (!interactive || !canInteract) return;
      const point = desktopPointFromEvent(event.nativeEvent);
      if (!point) return;
      clickDispatch.click(point, event.detail);
    },
    [canInteract, clickDispatch, desktopPointFromEvent, interactive],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (!interactive || !canInteract) return;
      // The desktop gets the right click, so the browser menu must not open on
      // top of it.
      event.preventDefault();
      const point = desktopPointFromEvent(event.nativeEvent);
      if (!point) return;
      event.currentTarget.focus();
      clickDispatch.flush();
      sendInput(() =>
        ensureNativeApi().computer.inputClick({ x: point.x, y: point.y, button: "right" }),
      );
    },
    [canInteract, clickDispatch, desktopPointFromEvent, interactive, sendInput],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (!interactive || !canInteract) return;
      const command = computerKeyCommand(event);
      // A key the seat cannot express is left to the browser rather than
      // silently swallowed.
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      clickDispatch.flush();
      sendInput(() =>
        ensureNativeApi().computer.inputKey({
          key: command.key,
          ...(command.modifiers.length > 0 ? { modifiers: command.modifiers } : {}),
        }),
      );
    },
    [canInteract, clickDispatch, interactive, sendInput],
  );

  // Wheel is registered natively: React's root listener is passive, so
  // `preventDefault` there cannot stop the page from scrolling behind the pane.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !interactive || !canInteract) return;

    let batch: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelScroll = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      batch = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancelScroll();
    };

    const flush = () => {
      timer = null;
      const pending = batch;
      batch = null;
      if (!pending) return;
      const deltaX = clampComputerScrollDelta(pending.deltaX);
      const deltaY = clampComputerScrollDelta(pending.deltaY);
      if (deltaX === 0 && deltaY === 0) return;
      sendInput(() =>
        ensureNativeApi().computer.inputScroll({ x: pending.x, y: pending.y, deltaX, deltaY }),
      );
    };

    const onWheel = (event: WheelEvent) => {
      const point = desktopPointFromEvent(event);
      if (!point) return;
      event.preventDefault();
      clickDispatch.flush();
      const delta = computerWheelScrollDelta(event);
      batch = {
        x: point.x,
        y: point.y,
        deltaX: (batch?.deltaX ?? 0) + delta.deltaX,
        deltaY: (batch?.deltaY ?? 0) + delta.deltaY,
      };
      timer ??= setTimeout(flush, COMPUTER_SCROLL_FLUSH_MS);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelScroll();
    };
  }, [
    canInteract,
    clickDispatch,
    desktopPointFromEvent,
    interactive,
    sendInput,
    threadId,
    threadState?.computerId,
  ]);

  // The pane's own input failure outranks the session's last error: it is the
  // one the human just caused and can act on. The row keeps its height either
  // way, so an empty message stays invisible rather than showing a bare rule.
  const errorMessage = desktopControl.stopError ?? inputError ?? threadState?.lastError ?? "";
  const hasError = errorMessage.length > 0;
  // A delivery the desktop could not confirm is not an error — the input was
  // sent — so it never displaces one, and it reads as a caution rather than a
  // failure.
  const noticeMessage = hasError ? "" : (inputWarning ?? computerDeliveryWarning(lastAction) ?? "");
  const hasNotice = noticeMessage.length > 0;

  const header = (
    <div className="flex h-full w-full min-w-0 items-center gap-2">
      <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-xs">Computer</span>
      {/* The pane a user watches the agent drive from is the one surface where
          the maturity of the feature is most worth repeating. */}
      <Badge variant="warning" size="sm" className="shrink-0">
        Beta
      </Badge>
      {/* Backend health first, then the lease: a desktop that is gone explains
          more than who was holding it, and this thread may still be reading a
          desktop another conversation drives, which is the more useful of those
          two facts. */}
      <ComputerStatusBadge
        state={threadState}
        agentActive={agentActive}
        visibleDesktop={visibleDesktop}
      />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {stopControlLabel ? (
          <Button
            variant="outline"
            size="xs"
            className="gap-1 text-destructive"
            disabled={stopRequested}
            onClick={desktopControl.stop}
            title={stopControlLabel}
            aria-label={stopControlLabel}
          >
            <StopIcon className="size-3" />
            {stopRequested ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        {/* Not rendered at all on a desktop the user is already sitting at: the
            pane is a mirror of their own screen there, so "control the desktop"
            through it is a slower way to do what their mouse already does. */}
        {visibleDesktop ? null : (
          <Button
            variant={interactive ? "outline" : "ghost"}
            size="icon-sm"
            aria-pressed={interactive}
            disabled={!canInteract}
            onClick={() => setInteractive((current) => !current)}
            title={
              interactive
                ? "Stop controlling the desktop"
                : inputMode === "blocked-by-agent"
                  ? "The agent is using the desktop. Stop it first to take over."
                  : "Control the desktop"
            }
            aria-label={interactive ? "Stop controlling the desktop" : "Control the desktop"}
          >
            <CursorClickIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={props.onClosePanel}
          title="Close"
          aria-label="Close computer panel"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );

  return (
    <DiffPanelShell mode={props.mode} header={header}>
      {threadState?.inputPause ? (
        <ComputerInputPauseNotice
          key={threadState.inputPause.windowId ?? "unknown"}
          pause={threadState.inputPause}
          windows={threadState.windows}
        />
      ) : null}
      <div
        ref={viewportRef}
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black/90"
      >
        {availabilityView.kind === "blocked" || availabilityView.kind === "checking" ? (
          <ComputerAvailabilityMessage
            title={availabilityView.title}
            description={availabilityView.description}
            {...(needsPermissionSetup
              ? {
                  action: (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={setup.isPending}
                      onClick={setup.provision}
                    >
                      {setup.isPending ? "Setting up…" : "Set up"}
                    </Button>
                  ),
                }
              : {})}
          />
        ) : runtimeMode === "preview" ? (
          <button
            type="button"
            className="rounded-full bg-white/95 px-3 py-1.5 font-medium text-[10px] text-black shadow-sm"
            onClick={props.onRequestLive}
          >
            Show the live computer
          </button>
        ) : (
          <>
            {/*
              biome-ignore lint/a11y/noNoninteractiveElementInteractions: the
              canvas is the desktop surface; pointer and key handlers are the
              feature.
            */}
            <canvas
              ref={canvasRef}
              aria-label={computerCanvasLabel({
                availability: threadState?.availability,
                visibleDesktop,
              })}
              tabIndex={interactive ? 0 : -1}
              className={cn(
                "absolute inset-0 h-full w-full object-contain outline-none ring-inset",
                interactive
                  ? "cursor-crosshair focus-visible:ring-2 focus-visible:ring-ring/70"
                  : "cursor-default",
              )}
              onPointerDown={handlePointerDown}
              onClick={handleClick}
              onContextMenu={handleContextMenu}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-0.5 px-4 text-center text-[10px] text-white/70">
              {/* What the agent last did to this desktop, in words. The server
                  has always pushed `computer.action` and the store has always
                  kept the newest one per thread; until now nothing read it, so a
                  user watching a silent screen change had no way to tell a click
                  from a keystroke, or an action that failed from one that did
                  nothing visible. */}
              {lastActionLabel ? (
                <p className={disclosureFadeClassName(agentActive)}>{lastActionLabel}</p>
              ) : null}
              {releaseControlHint ? (
                <p className={disclosureFadeClassName(releaseControlHint.visible)}>
                  {releaseControlHint.text}
                </p>
              ) : null}
              <p className={disclosureFadeClassName(interactive && !inputFocused)}>
                Click the desktop to send keystrokes
              </p>
            </div>
            {streamStatus.kind !== "streaming" ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center">
                <ComputerStreamStatus status={streamStatus} />
              </div>
            ) : null}
            {cursorPosition ? (
              // The same look as the on-desktop ghost cursor the KWin plugin
              // draws: an ordinary pointer glyph whose violet halo is what says
              // it is the agent's. The path tip sits at the SVG origin, so the
              // element is positioned by the hotspot with no centering shift.
              <svg
                aria-label="Agent cursor"
                viewBox="0 0 14 16"
                className={cn(
                  "pointer-events-none absolute h-4 w-3.5 overflow-visible [filter:drop-shadow(0_0_3px_rgba(124,58,237,0.9))_drop-shadow(0_0_7px_rgba(124,58,237,0.65))]",
                  agentActive ? "opacity-100" : "opacity-65",
                )}
                style={{ left: cursorPosition.left, top: cursorPosition.top }}
              >
                <path
                  d="M0 0 L0 10.64 L2.66 8.12 L4.2 12.32 L6.16 11.48 L4.48 7.56 L7.84 7.56 Z"
                  fill="#ffffff"
                  stroke="rgba(20,10,46,0.85)"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </>
        )}
      </div>
      <p
        role="status"
        className={disclosureFadeClassName(
          hasError || hasNotice,
          cn(
            "line-clamp-2 flex shrink-0 items-center border-t px-3 text-xs",
            hasError ? "text-destructive" : "text-amber-600 dark:text-amber-400",
            hasError || hasNotice ? "border-border" : "border-transparent",
          ),
        )}
        style={{ height: "1.875rem" }}
      >
        {hasError ? errorMessage : noticeMessage}
      </p>
    </DiffPanelShell>
  );
}

function ComputerAvailabilityMessage(props: {
  title: string;
  description: string;
  /**
   * Offered only for a blocked state the user can actually clear from here. The
   * pane was a dead end on `permission-required`: it named the grant macOS was
   * withholding and then left the user to find the same button in Settings, or
   * to wait for an agent to fail again so the chat would offer it.
   */
  action?: ReactNode;
}) {
  return (
    <div className="max-w-sm px-6 text-center text-white/80" role="status">
      <MonitorIcon className="mx-auto mb-3 size-8 text-white/45" />
      <p className="font-medium text-sm text-white">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-white/60">{props.description}</p>
      {props.action ? <div className="mt-3 flex justify-center">{props.action}</div> : null}
    </div>
  );
}

function ComputerStreamStatus(props: {
  status: ReturnType<typeof useComputerImageStream>["status"];
}) {
  if (props.status.kind === "connecting") {
    return (
      <span className="flex items-center gap-2 text-xs text-white/65" role="status">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Connecting to the desktop…
      </span>
    );
  }
  if (props.status.kind === "unsupported") {
    return (
      <span className="text-xs text-white/65">This browser cannot decode desktop frames.</span>
    );
  }
  if (props.status.kind === "error") {
    return <span className="max-w-xs text-xs text-white/70">{props.status.message}</span>;
  }
  return null;
}
