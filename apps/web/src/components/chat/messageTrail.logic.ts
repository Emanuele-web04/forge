// FILE: messageTrail.logic.ts
// Purpose: Pure helpers for the left-edge message navigation trail — project the
//   timeline into one tick per sent message and resolve which tick is active.
// Layer: Chat transcript shell (presentation-adjacent logic, unit-tested)
// Depends on: timeline entry shape only — no React, no DOM.

import { type MessageId } from "@synara/contracts";
import { type TimelineEntry } from "../../session-logic";

/** One tick on the navigation trail — a single message the user sent. */
export interface MessageTrailItem {
  id: MessageId;
  /** 1-based position among sent messages, used for labels/aria. */
  ordinal: number;
  /** Whitespace-normalized, length-capped text for the hover preview (the sent message). */
  preview: string;
  /**
   * Whitespace-normalized, length-capped start of the turn's final assistant message
   * — the muted second line in the hover card. This is the end-of-turn reply (the
   * message that lands after the turn's work), not the opening preamble. Empty when
   * the turn has produced no assistant text yet.
   */
  responsePreview: string;
  /** Number of attachments on the message (rendered as a small hint). */
  attachmentCount: number;
}

/** Hard cap so a pathological paste can't bloat the hover-card payload. */
const MAX_PREVIEW_LENGTH = 280;

function normalizePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_PREVIEW_LENGTH
    ? `${collapsed.slice(0, MAX_PREVIEW_LENGTH).trimEnd()}…`
    : collapsed;
}

// Store messages are immutable — a text change produces a new message object —
// so the object itself keys its normalized preview. Without this, every
// transcript render re-runs the whitespace regex over the full text of every
// message, which is O(total transcript text) per streaming flush.
const previewByMessage = new WeakMap<object, string>();

function normalizePreviewCached(message: { readonly text: string }): string {
  const cached = previewByMessage.get(message);
  if (cached !== undefined) {
    return cached;
  }
  const preview = normalizePreview(message.text);
  previewByMessage.set(message, preview);
  return preview;
}

// The timeline entry array is itself immutable (rebuilt only when its inputs
// change), so repeat renders off the same entries reuse the whole projection.
const trailItemsByEntries = new WeakMap<readonly TimelineEntry[], MessageTrailItem[]>();

/**
 * Project the timeline into one trail item per user message, in transcript order.
 * Each item also carries the start of its turn's *final* assistant message (the muted
 * second line in the hover card) — the reply that lands after the turn's work, not the
 * opening preamble. System / work rows are skipped, and a turn with no assistant text
 * yet keeps an empty `responsePreview`.
 */
export function deriveMessageTrailItems(
  timelineEntries: readonly TimelineEntry[],
): MessageTrailItem[] {
  const cachedItems = trailItemsByEntries.get(timelineEntries);
  if (cachedItems !== undefined) {
    return cachedItems;
  }
  const items: MessageTrailItem[] = [];
  // Index of the user item whose turn we're inside; every non-empty assistant row
  // overwrites its response so the last one (the end-of-turn message) wins.
  let currentTurnIndex = -1;
  for (const entry of timelineEntries) {
    if (entry.kind !== "message") {
      continue;
    }
    const { role } = entry.message;
    if (role === "user") {
      items.push({
        id: entry.message.id,
        ordinal: items.length + 1,
        preview: normalizePreviewCached(entry.message),
        responsePreview: "",
        attachmentCount: entry.message.attachments?.length ?? 0,
      });
      currentTurnIndex = items.length - 1;
    } else if (role === "assistant" && currentTurnIndex >= 0) {
      const responsePreview = normalizePreviewCached(entry.message);
      if (responsePreview !== "") {
        items[currentTurnIndex]!.responsePreview = responsePreview;
      }
    }
  }
  trailItemsByEntries.set(timelineEntries, items);
  return items;
}

/** A sent-message row paired with its index in the virtualized row list. */
export interface MessageTrailAnchor {
  id: MessageId;
  rowIndex: number;
}

/**
 * Resolve the active trail anchor from the topmost row currently in view.
 *
 * "Active" is the last sent message at or above the top of the viewport — i.e.
 * the turn you are currently reading, even when the user bubble itself has
 * scrolled above the fold beneath a long assistant reply. Anchors must be sorted
 * by ascending `rowIndex` (transcript order); the topmost index is `0`.
 */
