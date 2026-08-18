// FILE: FloatingBrowserPanel.tsx
// Purpose: Draggable, resizable browser host that overlays one chat surface.
// Layer: Chat surface UI
// Depends on: the shared browser panel and panel-resize pointer overlay.

import {
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ThreadId } from "@synara/contracts";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";

import { EllipsisIcon, PanelRightCloseIcon, XIcon } from "../../lib/icons";
import { isElectron } from "../../env";
import { requestBrowserPanelBoundsSync } from "../../lib/browserPanelBoundsSync";
import {
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "../../lib/panelResize";
import { cn } from "../../lib/utils";
import { IconButton } from "../ui/icon-button";
import {
  clampFloatingBrowserPanelRect,
  FLOATING_BROWSER_PANEL_DEFAULT_SIZE,
  FLOATING_BROWSER_PANEL_MARGIN_PX,
  floatingBrowserResizeCursor,
  initialFloatingBrowserPanelRect,
  moveFloatingBrowserPanelRect,
  resizeFloatingBrowserPanelRect,
  type FloatingBrowserPanelHostSize,
  type FloatingBrowserPanelRect,
  type FloatingBrowserResizeEdge,
} from "./floatingBrowserPanel.logic";
import { LazyBrowserPanel } from "./ChatThreadSurfacePrimitives";
import { PanelStateMessage } from "./PanelStateMessage";

interface FloatingBrowserPanelProps {
  threadId: ThreadId;
  onPopToSidebar: () => void;
  onClose: () => void;
}

const DEFAULT_FLOATING_RECT: FloatingBrowserPanelRect = {
  left: FLOATING_BROWSER_PANEL_MARGIN_PX,
  top: FLOATING_BROWSER_PANEL_MARGIN_PX,
  ...FLOATING_BROWSER_PANEL_DEFAULT_SIZE,
};

const RESIZE_HANDLES: ReadonlyArray<{
  edge: FloatingBrowserResizeEdge;
  className: string;
}> = [
  { edge: "n", className: "absolute -top-2 inset-x-4 h-4 cursor-ns-resize" },
  { edge: "e", className: "absolute -right-2 inset-y-4 w-4 cursor-ew-resize" },
  { edge: "s", className: "absolute -bottom-2 inset-x-4 h-4 cursor-ns-resize" },
  { edge: "w", className: "absolute -left-2 inset-y-4 w-4 cursor-ew-resize" },
  { edge: "ne", className: "absolute -right-2 -top-2 size-6 cursor-nesw-resize" },
  { edge: "nw", className: "absolute -left-2 -top-2 size-6 cursor-nwse-resize" },
  { edge: "se", className: "absolute -bottom-2 -right-2 size-6 cursor-nwse-resize" },
  { edge: "sw", className: "absolute -bottom-2 -left-2 size-6 cursor-nesw-resize" },
];

function hostSize(host: HTMLElement): FloatingBrowserPanelHostSize {
  const rect = host.getBoundingClientRect();
  return {
    width: host.clientWidth || rect.width,
    height: host.clientHeight || rect.height,
  };
}

function isInteractivePointerTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, textarea, select, a, [role='button'], [contenteditable='true']",
    ) !== null
  );
}

