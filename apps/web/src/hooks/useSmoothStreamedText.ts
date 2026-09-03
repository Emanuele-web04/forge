// FILE: useSmoothStreamedText.ts
// Purpose: Reveal streamed assistant text at a steady, adaptive cadence so tokens appear
//          fluidly instead of in the ~100ms network clumps that land in the store.
// Layer: Web UI streaming primitive
// Exports: useSmoothStreamedText, stepSmoothReveal (pure stepper, unit-tested)
// Why: The transport coalesces deltas into one store update per ~100ms
//      (apps/web/src/routes/__root.tsx Throttler), so rendering each clump verbatim looks
//      choppy. This hook drains the already-delivered buffer on requestAnimationFrame at a
//      velocity that adapts to the backlog, low-pass-smooths that velocity so there are
//      no jarring speed jumps, and sleeps between bursts once it catches up. It feeds the
//      same text ChatMarkdown already defers, so the markdown re-parse stays coalesced by
//      useDeferredValue: this hook governs *cadence*, not parse cost.
//      The reveal position advances every frame, but React commits are quantized to
//      MIN_EMIT_INTERVAL_MS: one setState per frame (~120/s on a 120Hz display, each
//      re-rendering the growing message) is the dominant CPU cost of a streaming turn,
//      while a ~25/s multi-character reveal is visually equivalent.

import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "./useMediaQuery";

// Drain the current backlog over this window. Kept above the ~100ms network flush so a
// small backlog cushion always remains and the reveal tracks inflow without running dry.
const DRAIN_WINDOW_SECONDS = 0.16;
// Hard ceiling so a single huge flush (e.g. a pasted code block) reveals fast but bounded
// rather than snapping in all at once.
const MAX_CHARS_PER_SECOND = 2000;
// Low-pass factor: how aggressively the live velocity chases the target velocity each
// frame. Smaller is smoother but laggier; ~0.15 ≈ a ~110ms time constant at 60fps.
const VELOCITY_LERP = 0.15;
// Clamp per-frame delta so returning from a backgrounded tab (rAF paused) does not dump
// the whole backlog in a single frame.
const MAX_FRAME_SECONDS = 0.05;
// Minimum spacing between React commits. The reveal float still advances every frame at
// the smoothed velocity; this only batches how often the grown prefix is pushed to state.
export const MIN_EMIT_INTERVAL_MS = 40;

/**
 * Mutable per-message reveal state. Owned by the hook via refs; the pure stepper below
 * mutates it in place so the rAF loop allocates nothing per frame.
 */
export interface SmoothRevealState {
  /** Revealed character count, accumulated as a float across frames. */
  shown: number;
  /** Smoothed reveal velocity in chars/second. */
  velocity: number;
  /** Timestamp (ms) of the previous frame; 0 marks the start of a fresh burst. */
  lastFrameAt: number;
  /** Timestamp (ms) of the last emitted commit; 0 forces the next emit immediately. */
  lastEmitAt: number;
}

export function createSmoothRevealState(shown: number): SmoothRevealState {
  return { shown, velocity: 0, lastFrameAt: 0, lastEmitAt: 0 };
}

export interface SmoothRevealStep {
  /** Floored character count to commit this frame, or null when no commit is due. */
  emitCount: number | null;
  /** True when the backlog is drained and the loop should sleep until the next flush. */
  done: boolean;
}

/**
 * Advance the reveal by one animation frame. Mutates `state` in place and reports
 * whether this frame should commit a longer prefix and whether the loop can sleep.
 *
 * Emission is quantized: a commit is due only when the floored count advanced AND
 * either MIN_EMIT_INTERVAL_MS elapsed since the last commit, the reveal just caught
 * up with the target (never hold back the final characters of a burst), or no commit
 * has happened yet in this burst.
 */
