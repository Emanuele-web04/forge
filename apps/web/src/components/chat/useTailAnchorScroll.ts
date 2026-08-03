// FILE: useTailAnchorScroll.ts
// Purpose: Slide a just-sent user message to the top of the transcript viewport
//          and own the scroll until that slide settles.
// Layer: Chat transcript behavior hook
// Why: The space that lets the message anchor at the top while the response
//      streams below it is reserved natively by LegendList's `anchoredEndSpace`
//      (configured in MessagesTimeline), which keeps the reserve in sync with
//      measured row sizes inside the list's own layout pass. This hook performs
//      the one visible motion — moving the sent message to its anchored
//      coordinate — as a single frame loop that re-reads that coordinate every
//      frame. Re-targeting is what keeps the motion glitch-free: the anchor's
//      position moves while the slide is in flight (the end-space reserve grows,
//      rows above settle from estimated to measured heights, pre-turn status rows
//      land), and a fixed-target native smooth scroll would land wrong and then
//      need a visible correction. The motion is eased in the message's own
//      visible offset rather than in scrollTop, so it stays on schedule while the
//      transcript's scroll geometry changes underneath it. While the loop runs,
//      the shared flag pauses ChatView's auto-follow re-snaps so the motion has a
//      single scroll owner. After the anchor first lands, corrections snap
//      instead of easing, so the message is rigidly held rather than drifting
//      back into place.

import { type MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useLayoutEffect, useRef, type RefObject } from "react";

import { ANCHOR_SLIDE_DURATION_MS, anchorSlideOffsetPx } from "./transcriptScroll";

// Absolute bound on the slide plus its hold, so a transcript that never stops
// moving can never hold the auto-follow pause open.
const ANCHOR_SLIDE_MAX_MS = 3_000;
// After the anchor lands, ownership is kept until the transcript stops moving it
// for this long. Releasing on "landed" alone is not enough: rows above the
// anchor keep settling to their measured height for a few hundred milliseconds
// after a send, and each one would shove the message off its coordinate.
const ANCHOR_HOLD_QUIET_MS = 450;
// Steering an already-streaming turn keeps holding the coordinate for a beat:
// the previous assistant row can still receive late chunks above the new anchor.
const STEER_ANCHOR_MIN_SETTLE_MS = 500;
// A freshly appended anchor row can take a few frames to be committed. Until it
// exists there is nothing to measure, so the loop waits rather than giving up.
const ANCHOR_MOUNT_MAX_WAIT_MS = 1_000;
// Consecutive frames the response has to overflow the reserve before the hold
// hands off to follow-the-tail, so a one-frame reserve recompute in the middle
// of a stream cannot end the hold early.
const ANCHOR_OVERFLOW_HANDOFF_FRAMES = 3;
// How far past the viewport bottom the transcript may sit while the anchor is
// held before that counts as overflow. While the reserve is doing its job the
// tail sits exactly at the viewport bottom, so this only has to cover
// reserve-recompute rounding.
const ANCHOR_OVERFLOW_SLACK_PX = 8;
// A freshly committed row can report a transient position for one frame before
// the list assigns its real offset. The first move of the slide waits for the
// row's content position to repeat, but no longer than this.
const ANCHOR_POSITION_CONFIRM_MAX_MS = 150;

interface UseTailAnchorScrollOptions {
  listRef: RefObject<LegendListRef | null>;
  timelineRootRef: RefObject<HTMLElement | null>;
  /** User message currently anchored at the viewport top; null releases the hook. */
  anchorMessageId: MessageId | null;
  /**
   * Shared flag owned by ChatView: true from send until this hook finishes the
   * anchored slide. While set, ChatView's auto-follow re-snaps stay quiet so the
   * slide has a single scroll owner and cannot be preempted mid-flight.
   */
  anchorScrollInFlightRef?: RefObject<boolean> | undefined;
  /** Lets the list suspend its own end-follow until the anchor slide is settled. */
  onAnchorSlideFinished?: ((messageId: MessageId) => void) | undefined;
  /** Changes whenever transcript content may have moved the anchor row. */
  contentChangeSignal?: unknown;
  /** Normal sends slide; steering an already-streaming turn anchors immediately. */
  animateAnchorSlide?: boolean | undefined;
}