export function FloatingBrowserPanel(props: FloatingBrowserPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeInteractionCleanupRef = useRef<(() => void) | null>(null);
  const nativeDragStartRectRef = useRef<FloatingBrowserPanelRect | null>(null);
  const hasMeasuredHostRef = useRef(false);
  const panelRectRef = useRef<FloatingBrowserPanelRect>(DEFAULT_FLOATING_RECT);
  const [panelRect, setPanelRect] = useState<FloatingBrowserPanelRect>(DEFAULT_FLOATING_RECT);
  const [controlsOpen, setControlsOpen] = useState(false);

  const setClampedPanelRect = useCallback(
    (next: FloatingBrowserPanelRect, host: HTMLElement) => {
      const clamped = clampFloatingBrowserPanelRect(next, hostSize(host));
      panelRectRef.current = clamped;
      setPanelRect(clamped);
    },
    [],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const size = hostSize(host);
      if (!hasMeasuredHostRef.current) {
        hasMeasuredHostRef.current = true;
        const initial = initialFloatingBrowserPanelRect(size);
        panelRectRef.current = initial;
        setPanelRect(initial);
        return;
      }
      const clamped = clampFloatingBrowserPanelRect(panelRectRef.current, size);
      if (
        clamped.left === panelRectRef.current.left &&
        clamped.top === panelRectRef.current.top &&
        clamped.width === panelRectRef.current.width &&
        clamped.height === panelRectRef.current.height
      ) {
        return;
      }
      panelRectRef.current = clamped;
      setPanelRect(clamped);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      activeInteractionCleanupRef.current?.();
      activeInteractionCleanupRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    requestBrowserPanelBoundsSync();
  }, [panelRect]);

  useEffect(() => {
    if (!isElectron) return;
    return window.desktopBridge?.browser.onFloatingControl((event) => {
      if (event.threadId !== props.threadId) return;
      if (event.action === "sidebar") {
        props.onPopToSidebar();
        return;
      }
      if (event.action === "close") {
        props.onClose();
        return;
      }
      if (event.action === "drag-end") {
        setPanelRect({ ...panelRectRef.current });
        nativeDragStartRectRef.current = null;
        return;
      }
      const host = hostRef.current;
      if (!host) return;
      const dragOrigin =
        event.action === "drag-live"
          ? (nativeDragStartRectRef.current ??= panelRectRef.current)
          : panelRectRef.current;
      const next = moveFloatingBrowserPanelRect(
        dragOrigin,
        { x: event.deltaX ?? 0, y: event.deltaY ?? 0 },
        hostSize(host),
      );
      if (event.action === "drag-live") {
        panelRectRef.current = next;
        const panel = panelRef.current;
        if (panel) {
          panel.style.left = `${next.left}px`;
          panel.style.top = `${next.top}px`;
        }
        return;
      }
      setClampedPanelRect(next, host);
    });
  }, [props.onClose, props.onPopToSidebar, props.threadId, setClampedPanelRect]);

  const startInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const resizeHandle = target.closest<HTMLElement>("[data-floating-resize-edge]");
    const resizeEdge = resizeHandle?.dataset.floatingResizeEdge as
      | FloatingBrowserResizeEdge
      | undefined;
    const dragHandle = target.closest("[data-floating-browser-header='true']") !== null;
    if (!resizeEdge && (!dragHandle || isInteractivePointerTarget(target))) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    activeInteractionCleanupRef.current?.();

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startRect = panelRectRef.current;
    const cursor = resizeEdge ? floatingBrowserResizeCursor(resizeEdge) : "grabbing";
    const resizeOverlay = createPanelResizeOverlay(cursor);
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      removePanelResizeOverlay(resizeOverlay);
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
      resizeOverlay.removeEventListener("pointermove", onPointerMove);
      resizeOverlay.removeEventListener("pointerup", finish);
      resizeOverlay.removeEventListener("pointercancel", finish);
      if (activeInteractionCleanupRef.current === finish) {
        activeInteractionCleanupRef.current = null;
      }
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = {
        x: moveEvent.clientX - startClientX,
        y: moveEvent.clientY - startClientY,
      };
      const next = resizeEdge
        ? resizeFloatingBrowserPanelRect(
            startRect,
            { edge: resizeEdge, deltaX: delta.x, deltaY: delta.y },
            hostSize(host),
          )
        : moveFloatingBrowserPanelRect(startRect, delta, hostSize(host));
      setClampedPanelRect(next, host);
    };

    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    resizeOverlay.addEventListener("pointermove", onPointerMove);
    resizeOverlay.addEventListener("pointerup", finish);
    resizeOverlay.addEventListener("pointercancel", finish);
    activeInteractionCleanupRef.current = finish;
  };

  return (
    <div
      ref={hostRef}
      data-floating-browser-host="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 overflow-hidden"
      style={{ top: `${CHAT_SURFACE_HEADER_HEIGHT_PX}px` }}
    >
      <div
        ref={panelRef}
        data-floating-browser-panel="true"
        data-native-browser-surface="true"
        role="region"
        aria-label="Floating browser"
        className="group/floating-browser pointer-events-auto absolute flex flex-col overflow-visible rounded-xl border border-border bg-transparent text-foreground shadow-2xl ring-1 ring-black/10"
        style={{
          left: `${panelRect.left}px`,
          top: `${panelRect.top}px`,
          width: `${panelRect.width}px`,
          height: `${panelRect.height}px`,
          touchAction: "none",
        }}
        onPointerDown={startInteraction}
      >
        <div
          data-floating-browser-content="true"
          className="absolute inset-0 min-h-0 min-w-0 overflow-hidden rounded-[inherit]"
        >
          <Suspense fallback={<FloatingBrowserPanelFallback />}>
            <LazyBrowserPanel
              mode="floating"
              threadId={props.threadId}
              onClosePanel={props.onClose}
            />
          </Suspense>
        </div>
        {!isElectron ? <div
          data-floating-browser-controls="true"
          className="pointer-events-auto absolute bottom-full right-2 z-50 -mb-px opacity-100"
        >
          <div
            data-floating-browser-header="true"
            className="group/floating-browser-controls flex cursor-grab items-center gap-0.5 rounded-full border border-border bg-background/95 p-0.5 text-foreground shadow-lg backdrop-blur-md"
          >
            <span
              aria-hidden="true"
              className="grid h-6 w-3 shrink-0 cursor-grab grid-cols-2 place-content-center gap-0.5"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <span key={index} className="size-0.5 rounded-full bg-muted-foreground" />
              ))}
            </span>
            <IconButton
              variant="ghost"
              size="icon-xs"
              label="Floating browser actions"
              tooltip="Floating browser actions"
              tooltipSide="bottom"
              aria-expanded={controlsOpen}
              aria-haspopup="true"
              className="size-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setControlsOpen((open) => !open);
              }}
            >
              <EllipsisIcon className="size-3.5" />
            </IconButton>
            {controlsOpen ? (
              <>
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label="Open browser in sidebar"
                  tooltip="Open browser in sidebar"
                  tooltipSide="bottom"
                  className="size-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    setControlsOpen(false);
                    props.onPopToSidebar();
                  }}
                >
                  <PanelRightCloseIcon />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label="Close floating browser"
                  tooltip="Close floating browser"
                  tooltipSide="bottom"
                  className="size-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    setControlsOpen(false);
                    props.onClose();
                  }}
                >
                  <XIcon />
                </IconButton>
              </>
            ) : null}
          </div>
        </div> : null}
        {RESIZE_HANDLES.map(({ edge, className }) => (
          <div
            key={edge}
            aria-hidden="true"
            data-panel-resize-overlay="true"
            data-floating-resize-edge={edge}
            className={cn("z-[60]", className)}
          />
        ))}
      </div>
    </div>
  );
}

export function FloatingBrowserPanelFallback() {
  return <PanelStateMessage>Loading browser...</PanelStateMessage>;
}
