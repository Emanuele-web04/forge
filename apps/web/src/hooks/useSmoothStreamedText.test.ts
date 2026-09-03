// FILE: useSmoothStreamedText.test.ts
// Purpose: Pins the pure reveal stepper — velocity-driven drain plus quantized commits.
//          The hook itself is thin wiring (refs + rAF scheduling) around this function.

import { describe, expect, it } from "vitest";

import {
  createSmoothRevealState,
  MIN_EMIT_INTERVAL_MS,
  stepSmoothReveal,
  type SmoothRevealState,
} from "./useSmoothStreamedText";

const FRAME_MS = 8; // ~120Hz display

interface DrainRun {
  emits: { at: number; count: number }[];
  frames: number;
  state: SmoothRevealState;
}

/** Drive the stepper frame-by-frame until the backlog drains (or maxFrames). */
function drain(
  state: SmoothRevealState,
  targetLength: number,
  startMs: number,
  maxFrames = 10_000,
): DrainRun {
  const emits: { at: number; count: number }[] = [];
  let emitted = Math.floor(state.shown);
  let now = startMs;
  let frames = 0;
  for (; frames < maxFrames; frames += 1) {
    const step = stepSmoothReveal(state, now, targetLength, emitted);
    if (step.emitCount !== null) {
      emits.push({ at: now, count: step.emitCount });
      emitted = step.emitCount;
    }
    if (step.done) {
      break;
    }
    now += FRAME_MS;
  }
  return { emits, frames, state };
}

describe("stepSmoothReveal", () => {
  it("spaces commits at least MIN_EMIT_INTERVAL_MS apart while draining", () => {
    const run = drain(createSmoothRevealState(0), 400, 1_000);

    expect(run.emits.length).toBeGreaterThan(1);
    for (let index = 1; index < run.emits.length - 1; index += 1) {
      expect(run.emits[index]!.at - run.emits[index - 1]!.at).toBeGreaterThanOrEqual(
        MIN_EMIT_INTERVAL_MS,
      );
    }
    // Quantization is the point: far fewer commits than frames.
    expect(run.emits.length).toBeLessThan(run.frames / 3);
  });

  it("reveals every character: the final commit is the full target length", () => {
    const run = drain(createSmoothRevealState(0), 137, 500);

    expect(run.emits.at(-1)?.count).toBe(137);
    expect(run.state.shown).toBe(137);
  });

  it("emits the catch-up commit even when the interval has not elapsed", () => {
    // Mid-burst, one frame from catching up, with a commit only 4ms ago: the
    // final characters must not be held hostage to the quantization gate.
    const state: SmoothRevealState = {
      shown: 101.5,
      velocity: 500,
      lastFrameAt: 992,
      lastEmitAt: 996,
    };
    const step = stepSmoothReveal(state, 1_000, 103, 101);

    expect(step.emitCount).toBe(103);
    expect(step.done).toBe(true);
  });

  it("clamps the frame delta after a background-tab resume", () => {
    const state = createSmoothRevealState(0);
    // Prime one frame so velocity builds, then jump far ahead as if rAF was paused.
    stepSmoothReveal(state, 1_000, 500, 0);
    stepSmoothReveal(state, 1_008, 500, 0);
    const shownBefore = state.shown;
    const velocityBefore = state.velocity;
    stepSmoothReveal(state, 61_000, 500, Math.floor(shownBefore));

    // At most MAX_FRAME_SECONDS (0.05s) of reveal, not 60s of backlog dump.
    expect(state.shown - shownBefore).toBeLessThanOrEqual(
      Math.max(state.velocity, velocityBefore) * 0.05 + 1,
    );
    expect(state.shown).toBeLessThan(500);
  });

  it("clamps and sleeps when the target shrank below the revealed count", () => {
    const state = createSmoothRevealState(200);
    const step = stepSmoothReveal(state, 1_000, 50, 200);

    expect(state.shown).toBe(50);
    expect(step.done).toBe(true);
    expect(step.emitCount).toBeNull();
  });

  it("reports done and resets burst tracking once caught up", () => {
    const run = drain(createSmoothRevealState(0), 60, 2_000);

    expect(run.state.velocity).toBe(0);
    expect(run.state.lastFrameAt).toBe(0);
    // A later burst starting fresh emits its first advanced frame promptly.
    const next = drain(run.state, 120, 2_000 + run.frames * FRAME_MS + 100);
    expect(next.emits.length).toBeGreaterThan(0);
  });

  it("drains a large paste at the bounded ceiling instead of snapping", () => {
    const run = drain(createSmoothRevealState(0), 10_000, 0);

    // 10k chars at the 2000 chars/sec ceiling needs ≥5s of frames.
    expect(run.frames * FRAME_MS).toBeGreaterThanOrEqual(5_000);
    expect(run.emits.at(-1)?.count).toBe(10_000);
  });
});
