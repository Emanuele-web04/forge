import type { ComputerActionResult, ComputerScreenSize, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useThreadComputerStateSeed } from "~/hooks/useThreadComputerStateSeed";
import { disclosureFadeClassName } from "~/lib/disclosureMotion";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { CursorClickIcon, LoaderCircleIcon, MonitorIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

import { selectThreadComputerState, useComputerStateStore } from "../computerStateStore";
import {
  clampComputerScrollDelta,
  computerContainRect,
  computerCursorPosition,
  computerKeyCommand,
  computerStreamRegion,
  computerViewportPointToDesktop,
  computerWheelScrollDelta,
  resolveComputerAvailabilityView,
  resolveComputerHealthBadge,
  shouldSubscribeToComputerStream,
} from "./ComputerPanel.logic";
import { Badge } from "./ui/badge";
import { createComputerInputQueue } from "./computer/computerInputQueue";
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

  const healthBadge = resolveComputerHealthBadge(threadState?.health);
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
  // ── User input ─────────────────────────────────────────────────────
  //
  // Input is opt-in: a pane that forwarded clicks while it was merely being
  // watched would fight the agent for the same seat, and a stray click on a
  // live desktop is not undoable.
  const [interactive, setInteractive] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const canInteract = streamEnabled;

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
        await send();
        setInputError(null);
      });
    },
    [inputQueue],
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
  }, [canInteract]);

  useEffect(() => {
    if (interactive) canvasRef.current?.focus();
    // Stopping control means stop: input the desktop has not seen yet is
    // forgotten rather than trickling out after the user let go.
    else inputQueue.clear();
  }, [interactive, inputQueue]);
  useEffect(() => () => inputQueue.clear(), [inputQueue]);

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
      if (!interactive) return;
      const point = desktopPointFromEvent(event.nativeEvent);
      if (!point) return;
      // One press per DOM click, including the second click of a double. The
      // browser already sent the first click as its own event, so upgrading this
      // one to the backend's double-click would put three presses on the desktop
      // and read as a triple click. Two plain presses land inside the toolkit's
      // pairing interval on their own, and that is what makes the double.
      sendInput(() => ensureNativeApi().computer.inputClick({ x: point.x, y: point.y }));
    },
    [desktopPointFromEvent, interactive, sendInput],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      // The desktop gets the right click, so the browser menu must not open on
      // top of it.
      event.preventDefault();
      const point = desktopPointFromEvent(event.nativeEvent);
      if (!point) return;
      event.currentTarget.focus();
      sendInput(() =>
        ensureNativeApi().computer.inputClick({ x: point.x, y: point.y, button: "right" }),
      );
    },
    [desktopPointFromEvent, interactive, sendInput],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      const command = computerKeyCommand(event);
      // A key the seat cannot express is left to the browser rather than
      // silently swallowed.
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      sendInput(() =>
        ensureNativeApi().computer.inputKey({
          key: command.key,
          ...(command.modifiers.length > 0 ? { modifiers: command.modifiers } : {}),
        }),
      );
    },
    [interactive, sendInput],
  );

  // Wheel is registered natively: React's root listener is passive, so
  // `preventDefault` there cannot stop the page from scrolling behind the pane.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !interactive) return;

    let batch: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

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
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      if (timer !== null) clearTimeout(timer);
    };
  }, [desktopPointFromEvent, interactive, sendInput]);

  // The pane's own input failure outranks the session's last error: it is the
  // one the human just caused and can act on. The row keeps its height either
  // way, so an empty message stays invisible rather than showing a bare rule.
  const errorMessage = inputError ?? threadState?.lastError ?? "";
  const hasError = errorMessage.length > 0;

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
      {healthBadge ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-[10px]",
            healthBadge.tone === "danger"
              ? "text-destructive"
              : "text-amber-600 dark:text-amber-400",
          )}
          title={healthBadge.title}
        >
          <span
            className={cn(
              "size-1.5 rounded-full bg-current",
              healthBadge.pulse && "animate-pulse motion-reduce:animate-none",
            )}
          />
          {healthBadge.label}
        </span>
      ) : threadState?.controlledByOtherThread ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
          title="Only one conversation can drive the desktop at a time. This one can still watch it."
        >
          <span className="size-1.5 rounded-full bg-current" />
          Another conversation is controlling
        </span>
      ) : threadState?.agentActive ? (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          Agent controlling
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant={interactive ? "outline" : "ghost"}
          size="icon-sm"
          aria-pressed={interactive}
          disabled={!canInteract}
          onClick={() => setInteractive((current) => !current)}
          title={interactive ? "Stop controlling the desktop" : "Control the desktop"}
          aria-label={interactive ? "Stop controlling the desktop" : "Control the desktop"}
        >
          <CursorClickIcon />
        </Button>
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
      <div
        ref={viewportRef}
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black/90"
      >
        {availabilityView.kind === "blocked" || availabilityView.kind === "checking" ? (
          <ComputerAvailabilityMessage
            title={availabilityView.title}
            description={availabilityView.description}
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
              aria-label="Linux desktop"
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
              // The violet halo distinguishes the agent cursor from the
              // pointer used to interact with the pane.
              <svg
                aria-label="Agent cursor"
                viewBox="0 0 14 16"
                className={cn(
                  "pointer-events-none absolute h-4 w-3.5 overflow-visible [filter:drop-shadow(0_0_3px_rgba(124,58,237,0.9))_drop-shadow(0_0_7px_rgba(124,58,237,0.65))]",
                  threadState?.agentActive ? "opacity-100" : "opacity-65",
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
          hasError,
          cn(
            "line-clamp-2 flex shrink-0 items-center border-t px-3 text-destructive text-xs",
            hasError ? "border-border" : "border-transparent",
          ),
        )}
        style={{ height: "1.875rem" }}
      >
        {errorMessage}
      </p>
    </DiffPanelShell>
  );
}

function ComputerAvailabilityMessage(props: { title: string; description: string }) {
  return (
    <div className="max-w-sm px-6 text-center text-white/80" role="status">
      <MonitorIcon className="mx-auto mb-3 size-8 text-white/45" />
      <p className="font-medium text-sm text-white">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-white/60">{props.description}</p>
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