function getScrollContainer(listRef: RefObject<LegendListRef | null>): HTMLElement | null {
  const node: unknown = listRef.current?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

/**
 * scrollTop that puts the anchored message's top edge one top-inset below the
 * viewport top, clamped to the currently reachable range. Derived from the
 * anchor's own box so it is exact regardless of the virtualized list's estimated
 * positions, and re-read every frame so the slide tracks the coordinate as the
 * native end-space reserve makes more of it reachable.
 */
function anchoredScrollTargetPx(
  container: HTMLElement,
  anchorElement: HTMLElement | null,
  topInsetPx: number,
): {
  desired: number;
  clamped: number;
  maxScrollTopPx: number;
  offsetFromViewportTop: number;
} | null {
  if (!anchorElement || anchorElement.getClientRects().length === 0) {
    return null;
  }
  const offsetFromViewportTop =
    anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const maxScrollTopPx = Math.max(0, container.scrollHeight - container.clientHeight);
  const desired = Math.max(0, container.scrollTop + offsetFromViewportTop - topInsetPx);
  return {
    desired,
    clamped: Math.min(maxScrollTopPx, desired),
    maxScrollTopPx,
    offsetFromViewportTop,
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useTailAnchorScroll({
  listRef,
  timelineRootRef,
  anchorMessageId,
  anchorScrollInFlightRef,
  onAnchorSlideFinished,
  contentChangeSignal,
  animateAnchorSlide = true,
}: UseTailAnchorScrollOptions): void {
  const anchorSlideCorrectionRef = useRef<(() => void) | null>(null);
  const animateAnchorSlideRef = useRef(animateAnchorSlide);

  // Capture the mode selected for each new anchor without restarting an active
  // steering settle when `followLiveOutput` later flips to false.
  useLayoutEffect(() => {
    animateAnchorSlideRef.current = animateAnchorSlide;
  }, [anchorMessageId, animateAnchorSlide]);

  useLayoutEffect(() => {
    if (anchorMessageId === null) {
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      return;
    }

    const anchorId = anchorMessageId;
    // Steering (and reduced motion) skips the eased approach: the coordinate is
    // taken immediately and then held.
    const easeToAnchor = animateAnchorSlideRef.current && !prefersReducedMotion();
    if (anchorScrollInFlightRef) {
      anchorScrollInFlightRef.current = true;
    }

    let disposed = false;
    let frameId: number | null = null;
    let layoutObserver: MutationObserver | null = null;
    // The transcript's top padding is fixed for the life of a slide, so the
    // (layout-forcing) computed-style read is done once instead of every frame.
    let topInsetPx: number | null = null;
    const startedAt = performance.now();
    // Flips once the anchor first reaches its coordinate — which requires the
    // reserve below it to exist, so this stays false while the message is still
    // parked at the bottom. From then on the hold is rigid (corrections snap
    // instead of easing), so late layout shifts move the message by at most one
    // frame instead of drifting it back into place.
    let hasLanded = false;
    let lastCorrectionAt = startedAt;
    let overflowFrames = 0;
    // Last observed content position of the anchor, used to confirm the row has
    // really been laid out before the slide commits to a coordinate.
    let confirmedDesired: number | null = null;
    // Set on the first frame the anchor row can be measured, together with the
    // offset the glide starts from. Both are re-seeded if an early frame shows
    // the row was still mid-layout when they were taken.
    let glideStartedAt: number | null = null;
    let glideFromOffsetPx = 0;
    // Once the reserve has been deep enough to lift the anchor even once, a
    // later shortfall means the response outgrew it — the hand-off below, not a
    // reserve that has yet to appear.
    let hasBeenReachable = false;

    function stopFrameLoop(): void {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      anchorSlideCorrectionRef.current = null;
      layoutObserver?.disconnect();
      layoutObserver = null;
    }

    // The slide is over (or was never possible): hand scroll ownership back to
    // ChatView's auto-follow machinery.
    function finishAnchorSlide(): void {
      stopFrameLoop();
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      onAnchorSlideFinished?.(anchorId);
    }

    function findAnchorElement(): HTMLElement | null {
      return (
        timelineRootRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(anchorId)}"]`,
        ) ?? null
      );
    }

    /** One step of the slide. Returns true when the anchor is done moving. */
    function advanceAnchorSlide(now: number): boolean {
      if (disposed) {
        return true;
      }
      // A pointer/wheel/touch gesture clears the shared flag in ChatView. Do not
      // pull the transcript back after the user takes over the scroll.
      if (anchorScrollInFlightRef && !anchorScrollInFlightRef.current) {
        finishAnchorSlide();
        return true;
      }
      const elapsedMs = now - startedAt;

      const container = getScrollContainer(listRef);
      if (container && topInsetPx === null) {
        topInsetPx = Number.parseFloat(window.getComputedStyle(container).paddingTop) || 0;
      }
      const target = container
        ? anchoredScrollTargetPx(container, findAnchorElement(), topInsetPx ?? 0)
        : null;
      if (!container || target === null) {
        // The row has not been committed yet: keep waiting instead of finishing
        // at whatever offset the transcript happens to sit at.
        if (elapsedMs < ANCHOR_MOUNT_MAX_WAIT_MS) {
          return false;
        }
        finishAnchorSlide();
        return true;
      }

      // `desired` is the anchor's own position in the content, so it does not
      // change just because the transcript scrolls. Before the first move, a
      // value that does not repeat means the row was measured mid-layout —
      // acting on it would snap the transcript to a coordinate the message
      // never had, and the correction back is the visible jump. Only the
      // snapping path needs this: the glide below re-seeds instead of waiting,
      // because the frames spent waiting are the frames it has to animate in.
      if (!easeToAnchor && !hasLanded && elapsedMs < ANCHOR_POSITION_CONFIRM_MAX_MS) {
        const settled =
          confirmedDesired !== null && Math.abs(target.desired - confirmedDesired) <= 1;
        confirmedDesired = target.desired;
        if (!settled) {
          return false;
        }
      }

      // The coordinate is only reachable once the native end-space reserve is
      // large enough to lift the anchor to the top; until then the message is
      // still parked at the bottom and has not landed, however close scrollTop
      // is to the (clamped) target.
      const reachable = target.desired <= target.clamped + 1;
      hasBeenReachable = hasBeenReachable || reachable;
      // The mirror image: holding the anchor at the top leaves the live tail
      // below the viewport bottom, so the response has outgrown its reserve.
      // That is the hand-off to the list's own follow-the-tail — from here the
      // anchor is meant to scroll up and out of view.
      if (hasLanded && target.maxScrollTopPx - target.desired > ANCHOR_OVERFLOW_SLACK_PX) {
        overflowFrames += 1;
        if (overflowFrames >= ANCHOR_OVERFLOW_HANDOFF_FRAMES) {
          // Complete the motion the hand-off implies rather than releasing at
          // the held coordinate: the tail is what the reader is following now,
          // and the list only re-sticks on its next content change, so leaving
          // it here would strand the transcript short of the live edge.
          container.scrollTop = target.maxScrollTopPx;
          finishAnchorSlide();
          return true;
        }
      } else {
        overflowFrames = 0;
      }

      // The glide is expressed in the anchor's own visible offset, so it starts
      // from wherever the message is actually painted on the first frame it can
      // be measured — not from the reserve being ready. Waiting for that would
      // hand the opening frames to the list, which puts the anchor at the top by
      // itself, leaving the glide nothing to travel and the reader a jump.
      // Capped at one viewport so a send from far up the transcript still glides
      // a readable distance instead of blurring across thousands of pixels.
      const restOffsetPx = topInsetPx ?? 0;
      if (easeToAnchor && !hasLanded) {
        const scheduledOffsetPx =
          glideStartedAt === null
            ? Number.POSITIVE_INFINITY
            : anchorSlideOffsetPx({
                fromPx: glideFromOffsetPx,
                toPx: restOffsetPx,
                elapsedMs: now - glideStartedAt,
              });
        // Finding the message below where the glide expects it means the glide
        // never actually moved it. Two causes, both answered by restarting the
        // schedule from where the message really is rather than yanking it up:
        // the reserve is not yet deep enough to lift the anchor at all (the
        // motion has not started, so its clock should not be running either), or
        // the seed was taken from a row still mid-layout, which can report a
        // transient position for a frame after being committed.
        const belowSchedule = target.offsetFromViewportTop > scheduledOffsetPx + 1;
        if (
          glideStartedAt === null ||
          (belowSchedule && (!hasBeenReachable || elapsedMs < ANCHOR_POSITION_CONFIRM_MAX_MS))
        ) {
          glideFromOffsetPx = Math.min(
            Math.max(target.offsetFromViewportTop, restOffsetPx),
            container.clientHeight,
          );
          glideStartedAt = now;
        }
      }

      // The glide is over the instant its schedule is spent, so the frame that
      // would land it takes the absolute coordinate below instead. Relative
      // placement accumulates the sub-pixel error of every rect it was measured
      // against; the hold has to be exact, because from here it is compared
      // against `target.clamped` to decide the anchor has arrived.
      const glideElapsedMs = glideStartedAt === null ? 0 : now - glideStartedAt;
      const gliding =
        glideStartedAt !== null && !hasLanded && glideElapsedMs < ANCHOR_SLIDE_DURATION_MS;
      // While it does run, positioning the anchor relative to where it was just
      // measured keeps the motion on schedule even as the content above it
      // resizes: the scroll coordinate that holds a given visible offset moves,
      // the visible offset does not.
      const nextScrollTopPx = gliding
        ? Math.min(
            target.maxScrollTopPx,
            Math.max(
              0,
              container.scrollTop +
                target.offsetFromViewportTop -
                anchorSlideOffsetPx({
                  fromPx: glideFromOffsetPx,
                  toPx: restOffsetPx,
                  elapsedMs: glideElapsedMs,
                }),
            ),
          )
        : target.clamped;

      // Anything that moved the anchor off its coordinate since the last frame
      // is a correction; while they keep arriving the hook keeps ownership.
      if (Math.abs(nextScrollTopPx - container.scrollTop) > 0.5) {
        lastCorrectionAt = now;
        container.scrollTop = nextScrollTopPx;
      }

      if (gliding) {
        return false;
      }

      if (reachable && Math.abs(target.clamped - container.scrollTop) <= 1) {
        hasLanded = true;
      } else {
        lastCorrectionAt = now;
      }

      const minHoldMs = easeToAnchor ? 0 : STEER_ANCHOR_MIN_SETTLE_MS;
      const quiet = hasLanded && now - lastCorrectionAt >= ANCHOR_HOLD_QUIET_MS;
      if ((!quiet || elapsedMs < minHoldMs) && elapsedMs < ANCHOR_SLIDE_MAX_MS) {
        return false;
      }
      finishAnchorSlide();
      return true;
    }

    anchorSlideCorrectionRef.current = () => {
      advanceAnchorSlide(performance.now());
    };
    const timelineRoot = timelineRootRef.current;
    if (timelineRoot && typeof MutationObserver !== "undefined") {
      layoutObserver = new MutationObserver(() => {
        anchorSlideCorrectionRef.current?.();
      });
      // LegendList repositions rows — and re-issues its own end-follow scroll —
      // by mutating inline styles mid-frame, after this loop's rAF step has
      // already run. Correcting from the mutation itself puts the anchor back on
      // its coordinate before paint; waiting for the next rAF instead leaves the
      // anchored message visibly displaced for that frame. The observer only
      // lives for the duration of the slide and its hold.
      layoutObserver.observe(timelineRoot, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    }

    // Deliberately ignores the timestamp the frame callback is handed: it is the
    // frame's projected presentation time, which does not share an origin with
    // the `performance.now()` the mutation-driven corrections below read. Mixing
    // the two makes the eased progress jump backwards between a frame and the
    // correction that follows it, which the reader sees as the message dropping
    // back down mid-glide. One clock for every step keeps the motion monotonic.
    const step = () => {
      frameId = null;
      if (!advanceAnchorSlide(performance.now())) {
        frameId = window.requestAnimationFrame(step);
      }
    };
    frameId = window.requestAnimationFrame(step);

    return () => {
      disposed = true;
      stopFrameLoop();
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
    };
  }, [anchorMessageId, anchorScrollInFlightRef, listRef, onAnchorSlideFinished, timelineRootRef]);

  // React commits streamed text before paint. Re-apply the current slide
  // coordinate in that layout window so a chunk landing above the anchor cannot
  // push the anchored message for one visible frame.
  useLayoutEffect(() => {
    anchorSlideCorrectionRef.current?.();
  }, [contentChangeSignal]);
}
