// FILE: ChatPaneDropOverlay.tsx
// Purpose: Renders the 4-quadrant drop-zone overlay used to split a chat surface by dragging a sidebar thread.
// Layer: UI component (route surfaces wrap it around <ChatView /> or empty-state placeholders)
// Exports: ChatPaneDropOverlay component, drag MIME constant, drop-zone helpers used by tests

import { useEffect, useRef, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { type ThreadId } from "@synara/contracts";

import { type SplitDirection, type SplitDropSide } from "../../splitViewStore";
import { cn } from "../../lib/utils";
import {
  hasThreadDragType,
  parseThreadDragPayload,
  type ThreadDragPayload,
} from "../../threadDrag";

export { THREAD_DRAG_MIME } from "../../threadDrag";

export type DropZone = "top" | "bottom" | "left" | "right";

export interface ThreadDropRules {
  excludedThreadIds?: ReadonlySet<ThreadId> | undefined;
}

const DROP_ZONE_PREVIEW_CLASS: Record<DropZone, string> = {
  top: "left-0 right-0 top-0 h-1/2",
  bottom: "left-0 right-0 bottom-0 h-1/2",
  left: "top-0 bottom-0 left-0 w-1/2",
  right: "top-0 bottom-0 right-0 w-1/2",
};
const DROP_ZONE_PREVIEW_BASE_CLASS =
  "absolute m-1 rounded-md bg-info/18 ring-1 ring-inset ring-info/65";
const EMPTY_RECT = { left: 0, top: 0, width: 0, height: 0 };
const EDGE_REGION_FRACTION = 1 / 3;

function chooseAllowedZone(
  primary: DropZone,
  fallback: DropZone,
  isZoneAllowed: (zone: DropZone) => boolean,
): DropZone {
  return isZoneAllowed(primary) ? primary : fallback;
}

interface ChatPaneDropOverlayProps {
  // Centralized tree-aware predicate. Split panes use this to enforce the 2x2 depth cap.
  canDropInDirection?: (direction: SplitDirection) => boolean;
  // ThreadIds whose drops should be ignored (e.g. threads already mounted in this split view).
  excludedThreadIds?: ReadonlySet<ThreadId>;
  onDrop(payload: ThreadDragPayload & { direction: SplitDirection; side: SplitDropSide }): void;
  // Outer wrapper className. Defaults to a layout-neutral filler that participates in flex containers.
  className?: string;
  children: ReactNode;
  // Identifier used to reset internal state when the wrapped surface changes (e.g. pane id).
  paneScopeId?: string;
}

export function getDropZoneFromPointer(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  isZoneAllowed: (zone: DropZone) => boolean = () => true,
): DropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;

  const horizontalAllowed = isZoneAllowed("left") || isZoneAllowed("right");
  const verticalAllowed = isZoneAllowed("top") || isZoneAllowed("bottom");
  if (!horizontalAllowed && !verticalAllowed) return null;

  if (!horizontalAllowed) {
    return relY < 0.5
      ? chooseAllowedZone("top", "bottom", isZoneAllowed)
      : chooseAllowedZone("bottom", "top", isZoneAllowed);
  }
  if (!verticalAllowed) {
    return relX < 0.5
      ? chooseAllowedZone("left", "right", isZoneAllowed)
      : chooseAllowedZone("right", "left", isZoneAllowed);
  }

  // VS Code-style regions: favor left/right on wide panes, top/bottom on tall panes.
  const preferHorizontal = rect.width >= rect.height;
  const chooseHorizontal = () =>
    relX < 0.5
      ? chooseAllowedZone("left", "right", isZoneAllowed)
      : chooseAllowedZone("right", "left", isZoneAllowed);
  const chooseVertical = () =>
    relY < 0.5
      ? chooseAllowedZone("top", "bottom", isZoneAllowed)
      : chooseAllowedZone("bottom", "top", isZoneAllowed);

  if (preferHorizontal) {
    if (relX < EDGE_REGION_FRACTION && isZoneAllowed("left")) return "left";
    if (relX > 1 - EDGE_REGION_FRACTION && isZoneAllowed("right")) return "right";
    return chooseVertical();
  }

  if (relY < EDGE_REGION_FRACTION && isZoneAllowed("top")) return "top";
  if (relY > 1 - EDGE_REGION_FRACTION && isZoneAllowed("bottom")) return "bottom";
  return chooseHorizontal();
}

