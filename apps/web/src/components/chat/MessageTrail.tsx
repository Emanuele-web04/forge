// FILE: MessageTrail.tsx
// Purpose: Left-gutter message rail with macOS-Dock-style magnification. The tick
//   nearest the pointer grows longest (Gaussian falloff on its neighbours) and a
//   side tooltip shows that one focused message. Built on Synara's existing scroll
//   engine: `activeStore` carries the current + visible viewport highlights and
//   `onSelect` jumps (shadcn's scrollToMessage). The hot path writes tick width /
//   opacity straight to the DOM inside one coalesced rAF — no React state per move
//   — so it stays smooth and never re-renders the heavy timeline.
// Layer: Chat transcript shell (presentation)
// Depends on: pure magnification math in messageTrail.logic.ts (unit-tested).

import { type MessageId } from "@synara/contracts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "~/lib/utils";
import { DISCLOSURE_CONTENT_MOTION_CLASS } from "~/lib/disclosureMotion";
import { APP_TOOLTIP_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import {
  clampNumber,
  clampTooltipTop,
  computeFocusedIndex,
  computeGaussianWeights,
  computeRestStyles,
  computeSigma,
  computeTickStyles,
  computeTrailGeometry,
  type ActiveTrailStore,
  type MessageTrailItem,
  type TickStyle,
  type TrailGeometry,
} from "./messageTrail.logic";

interface MessageTrailProps {
  items: readonly MessageTrailItem[];
  /** Stable holder for current + visible highlights; only this component re-renders on change. */
  activeStore: ActiveTrailStore;
  onSelect: (messageId: MessageId) => void;
}

// Rail only renders once the centered transcript column (max 46rem) leaves a left
// gutter wide enough for the rail to sit clear of message text. Measured off the
// pane so a docked side panel / the sidebar is accounted for.
const MIN_PANE_WIDTH_PX = 864;
// Fixed rail box. Ticks grow rightward inside it (left-aligned, like the Dock).
const RAIL_WIDTH_PX = 56;
// Cap the scrollable tick viewport a bit below the full pane height so the rail
// reads as a centered band with breathing room; long histories scroll inside it
// (with top/bottom scroll-fade) instead of compressing to a tall solid block.
const RAIL_MAX_HEIGHT_RATIO = 0.8;
// Inset the ticks off the window edge so the rail isn't glued to the far left.
const TICK_LEFT_PAD_PX = 14;
const TICK_HEIGHT_PX = 2;
// Short at rest, long when magnified — a wide base→max gap is what reads as a
// real Dock magnification (left 14 + max 30 = 44px, clears the 56px rail).
const TICK_BASE_W = 6;
const TICK_MAX_W = 30;
// Vertical centre-to-centre gap — kept tight so the ticks read as one close
// stack at rest. The magnified width is independent of this gap (ticks grow
// sideways, not into each other), so tight spacing keeps full magnification.
const TICK_SPACING_PX = 10;
// Resting ticks stay faint; the reading-anchor tick is darker. Opacity is a fixed
// per-state colour — it never follows the cursor as a gradient.
const TICK_REST_OPACITY = 0.2;
const TICK_VISIBLE_OPACITY = 0.52;
const TICK_ANCHOR_OPACITY = 0.9;
// Only the single tick directly under the pointer/keyboard focus goes full black —
// its neighbours just grow in size, they don't darken (no opacity falloff).
const TICK_FOCUS_OPACITY = 1;
const TOOLTIP_ESTIMATED_H_PX = 56;
const TOOLTIP_OFFSET_X_PX = 8;

export function MessageTrail({ items, activeStore, onSelect }: MessageTrailProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipMessageRef = useRef<HTMLDivElement | null>(null);
  const tooltipResponseRef = useRef<HTMLDivElement | null>(null);
  const tickRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tooltipId = useId();

  const [hasGutter, setHasGutter] = useState(false);
  const [rovingIndex, setRovingIndex] = useState(0);

  // Reading-position highlights — fed by the timeline via a stable store so only
  // this rail re-renders when they change.
  const trailSnapshot = useSyncExternalStore(
    activeStore.subscribe,
    activeStore.get,
    activeStore.get,
  );
  const anchorIndex = items.findIndex((item) => item.id === trailSnapshot.currentId);
  const visibleIdSet = new Set(trailSnapshot.visibleIds);
  const visibleIndexes: number[] = [];
  items.forEach((item, index) => {
    if (visibleIdSet.has(item.id)) {
      visibleIndexes.push(index);
    }
  });
  const visibleIndexSet = new Set(visibleIndexes);

  const visible = hasGutter && items.length > 1;

  // Tick layout depends only on the message count (fixed spacing, natural content
  // height) — never on the measured viewport — so the capped/scrolling viewport
  // can't feed its height back into the layout (no ResizeObserver loop).
  const geometry = computeTrailGeometry({ count: items.length, spacingPx: TICK_SPACING_PX });

  // --- Hot-path refs (read inside rAF; never trigger renders) ---------------
  const rafIdRef = useRef<number | null>(null);
  // Raw viewport-relative pointer Y at the last move; content Y is derived per
  // frame by adding the live scrollTop, so magnification follows rail scrolling.
  const latestPointerClientYRef = useRef<number | null>(null);
  const focusOverrideIndexRef = useRef<number | null>(null);
  const geometryRef = useRef<TrailGeometry | null>(geometry);
  const viewportTopRef = useRef(0);
  const tooltipIndexRef = useRef(-1);
  const reducedMotionRef = useRef(false);
  // Mirror render values into refs so the rAF/handlers stay stable and current.
  // Mirrored in an effect (not during render) so the component stays eligible
  // for React Compiler; the rAF loop and handlers only fire post-commit.
  const itemsRef = useRef(items);
  const anchorIndexRef = useRef(anchorIndex);
  const visibleIndexesRef = useRef(visibleIndexes);
  const onSelectRef = useRef(onSelect);
  const visibleRef = useRef(visible);
  useEffect(() => {
    geometryRef.current = geometry;
    itemsRef.current = items;
    anchorIndexRef.current = anchorIndex;
    visibleIndexesRef.current = visibleIndexes;
    onSelectRef.current = onSelect;
    visibleRef.current = visible;
    // Keep the tick-ref array sized to the message count. Truncate only —
    // growth happens via the JSX ref callbacks, which run before this effect,
    // and a full refill here would wipe the elements they just attached.
    if (tickRefs.current.length > items.length) {
      tickRefs.current.length = items.length;
    }
  }, [geometry, items, anchorIndex, visibleIndexes, onSelect, visible]);

  // --- Imperative writers ----------------------------------------------------
  const writeStyles = (styles: readonly TickStyle[]) => {
    const refs = tickRefs.current;
    for (let i = 0; i < styles.length; i += 1) {
      const el = refs[i];
      if (!el) {
        continue;
      }
      el.style.width = `${styles[i]!.width}px`;
      el.style.opacity = `${styles[i]!.opacity}`;
    }
  };

  const hideTooltip = () => {
    tooltipIndexRef.current = -1;
    const tip = tooltipRef.current;
    if (tip) {
      tip.style.visibility = "hidden";
    }
  };

  const showTooltip = (index: number, geometry: TrailGeometry) => {
    const tip = tooltipRef.current;
    const item = itemsRef.current[index];
    if (!tip || !item) {
      return;
    }
    if (tooltipIndexRef.current !== index) {
      tooltipIndexRef.current = index;
      const messageEl = tooltipMessageRef.current;
      const responseEl = tooltipResponseRef.current;
      if (messageEl) {
        messageEl.textContent = item.preview;
      }
      if (responseEl) {
        responseEl.textContent = item.responsePreview;
        // Collapse the gray reply line entirely when the turn has no reply yet.
        responseEl.style.display = item.responsePreview ? "" : "none";
      }
    }
    // Ticks live in scrolling content space; the tooltip is a non-scrolling sibling,
    // so map the tick's centre into the viewport (minus scrollTop) and offset by where
    // the centred viewport sits inside the full-height rail (viewport.offsetTop).
    const viewport = viewportRef.current;
    const viewportHeight = viewport?.clientHeight ?? 0;
    const tooltipHeight = tip.offsetHeight || TOOLTIP_ESTIMATED_H_PX;
    const centerY = geometry.centerYs[index] ?? viewportHeight / 2;
    const visibleY = centerY - (viewport?.scrollTop ?? 0);
    const offsetTop = viewport?.offsetTop ?? 0;
    tip.style.top = `${offsetTop + clampTooltipTop(visibleY, tooltipHeight, viewportHeight)}px`;
    tip.style.visibility = "visible";
  };

  const applyHighlightFloors = (styles: TickStyle[]) => {
    const anchorIndexValue = anchorIndexRef.current;
    for (const index of visibleIndexesRef.current) {
      const style = styles[index];
      if (style) {
        style.opacity = Math.max(style.opacity, TICK_VISIBLE_OPACITY);
      }
    }
    const anchorStyle = anchorIndexValue >= 0 ? styles[anchorIndexValue] : undefined;
    if (anchorStyle) {
      anchorStyle.opacity = Math.max(anchorStyle.opacity, TICK_ANCHOR_OPACITY);
    }
  };

  // Pointer/keyboard away: restore the resting rail (anchor tick highlighted).
  const applyRest = () => {
    const styles = computeRestStyles(
      itemsRef.current.length,
      anchorIndexRef.current,
      TICK_BASE_W,
      TICK_REST_OPACITY,
      TICK_ANCHOR_OPACITY,
    );
    applyHighlightFloors(styles);
    writeStyles(styles);
    hideTooltip();
  };

  // Position the ticks vertically in content space and reset to rest when idle.
  // Width changes never reflow this, so it only runs when the layout changes.
  const layoutTicks = () => {
    const geometryValue = geometryRef.current;
    if (!geometryValue) {
      return;
    }
    const refs = tickRefs.current;
    for (let i = 0; i < refs.length; i += 1) {
      const el = refs[i];
      if (!el) {
        continue;
      }
      const centerY = geometryValue.centerYs[i] ?? 0;
      el.style.top = `${centerY - TICK_HEIGHT_PX / 2}px`;
    }
    if (latestPointerClientYRef.current === null && focusOverrideIndexRef.current === null) {
      applyRest();
    }
  };

  // --- The magnification frame (single coalesced rAF) ------------------------
  const renderFrame = () => {
    rafIdRef.current = null;
    const geometry = geometryRef.current;
    if (!geometry || !visibleRef.current) {
      return;
    }
    const count = itemsRef.current.length;
    if (count === 0) {
      return;
    }
    // Pointer wins over keyboard focus when both are present. The stored pointer Y
    // is viewport-relative; add the live scrollTop to land in tick content space.
    let activeY: number | null = null;
    const rawPointerY = latestPointerClientYRef.current;
    if (rawPointerY !== null) {
      activeY = rawPointerY + (viewportRef.current?.scrollTop ?? 0);
    } else if (focusOverrideIndexRef.current !== null) {
      activeY = geometry.centerYs[focusOverrideIndexRef.current] ?? null;
    }
    if (activeY === null) {
      applyRest();
      return;
    }
    const anchor = anchorIndexRef.current;
    const focusedIndex = computeFocusedIndex(activeY, geometry);

    let styles: TickStyle[];
    if (geometry.spacing === 0 || reducedMotionRef.current) {
      // Degenerate rail or reduced motion: the focused tick jumps to max width with
      // no continuous morphing (its colour is set below, same as the Gaussian branch).
      styles = computeRestStyles(
        count,
        anchor,
        TICK_BASE_W,
        TICK_REST_OPACITY,
        TICK_ANCHOR_OPACITY,
      );
      const focusedStyle = styles[focusedIndex];
      if (focusedStyle) {
        focusedStyle.width = TICK_MAX_W;
      }
    } else {
      // Width grows horizontally while ticks stack vertically (2px tall each), so
      // the focal tick reaches the full TICK_MAX_W regardless of how tight the
      // vertical spacing is — it never overlaps its neighbours.
      const sigma = computeSigma(geometry.spacing);
      const weights = computeGaussianWeights(geometry.centerYs, activeY, sigma);
      styles = computeTickStyles(
        weights,
        anchor,
        TICK_BASE_W,
        TICK_MAX_W,
        TICK_REST_OPACITY,
        TICK_ANCHOR_OPACITY,
      );
    }
    applyHighlightFloors(styles);
    // Darken only the focused tick — neighbours keep their state colour.
    const focusedStyle = styles[focusedIndex];
    if (focusedStyle) {
      focusedStyle.opacity = TICK_FOCUS_OPACITY;
    }
    writeStyles(styles);
    showTooltip(focusedIndex, geometry);
  };

  const scheduleFrame = () => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(renderFrame);
    }
  };

  const cancelFrame = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  // --- Gutter visibility: rail only shows when the pane is wide enough --------
  // Width-only ResizeObserver; the tick layout is count-driven (see `geometry`),
  // so observing size never feeds back into the layout.
  useEffect(() => {
    const root = rootRef.current;
    const pane = root?.parentElement;
    if (!pane || typeof ResizeObserver === "undefined") {
      return;
    }
    let pendingRaf: number | null = null;
    const measure = () => {
      pendingRaf = null;
      setHasGutter(pane.clientWidth >= MIN_PANE_WIDTH_PX);
    };
    const schedule = () => {
      if (pendingRaf === null) {
        pendingRaf = requestAnimationFrame(measure);
      }
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(pane);
    return () => {
      if (pendingRaf !== null) {
        cancelAnimationFrame(pendingRaf);
      }
      observer.disconnect();
    };
  }, []);

  // Reposition the ticks whenever the layout changes (count → new centres).
  useEffect(() => {
    layoutTicks();
  }, [geometry, layoutTicks]);

  // Refresh idle highlights when the current anchor or visible-message set changes.
  useEffect(() => {
    if (latestPointerClientYRef.current === null && focusOverrideIndexRef.current === null) {
      applyRest();
    }
  }, [anchorIndex, applyRest, visibleIndexes]);

  // Read the motion preference once (continuous width morphing is motion).
  useEffect(() => {
    reducedMotionRef.current =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
  }, []);

  // Going inert (narrow pane / N<=1): stop the loop and clear transient state.
  useEffect(() => {
    if (!visible) {
      cancelFrame();
      latestPointerClientYRef.current = null;
      focusOverrideIndexRef.current = null;
      hideTooltip();
    }
  }, [visible, cancelFrame, hideTooltip]);

  // Unmount: MessageTrail outlives thread switches (the timeline is keyed), so a
  // stray in-flight frame must be cancelled.
  useEffect(() => cancelFrame, [cancelFrame]);

  // --- Pointer handlers (mouse / pen only; touch must not hijack scroll) -----
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || !visibleRef.current) {
      return;
    }
    latestPointerClientYRef.current = event.clientY - viewportTopRef.current;
    scheduleFrame();
  };

  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || !visibleRef.current) {
      return;
    }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) {
      viewportTopRef.current = rect.top;
    }
    latestPointerClientYRef.current = event.clientY - viewportTopRef.current;
    scheduleFrame();
  };

  const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      return;
    }
    latestPointerClientYRef.current = null;
    cancelFrame();
    // A keyboard-focused tick keeps its magnification; otherwise go to rest.
    if (focusOverrideIndexRef.current !== null) {
      scheduleFrame();
    } else {
      applyRest();
    }
  };

  // Rail scrolling under a stationary pointer changes which tick is focused, so
  // keep the magnification + tooltip in sync while the pointer/keyboard is engaged.
  const handleScroll = () => {
    if (latestPointerClientYRef.current !== null || focusOverrideIndexRef.current !== null) {
      scheduleFrame();
    }
  };

  // Big hit-area: clicking anywhere on the rail jumps to the nearest tick.
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const geometryValue = geometryRef.current;
    const viewport = viewportRef.current;
    if (!geometryValue || !viewport) {
      return;
    }
    const contentY = event.clientY - viewport.getBoundingClientRect().top + viewport.scrollTop;
    const index = computeFocusedIndex(contentY, geometryValue);
    const item = itemsRef.current[index];
    if (item) {
      onSelectRef.current(item.id);
    }
  };

  // --- Keyboard: one tab stop (roving), arrows move, Enter jumps -------------
  const focusTick = (index: number) => {
    setRovingIndex(index);
    tickRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const count = itemsRef.current.length;
    if (count === 0) {
      return;
    }
    const current = clampNumber(rovingIndex, 0, count - 1);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusTick(Math.min(count - 1, current + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusTick(Math.max(0, current - 1));
        break;
      case "Home":
        event.preventDefault();
        focusTick(0);
        break;
      case "End":
        event.preventDefault();
        focusTick(count - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const item = itemsRef.current[current];
        if (item) {
          onSelectRef.current(item.id);
        }
        break;
      }
      case "Escape":
        tickRefs.current[current]?.blur();
        break;
      default:
        break;
    }
  };

  const handleTickFocus = (index: number) => {
    focusOverrideIndexRef.current = index;
    const geometry = geometryRef.current;
    if (geometry) {
      showTooltip(index, geometry); // synchronous for screen readers
    }
    scheduleFrame();
  };

  const handleRailBlur = (event: ReactFocusEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (root && event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) {
      return; // focus moved between ticks — still inside the rail
    }
    focusOverrideIndexRef.current = null;
    if (latestPointerClientYRef.current === null) {
      applyRest();
    }
  };

  const tabStop = clampNumber(rovingIndex, 0, Math.max(0, items.length - 1));

  return (
    <nav
      ref={rootRef}
      aria-label="Message navigation"
      aria-hidden={!visible}
      onKeyDown={handleKeyDown}
      onBlur={handleRailBlur}
      className={cn(
        "absolute inset-y-0 left-0 z-20 hidden flex-col justify-center sm:flex",
        DISCLOSURE_CONTENT_MOTION_CLASS,
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{ width: RAIL_WIDTH_PX }}
    >
      {/* Capped, centered, scrollable viewport. `scroll-fade-y` masks the top/bottom
          edges only while there is overflow to scroll (auto-off when it all fits). */}
      <div
        ref={viewportRef}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onScroll={handleScroll}
        onClick={handleClick}
        className={cn(
          "scroll-fade-y relative w-full overflow-y-auto overscroll-contain [contain:layout] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          visible ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{ maxHeight: `${RAIL_MAX_HEIGHT_RATIO * 100}%` }}
      >
        <div ref={trackRef} className="relative w-full" style={{ height: geometry?.contentHeight }}>
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                tickRefs.current[index] = el;
              }}
              type="button"
              tabIndex={visible && index === tabStop ? 0 : -1}
              aria-label={`Message ${item.ordinal}: ${item.preview.slice(0, 60)}`}
              aria-describedby={tooltipId}
              aria-current={index === anchorIndex ? "location" : undefined}
              onFocus={() => handleTickFocus(index)}
              className="absolute rounded-full transition-[width,opacity] duration-[90ms] ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)] motion-reduce:transition-none"
              style={{
                left: TICK_LEFT_PAD_PX,
                height: TICK_HEIGHT_PX,
                width: TICK_BASE_W,
                opacity:
                  index === anchorIndex
                    ? TICK_ANCHOR_OPACITY
                    : visibleIndexSet.has(index)
                      ? TICK_VISIBLE_OPACITY
                      : TICK_REST_OPACITY,
                backgroundColor: "var(--color-text-foreground)",
                willChange: "width, opacity",
              }}
            />
          ))}
        </div>
      </div>
      <div
        ref={tooltipRef}
        role="tooltip"
        id={tooltipId}
        className={cn(
          APP_TOOLTIP_SURFACE_CLASS_NAME,
          "pointer-events-none invisible absolute z-30 w-64 -translate-y-1/2 rounded-xl p-2",
        )}
        style={{ left: RAIL_WIDTH_PX + TOOLTIP_OFFSET_X_PX, top: 0 }}
      >
        {/* The sent message: dark, max two lines (matches the projects/threads card title). */}
        <div
          ref={tooltipMessageRef}
          className="line-clamp-2 text-xs leading-snug font-medium text-foreground"
        />
        {/* The turn's first reply: muted gray, max three lines. */}
        <div
          ref={tooltipResponseRef}
          className="mt-1 line-clamp-3 text-xs leading-snug text-muted-foreground"
        />
      </div>
    </nav>
  );
}