export function stepSmoothReveal(
  state: SmoothRevealState,
  nowMs: number,
  targetLength: number,
  emittedCount: number,
): SmoothRevealStep {
  const previousFrameAt = state.lastFrameAt;
  const dt = previousFrameAt ? Math.min((nowMs - previousFrameAt) / 1000, MAX_FRAME_SECONDS) : 0;
  state.lastFrameAt = nowMs;

  if (state.shown > targetLength) state.shown = targetLength;

  const backlog = targetLength - state.shown;
  if (backlog <= 0) {
    state.velocity = 0;
    state.lastFrameAt = 0;
    return { emitCount: null, done: true };
  }

  const targetVelocity = Math.min(MAX_CHARS_PER_SECOND, backlog / DRAIN_WINDOW_SECONDS);
  state.velocity += (targetVelocity - state.velocity) * VELOCITY_LERP;
  state.shown = Math.min(targetLength, state.shown + state.velocity * dt);

  const nextCount = Math.floor(state.shown);
  const caughtUp = nextCount >= targetLength;
  const emitDue =
    nextCount !== emittedCount &&
    (caughtUp || state.lastEmitAt === 0 || nowMs - state.lastEmitAt >= MIN_EMIT_INTERVAL_MS);
  if (emitDue) {
    state.lastEmitAt = nowMs;
  }

  const done = targetLength - state.shown <= 0;
  if (done) {
    state.velocity = 0;
    state.lastFrameAt = 0;
  }
  return { emitCount: emitDue ? nextCount : null, done };
}

/**
 * Smoothly reveal `text` while `isStreaming` is true.
 *
 * - Returns `text` unchanged when not streaming or under prefers-reduced-motion, so
 *   completed messages and reduced-motion users see the exact text with zero animation.
 * - Snaps to the full text the instant streaming ends (no trailing typewriter once the
 *   agent is done).
 * - Text already present on mount is shown immediately; only newly-arriving deltas animate.
 */
export function useSmoothStreamedText(text: string, isStreaming: boolean): string {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Testable env (jsdom/vitest) has no rAF or has mocked timers – smooth reveal would
  // jank and never settle. Fall back to immediate text so streaming tests stay
  // deterministic and the main thread isn't blocked by rAF loops.
  const isTestableEnv =
    typeof window === "undefined" ||
    typeof (window as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame !==
      "function" ||
    (typeof process !== "undefined" &&
      (process.env.VITEST === "true" || process.env.NODE_ENV === "test"));
  const animate = isStreaming && !reduceMotion && !isTestableEnv;

  const [revealed, setRevealed] = useState(text);

  // Latest full text, mirrored post-commit so the rAF loop always reads the current value
  // without re-subscribing the animation effect on every ~100ms delta.
  const targetRef = useRef(text);
  const stateRef = useRef<SmoothRevealState>(createSmoothRevealState(text.length));
  // Character count last pushed to React state — guards against redundant setState when the
  // floored count has not advanced.
  const emittedRef = useRef(text.length);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<(now: number) => void>(() => undefined);

  const cancelFrame = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const scheduleFrame = () => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame((now) => {
      rafRef.current = null;
      tickRef.current(now);
    });
  };

  // Installed in an effect (not during render — that write would make the
  // whole hook ineligible for React Compiler). The tick reads everything
  // through refs, so a mount-time install stays permanently fresh.
  useEffect(() => {
    tickRef.current = (now: number) => {
      const target = targetRef.current;
      const step = stepSmoothReveal(stateRef.current, now, target.length, emittedRef.current);
      if (step.emitCount !== null) {
        emittedRef.current = step.emitCount;
        setRevealed(step.emitCount >= target.length ? target : target.slice(0, step.emitCount));
      }
      if (!step.done) {
        scheduleFrame();
      }
      // When done, the loop sleeps; the text-update effect wakes it on the next flush.
    };
  }, [scheduleFrame]);

  useEffect(() => {
    const previousTarget = targetRef.current;
    const isAppendOnly = text.length >= previousTarget.length && text.startsWith(previousTarget);
    targetRef.current = text;

    if (!animate || !isAppendOnly) {
      cancelFrame();
      stateRef.current = createSmoothRevealState(text.length);
      emittedRef.current = text.length;
      setRevealed(text);
      return;
    }

    if (text.length > stateRef.current.shown) {
      scheduleFrame();
    }
  }, [animate, cancelFrame, scheduleFrame, text]);

  useEffect(() => () => cancelFrame(), [cancelFrame]);

  return animate ? revealed : text;
}
