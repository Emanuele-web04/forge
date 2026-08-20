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
import { requestBrowserPanelBoundsSync } from "../../lib/browserPanelBoundsSync";
import { DISCLOSURE_INNER_CLASS, disclosureWidthClassName } from "../../lib/disclosureMotion";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "../../lib/panelResize";
import { cn } from "../../lib/utils";
import { isElectron } from "../../env";
import { IconButton } from "../ui/icon-button";
import {
  applyBrowserRendererGuestSlotStyle,
  applyFloatingBrowserChromeSlotStyle,
  ensureFloatingBrowserChromeWebview,
  getBrowserRendererGuestSlot,
  getFloatingBrowserChromeSlot,
  nudgeFloatingBrowserChromeNativeView,
  setFloatingBrowserChromeMenuOpen,
} from "../BrowserPanel.logic";
import {
  clampFloatingBrowserPanelRect,
  FLOATING_BROWSER_PANEL_DEFAULT_SIZE,
  FLOATING_BROWSER_PANEL_MARGIN_PX,
  floatingBrowserResizeCursor,
  initialFloatingBrowserPanelRect,
  isFloatingBrowserDragGesture,
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

function syncFloatingBrowserGuestSlot(threadId: ThreadId, panel: HTMLElement): void {
  const slot = getBrowserRendererGuestSlot(threadId);
  const rect = panel.getBoundingClientRect();
  const styles = window.getComputedStyle(panel);
  applyBrowserRendererGuestSlotStyle(
    slot,
    {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    { borderRadius: styles.borderTopLeftRadius },
  );
  slot.style.border = styles.border;
  slot.style.boxShadow = styles.boxShadow;
  applyFloatingBrowserChromeSlotStyle(
    getFloatingBrowserChromeSlot(threadId),
    {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
  );
}

function setFloatingChromeExpanded(
  threadId: ThreadId,
  panel: HTMLElement | null,
  expanded: boolean,
): void {
  const slot = getFloatingBrowserChromeSlot(threadId);
  const webview = slot.querySelector("webview");
  if (webview instanceof HTMLElement) {
    setFloatingBrowserChromeMenuOpen(webview, expanded);
  }
  if (!panel) {
    applyFloatingBrowserChromeSlotStyle(slot, null, { expanded });
    return;
  }
  const rect = panel.getBoundingClientRect();
  applyFloatingBrowserChromeSlotStyle(
    slot,
    {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    { expanded },
  );
  nudgeFloatingBrowserChromeNativeView(slot);
}

export function FloatingBrowserPanel(props: FloatingBrowserPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeInteractionCleanupRef = useRef<(() => void) | null>(null);
  const interactingRef = useRef(false);
  const didDragRef = useRef(false);
  const hasMeasuredHostRef = useRef(false);
  const panelRectRef = useRef<FloatingBrowserPanelRect>(DEFAULT_FLOATING_RECT);
  const [panelRect, setPanelRect] = useState<FloatingBrowserPanelRect>(DEFAULT_FLOATING_RECT);
  const [controlsOpen, setControlsOpen] = useState(false);
  const startDragFromClientRef = useRef<
    (x: number, y: number, options: { reopenMenuOnRelease: boolean }) => void
  >(() => {});

  const applyPanelRect = useCallback((next: FloatingBrowserPanelRect, host: HTMLElement) => {
    const clamped = clampFloatingBrowserPanelRect(next, hostSize(host));
    panelRectRef.current = clamped;
    const panel = panelRef.current;
    if (panel) {
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
      panel.style.width = `${clamped.width}px`;
      panel.style.height = `${clamped.height}px`;
      syncFloatingBrowserGuestSlot(props.threadId, panel);
    }
    return clamped;
  }, [props.threadId]);

  const commitPanelRect = useCallback(
    (next: FloatingBrowserPanelRect, host: HTMLElement) => {
      setPanelRect(applyPanelRect(next, host));
    },
    [applyPanelRect],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      if (interactingRef.current) return;
      const size = hostSize(host);
      if (!hasMeasuredHostRef.current) {
        hasMeasuredHostRef.current = true;
        commitPanelRect(initialFloatingBrowserPanelRect(size), host);
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
      commitPanelRect(clamped, host);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [commitPanelRect]);

  useEffect(() => {
    return () => {
      activeInteractionCleanupRef.current?.();
      activeInteractionCleanupRef.current = null;
      applyFloatingBrowserChromeSlotStyle(getFloatingBrowserChromeSlot(props.threadId), null);
    };
  }, [props.threadId]);

  useLayoutEffect(() => {
    requestBrowserPanelBoundsSync();
    if (!isElectron) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    syncFloatingBrowserGuestSlot(props.threadId, panel);
    nudgeFloatingBrowserChromeNativeView(getFloatingBrowserChromeSlot(props.threadId));
  }, [panelRect, props.threadId]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const resizeHandle = target.closest<HTMLElement>("[data-floating-resize-edge]");
    const resizeEdge = resizeHandle?.dataset.floatingResizeEdge as
      | FloatingBrowserResizeEdge
      | undefined;
    if (!resizeEdge) return;

    event.preventDefault();
    event.stopPropagation();
    activeInteractionCleanupRef.current?.();

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startRect = panelRectRef.current;
    const cursor = floatingBrowserResizeCursor(resizeEdge);
    const resizeOverlay = createPanelResizeOverlay(cursor);
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    let finished = false;
    interactingRef.current = true;
    let detachPointerSession = () => {};

    const finish = () => {
      if (finished) return;
      finished = true;
      interactingRef.current = false;
      detachPointerSession();
      removePanelResizeOverlay(resizeOverlay);
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
      if (activeInteractionCleanupRef.current === finish) {
        activeInteractionCleanupRef.current = null;
      }
      commitPanelRect(panelRectRef.current, host);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      applyPanelRect(
        resizeFloatingBrowserPanelRect(
          startRect,
          {
            edge: resizeEdge,
            deltaX: moveEvent.clientX - startClientX,
            deltaY: moveEvent.clientY - startClientY,
          },
          hostSize(host),
        ),
        host,
      );
    };

    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    detachPointerSession = attachPanelPointerOverlaySession(resizeOverlay, {
      onMove: onPointerMove,
      onRelease: finish,
      onAbort: finish,
    });
    activeInteractionCleanupRef.current = finish;
  };

  const startDragFromClient = (
    startClientX: number,
    startClientY: number,
    options: { reopenMenuOnRelease: boolean },
  ) => {
    const host = hostRef.current;
    if (!host) return;

    activeInteractionCleanupRef.current?.();
    didDragRef.current = false;
    const reopenMenuOnRelease = options.reopenMenuOnRelease && !controlsOpen;
    setControlsOpen(false);
    setFloatingChromeExpanded(props.threadId, panelRef.current, false);

    const startRect = panelRectRef.current;
    const resizeOverlay = createPanelResizeOverlay("grabbing");
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    let finished = false;
    let detachPointerSession = () => {};

    const finish = (openMenu: boolean) => {
      if (finished) return;
      finished = true;
      interactingRef.current = false;
      detachPointerSession();
      removePanelResizeOverlay(resizeOverlay);
      document.body.style.cursor = previousBodyCursor;
      document.body.style.userSelect = previousBodyUserSelect;
      if (activeInteractionCleanupRef.current === finishWithRelease) {
        activeInteractionCleanupRef.current = null;
      }
      if (didDragRef.current) {
        commitPanelRect(panelRectRef.current, host);
        return;
      }
      if (openMenu && reopenMenuOnRelease) {
        setControlsOpen(true);
        setFloatingChromeExpanded(props.threadId, panelRef.current, true);
      }
    };
    const finishWithRelease = () => finish(true);
    const finishWithAbort = () => finish(false);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = {
        x: moveEvent.clientX - startClientX,
        y: moveEvent.clientY - startClientY,
      };
      if (!didDragRef.current) {
        if (!isFloatingBrowserDragGesture(delta)) return;
        didDragRef.current = true;
        interactingRef.current = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      applyPanelRect(moveFloatingBrowserPanelRect(startRect, delta, hostSize(host)), host);
    };

    detachPointerSession = attachPanelPointerOverlaySession(resizeOverlay, {
      onMove: onPointerMove,
      onRelease: finishWithRelease,
      onAbort: finishWithAbort,
    });
    activeInteractionCleanupRef.current = finishWithRelease;
  };
  startDragFromClientRef.current = startDragFromClient;

  const startHandleGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startDragFromClient(event.clientX, event.clientY, { reopenMenuOnRelease: true });
  };

  useLayoutEffect(() => {
    if (!isElectron) {
      return;
    }
    const slot = getFloatingBrowserChromeSlot(props.threadId);
    const webview = ensureFloatingBrowserChromeWebview(slot);
    const panel = panelRef.current;
    if (panel) {
      syncFloatingBrowserGuestSlot(props.threadId, panel);
      nudgeFloatingBrowserChromeNativeView(slot);
    }
    const onIpcMessage = (event: Event) => {
      const message = event as Event & { channel?: string; args?: unknown[] };
      const channel = message.channel;
      const payload = message.args?.[0];
      if (channel === "drag") {
        const point = payload as { x?: number; y?: number; button?: number } | undefined;
        if (point?.button != null && point.button !== 0) return;
        const rect = slot.getBoundingClientRect();
        startDragFromClientRef.current(rect.left + (point?.x ?? 0), rect.top + (point?.y ?? 0), {
          reopenMenuOnRelease: true,
        });
        return;
      }
      if (channel === "pop") {
        setFloatingChromeExpanded(props.threadId, panelRef.current, false);
        props.onPopToSidebar();
        return;
      }
      if (channel === "close") {
        props.onClose();
      }
    };
    webview.addEventListener("ipc-message", onIpcMessage);
    return () => {
      webview.removeEventListener("ipc-message", onIpcMessage);
    };
  }, [props.onClose, props.onPopToSidebar, props.threadId]);

  return (
    <div
      ref={hostRef}
      data-floating-browser-host="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 overflow-visible"
      style={{ top: `${CHAT_SURFACE_HEADER_HEIGHT_PX}px` }}
    >
      <div
        ref={panelRef}
        data-floating-browser-panel="true"
        role="region"
        aria-label="Floating browser"
        className="group/floating-browser pointer-events-none absolute flex flex-col overflow-visible rounded-xl border border-border bg-background text-foreground shadow-2xl ring-1 ring-black/10"
        style={{
          left: `${panelRect.left}px`,
          top: `${panelRect.top}px`,
          width: `${panelRect.width}px`,
          height: `${panelRect.height}px`,
          touchAction: "none",
        }}
        onPointerDown={startResize}
      >
        <div
          data-floating-browser-controls="true"
          className={cn(
            "pointer-events-auto absolute right-2 top-2 z-20",
            isElectron && "hidden",
          )}
        >
          <div className="flex items-center gap-0.5 rounded-full border border-border/80 bg-background/90 p-0.5 shadow-sm backdrop-blur-md">
            <IconButton
              type="button"
              variant="ghost"
              size="icon-xs"
              label="Floating browser actions"
              tooltip="Drag to move, click for actions"
              tooltipSide="bottom"
              data-floating-browser-header="true"
              aria-expanded={controlsOpen}
              aria-haspopup="true"
              className="size-6 cursor-grab rounded-full text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
              onPointerDown={startHandleGesture}
            >
              <EllipsisIcon className="size-3.5" />
            </IconButton>
            <div
              className={disclosureWidthClassName(controlsOpen, "w-[50px]")}
              inert={!controlsOpen}
            >
              <div
                className={cn(DISCLOSURE_INNER_CLASS, "flex w-[50px] items-center gap-0.5")}
              >
                <IconButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  label="Open browser in sidebar"
                  tooltip="Open browser in sidebar"
                  tooltipSide="bottom"
                  className="size-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setControlsOpen(false);
                    props.onPopToSidebar();
                  }}
                >
                  <PanelRightCloseIcon />
                </IconButton>
                <IconButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  label="Close floating browser"
                  tooltip="Close floating browser"
                  tooltipSide="bottom"
                  className="size-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setControlsOpen(false);
                    props.onClose();
                  }}
                >
                  <XIcon />
                </IconButton>
              </div>
            </div>
          </div>
        </div>
        <div
          data-floating-browser-content="true"
          className="pointer-events-none absolute inset-0 min-h-0 min-w-0 overflow-hidden rounded-[inherit]"
        >
          <Suspense fallback={<FloatingBrowserPanelFallback />}>
            <LazyBrowserPanel
              mode="floating"
              threadId={props.threadId}
              onClosePanel={props.onClose}
            />
          </Suspense>
        </div>
        {RESIZE_HANDLES.map(({ edge, className }) => (
          <div
            key={edge}
            aria-hidden="true"
            data-panel-resize-overlay="true"
            data-floating-resize-edge={edge}
            className={cn("pointer-events-auto z-10", className)}
          />
        ))}
      </div>
    </div>
  );
}

export function FloatingBrowserPanelFallback() {
  return <PanelStateMessage>Loading browser...</PanelStateMessage>;
}