export function dropZoneToDirectionSide(zone: DropZone): {
  direction: SplitDirection;
  side: SplitDropSide;
} {
  if (zone === "top") return { direction: "vertical", side: "first" };
  if (zone === "bottom") return { direction: "vertical", side: "second" };
  if (zone === "left") return { direction: "horizontal", side: "first" };
  return { direction: "horizontal", side: "second" };
}

// Applies the same thread constraints for hover feedback and the final drop.
export function isThreadDragPayloadAllowed(
  payload: ThreadDragPayload,
  rules: ThreadDropRules,
): boolean {
  if (rules.excludedThreadIds?.has(payload.threadId)) return false;
  return true;
}

export function ChatPaneDropOverlay(props: ChatPaneDropOverlayProps) {
  const { onDrop, canDropInDirection, excludedThreadIds, paneScopeId, className, children } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const rectMeasuredAtRef = useRef(0);
  const activeZoneRef = useRef<DropZone | null>(null);

  const isZoneAllowed = (zone: DropZone): boolean => {
    const { direction } = dropZoneToDirectionSide(zone);
    return canDropInDirection ? canDropInDirection(direction) : true;
  };

  const setPreviewZone = (zone: DropZone | null) => {
    const preview = previewRef.current;
    if (!preview) return;
    const nextClassName = zone
      ? cn(DROP_ZONE_PREVIEW_BASE_CLASS, DROP_ZONE_PREVIEW_CLASS[zone])
      : "";
    if (activeZoneRef.current === zone && preview.className === nextClassName) return;
    activeZoneRef.current = zone;
    if (zone === null) {
      preview.removeAttribute("data-chat-pane-drop-zone");
      preview.className = "";
      return;
    }
    preview.dataset.chatPaneDropZone = zone;
    preview.className = nextClassName;
  };

  const resetOverlayState = () => {
    rectRef.current = null;
    rectMeasuredAtRef.current = 0;
    setPreviewZone(null);
  };

  const getCurrentRect = () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return null;
    const now = performance.now();
    if (!rectRef.current || now - rectMeasuredAtRef.current >= 16) {
      rectRef.current = wrapper.getBoundingClientRect();
      rectMeasuredAtRef.current = now;
    }
    return rectRef.current;
  };

  const getZoneForEvent = (event: ReactDragEvent<HTMLDivElement>) =>
    getDropZoneFromPointer(
      getCurrentRect() ?? EMPTY_RECT,
      event.clientX,
      event.clientY,
      isZoneAllowed,
    );

  const getAllowedZoneForEvent = (event: ReactDragEvent<HTMLDivElement>) => {
    const zone = getZoneForEvent(event);
    if (!zone) return null;
    const payload = parseThreadDragPayload(event.dataTransfer);
    if (
      payload &&
      !isThreadDragPayloadAllowed(payload, {
        excludedThreadIds,
      })
    ) {
      return null;
    }
    return zone;
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadDragType(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    rectRef.current = wrapperRef.current?.getBoundingClientRect() ?? null;
    rectMeasuredAtRef.current = performance.now();
    const zone = getAllowedZoneForEvent(event);
    event.dataTransfer.dropEffect = zone ? "move" : "none";
    setPreviewZone(zone);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadDragType(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const zone = getAllowedZoneForEvent(event);
    event.dataTransfer.dropEffect = zone ? "move" : "none";
    setPreviewZone(zone);
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadDragType(event.dataTransfer)) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const related = event.relatedTarget as Node | null;
    if (related && wrapper.contains(related)) return;
    resetOverlayState();
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadDragType(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const zone = getZoneForEvent(event);
    const payload = parseThreadDragPayload(event.dataTransfer);

    resetOverlayState();

    if (!zone || !payload) return;
    if (!isThreadDragPayloadAllowed(payload, { excludedThreadIds })) return;
    const { direction, side } = dropZoneToDirectionSide(zone);
    onDrop({ ...payload, direction, side });
  };

  useEffect(() => {
    resetOverlayState();
    return resetOverlayState;
  }, [paneScopeId, resetOverlayState]);

  return (
    <div
      ref={wrapperRef}
      data-chat-pane-drop-overlay="true"
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      <div className="pointer-events-none absolute inset-0 z-50" data-chat-pane-drop-zones="true">
        <div ref={previewRef} data-chat-pane-drop-zone-active="true" />
      </div>
    </div>
  );
}