export function resolveActiveTrailMessageId(
  anchors: readonly MessageTrailAnchor[],
  topVisibleRowIndex: number,
): MessageId | null {
  if (anchors.length === 0) {
    return null;
  }
  // Default to the first anchor so a viewport sitting above the first sent
  // message (e.g. a leading system bubble) still highlights something sensible.
  let activeId: MessageId = anchors[0]!.id;
  for (const anchor of anchors) {
    if (anchor.rowIndex <= topVisibleRowIndex) {
      activeId = anchor.id;
    } else {
      break;
    }
  }
  return activeId;
}

/** Current reading anchor plus every sent-message row visible in the viewport. */
export interface ActiveTrailSnapshot {
  currentId: MessageId | null;
  visibleIds: readonly MessageId[];
}

export const EMPTY_ACTIVE_TRAIL_SNAPSHOT: ActiveTrailSnapshot = {
  currentId: null,
  visibleIds: [],
};

function areMessageIdListsEqual(a: readonly MessageId[], b: readonly MessageId[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function areActiveTrailSnapshotsEqual(
  a: ActiveTrailSnapshot,
  b: ActiveTrailSnapshot,
): boolean {
  return a.currentId === b.currentId && areMessageIdListsEqual(a.visibleIds, b.visibleIds);
}

/**
 * Resolve both the current reading anchor and the sent messages directly visible
 * inside the viewport range. The current anchor can sit above the viewport during
 * a long assistant reply; visible ids only include user rows within `[top, bottom]`.
 */
export function resolveActiveTrailSnapshot(
  anchors: readonly MessageTrailAnchor[],
  topVisibleRowIndex: number,
  bottomVisibleRowIndex: number,
): ActiveTrailSnapshot {
  if (anchors.length === 0 || !Number.isFinite(topVisibleRowIndex)) {
    return EMPTY_ACTIVE_TRAIL_SNAPSHOT;
  }
  const currentId = resolveActiveTrailMessageId(anchors, topVisibleRowIndex);
  const bottomRowIndex = Number.isFinite(bottomVisibleRowIndex)
    ? Math.max(topVisibleRowIndex, bottomVisibleRowIndex)
    : topVisibleRowIndex;
  const visibleIds: MessageId[] = [];
  for (const anchor of anchors) {
    if (anchor.rowIndex < topVisibleRowIndex) {
      continue;
    }
    if (anchor.rowIndex > bottomRowIndex) {
      break;
    }
    visibleIds.push(anchor.id);
  }
  return visibleIds.length === 0 && currentId === null
    ? EMPTY_ACTIVE_TRAIL_SNAPSHOT
    : { currentId, visibleIds };
}

/**
 * A stable subscribable holder for current + visible trail highlights.
 *
 * The producer (MessagesTimeline) and consumer (MessageTrail) are siblings under
 * a memoized transcript pane. Threading this through that pane's state
 * would re-render the heavy timeline on every scroll, so it flows through this
 * store instead: the pane creates it once, hands `set` to the timeline and the
 * whole store to the trail, and only the trail re-renders on change.
 */
export interface ActiveTrailStore {
  get: () => ActiveTrailSnapshot;
  set: (value: ActiveTrailSnapshot | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createActiveTrailStore(): ActiveTrailStore {
  let current: ActiveTrailSnapshot = EMPTY_ACTIVE_TRAIL_SNAPSHOT;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (value) => {
      const next = value ?? EMPTY_ACTIVE_TRAIL_SNAPSHOT;
      if (areActiveTrailSnapshotsEqual(next, current)) {
        return;
      }
      current = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// macOS-Dock-style magnification math
//
// The rail magnifies the tick nearest the pointer and tapers neighbours off with
// a Gaussian falloff. Everything here is pure and finite-safe so the same formula
// works for 1 message or 1000: the component just feeds it measured geometry and
// the pointer position. Each function is unit-tested in messageTrail.logic.test.ts.
// ---------------------------------------------------------------------------

/** Clamp `value` into `[min, max]`, finite-safe (returns `min` if the range is inverted). */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (max < min) {
    return min;
  }
  return value < min ? min : value > max ? max : value;
}

/** Fixed vertical layout of the ticks; widths never affect these positions. */
export interface TrailGeometry {
  /** Vertical centre (px) of the first tick. */
  startY: number;
  /** Centre-to-centre distance (px); 0 when there is a single (or degenerate) tick. */
  spacing: number;
  /** Vertical centre (px) of every tick, in order. */
  centerYs: number[];
  /**
   * Total content height (px) the ticks occupy = `2*padding + (count-1)*spacing`.
   * The rail caps its viewport below this and scrolls; deriving it from the count
   * (never from the measured viewport) is what keeps geometry free of any
   * size→layout→size ResizeObserver feedback loop.
   */
  contentHeight: number;
}

/**
 * Lay the ticks out top-down at a fixed `spacingPx`, in their own content space.
 * The layout depends only on the message count — never on the measured viewport —
 * so the rail can cap + scroll its viewport without feeding height back into the
 * layout. Returns `null` for N=0 so the caller can skip all pointer handling.
 */
export function computeTrailGeometry(input: {
  count: number;
  spacingPx?: number;
  paddingPx?: number;
}): TrailGeometry | null {
  const count = input.count;
  const spacing = count <= 1 ? 0 : (input.spacingPx ?? 10);
  const padding = input.paddingPx ?? 12;
  if (count <= 0) {
    return null;
  }
  const centerYs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    centerYs.push(padding + i * spacing);
  }
  return {
    startY: padding,
    spacing,
    centerYs,
    contentHeight: 2 * padding + (count - 1) * spacing,
  };
}

/**
 * Gaussian sigma tied to tick density so the focus radius stays ~1.5 ticks
 * whether the rail is sparse or dense: `clamp(spacing*1.5, min(spacing*2, 8), 22)`.
 * Irrelevant when `spacing === 0` (single tick) — callers skip the Gaussian then.
 */
export function computeSigma(spacing: number): number {
  return clampNumber(spacing * 1.5, Math.min(spacing * 2, 8), 22);
}

/** Per-tick Gaussian weight in `[0, 1]`; exactly `1` for the tick under the pointer. */
export function computeGaussianWeights(
  centerYs: readonly number[],
  pointerY: number,
  sigma: number,
): number[] {
  if (sigma <= 0) {
    return centerYs.map((centerY) => (centerY === pointerY ? 1 : 0));
  }
  const twoSigmaSquared = 2 * sigma * sigma;
  return centerYs.map((centerY) => {
    const distance = centerY - pointerY;
    return Math.exp(-(distance * distance) / twoSigmaSquared);
  });
}

/** Resolved width/opacity for one tick. */
export interface TickStyle {
  width: number;
  opacity: number;
}

/**
 * Map Gaussian weights to width only — opacity stays a fixed per-state colour.
 * Width lerps `baseW → effectiveMaxW` with the weight (the Dock size effect), but
 * the colour never follows the cursor: each tick keeps its state opacity (anchor
 * dark, everything else at `restOpacity`); the visible-in-viewport mid tone is
 * layered on afterwards by the caller. Only the size changes under the pointer.
 */
export function computeTickStyles(
  weights: readonly number[],
  currentAnchorIndex: number | null,
  baseW: number,
  effectiveMaxW: number,
  restOpacity: number,
  anchorOpacity: number,
): TickStyle[] {
  return weights.map((weight, index) => ({
    width: baseW + (effectiveMaxW - baseW) * weight,
    opacity: index === currentAnchorIndex ? anchorOpacity : restOpacity,
  }));
}

/** Rest-state styles (pointer away): all `baseW`, anchor brightened. */
export function computeRestStyles(
  count: number,
  currentAnchorIndex: number | null,
  baseW: number,
  restOpacity: number,
  anchorOpacity: number,
): TickStyle[] {
  const styles: TickStyle[] = [];
  for (let i = 0; i < count; i += 1) {
    styles.push({ width: baseW, opacity: i === currentAnchorIndex ? anchorOpacity : restOpacity });
  }
  return styles;
}

/**
 * Index of the tick nearest `pointerY`. Clamps `pointerY` into the tick range
 * first so positions above/below the rail resolve to the first/last tick rather
 * than out-of-range. Always returns `0` for a single/degenerate rail. Finite-safe.
 */
export function computeFocusedIndex(pointerY: number, geometry: TrailGeometry): number {
  const count = geometry.centerYs.length;
  if (count <= 1 || geometry.spacing === 0) {
    return 0;
  }
  if (!Number.isFinite(pointerY)) {
    return 0;
  }
  const endY = geometry.startY + (count - 1) * geometry.spacing;
  const clampedY = clampNumber(pointerY, geometry.startY, endY);
  const raw = Math.round((clampedY - geometry.startY) / geometry.spacing);
  return clampNumber(raw, 0, count - 1);
}

/**
 * Keep the focused-message tooltip fully on-screen by clamping its vertical centre
 * into `[tooltipH/2 + margin, railH - tooltipH/2 - margin]` (caller keeps a
 * `translateY(-50%)`). Range-safe when the rail is shorter than the tooltip.
 */
export function clampTooltipTop(
  centerY: number,
  tooltipH: number,
  railH: number,
  margin = 4,
): number {
  const half = tooltipH / 2 + margin;
  return clampNumber(centerY, half, Math.max(half, railH - half));
}
