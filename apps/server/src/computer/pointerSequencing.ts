/**
 * How a pointer glide and a key or button press are *sequenced* — as opposed to
 * how the individual events are transported.
 *
 * This is the timing and bookkeeping that has to be identical on every backend,
 * because it is what makes synthesized input look like a human's to a toolkit:
 * an eased path walked against a wall-clock deadline rather than a fixed sleep
 * per step, a shift that is released even when the stroke it wrapped threw, and
 * a hotkey whose modifiers come back up in the reverse of the order they went
 * down. Getting any of it wrong strands a modifier held on the user's real
 * keyboard, which is the worst failure mode this feature has.
 *
 * The transport is a sink the caller supplies, so the KWin plugin's D-Bus
 * calls go through the same sequencing.
 */
import type { ComputerPoint } from "@synara/contracts";

import { EVDEV_KEY_CODES, type QwertyKeyStroke } from "./evdevInput.ts";

/** One sample of an eased pointer path: where to move, and when it is due. */
export interface PointerGlideStep {
  readonly point: ComputerPoint;
  /** Wall-clock offset from the start of the glide at which this sample is due. */
  readonly offsetMs: number;
}

/** Longest gap between pointer samples. ~62 Hz reads as continuous motion. */
export const GLIDE_FRAME_INTERVAL_MS = 16;
/** Longest jump between samples, so a fast glide over a long path stays smooth. */
const GLIDE_MAX_STEP_PX = 80;
/**
 * How long a synthesized button stays down. Long enough that a toolkit's press
 * and release are not coalesced into nothing, short enough not to register as a
 * press-and-hold.
 */
export const BUTTON_HOLD_MS = 20;

/**
 * Names for the operations a sink performs, carried into the sink so a refusal
 * can say which half of a press/release pair the display server rejected.
 * "the plugin rejected key release" and "the plugin rejected key" are different
 * bugs, and a stranded modifier is only diagnosable from the difference.
 */
export const POINTER_SEQUENCE_OPERATIONS = {
  movePointer: "movePointer",
  buttonPress: "button",
  buttonRelease: "button release",
  keyPress: "key",
  keyRelease: "key release",
  shiftRelease: "shift release",
} as const;

/**
 * The transport a sequence drives. Each method must reject when the display
 * server refused the event; the sequencing here relies on that to abort a glide
 * and to still run its release path.
 */
export interface ComputerInputSink {
  movePointer(x: number, y: number, operation: string): Promise<void>;
  button(code: number, pressed: boolean, operation: string): Promise<void>;
  key(code: number, pressed: boolean, operation: string): Promise<void>;
}

/**
 * Samples a smoothstep-eased path from `from` to `to` with a wall-clock
 * schedule attached.
 *
 * `offsetMs` is a deadline measured from the start of the glide, not a sleep
 * length. A caller sleeps only the remainder up to the deadline, so transport
 * latency is absorbed by the sleep budget instead of being added on top of it
 * and the glide lands at roughly `durationMs`. The final sample is due at
 * exactly `durationMs`; `durationMs === 0` makes every sample due immediately,
 * which degenerates to moving as fast as the transport allows.
 */
export function pointerGlideSteps(
  from: ComputerPoint,
  to: ComputerPoint,
  durationMs: number,
  minimumSteps = 2,
): readonly PointerGlideStep[] {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(
    minimumSteps,
    Math.ceil(distance / GLIDE_MAX_STEP_PX),
    Math.ceil(duration / GLIDE_FRAME_INTERVAL_MS),
  );
  const path: PointerGlideStep[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const linear = index / steps;
    const eased = linear * linear * (3 - 2 * linear);
    path.push({
      point: {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      },
      offsetMs: (duration * index) / steps,
    });
  }
  return path;
}

export interface PointerGlideOptions {
  readonly sink: Pick<ComputerInputSink, "movePointer">;
  readonly from: ComputerPoint;
  readonly to: ComputerPoint;
  readonly durationMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /**
   * Runs before every sample. Throws to abandon a glide whose backend went
   * away, which is what keeps a disposed backend from finishing a drag against
   * a connection nobody owns any more.
   */
  readonly beforeStep?: () => void;
  /** Reports where the pointer now is, so a caller's cached position tracks it. */
  readonly onStep?: (point: ComputerPoint) => void;
}

/**
 * Walks an eased path against a wall-clock deadline instead of a fixed sleep
 * per step, so a glide or drag lands at roughly the duration the caller asked
 * for. Each step sleeps only the remainder up to its deadline, which means a
 * slow transport round trip eats into that step's sleep budget rather than
 * adding to the total, and a duration of `0` sleeps not at all.
 */
export async function glidePointerToDeadline(options: PointerGlideOptions): Promise<void> {
  const startedAt = options.now();
  for (const step of pointerGlideSteps(options.from, options.to, options.durationMs)) {
    options.beforeStep?.();
    await options.sink.movePointer(
      step.point.x,
      step.point.y,
      POINTER_SEQUENCE_OPERATIONS.movePointer,
    );
    options.onStep?.(step.point);
    const remainingMs = startedAt + step.offsetMs - options.now();
    if (remainingMs > 0) await options.sleep(remainingMs);
  }
}

/**
 * One complete key press: shift down if the stroke needs it, the key down and
 * up, then shift up. Shift is released in `finally`, because a stroke
 * that fails halfway must not leave shift latched on the user's keyboard.
 */
export async function pressKeyStroke(options: {
  readonly sink: Pick<ComputerInputSink, "key">;
  readonly stroke: QwertyKeyStroke;
}): Promise<void> {
  const { sink, stroke } = options;
  if (stroke.shift) {
    await sink.key(EVDEV_KEY_CODES.LeftShift, true, POINTER_SEQUENCE_OPERATIONS.keyPress);
  }
  let releaseError: unknown;
  try {
    await sink.key(stroke.code, true, POINTER_SEQUENCE_OPERATIONS.keyPress);
    await sink.key(stroke.code, false, POINTER_SEQUENCE_OPERATIONS.keyRelease);
  } finally {
    // The release runs whatever happened above; its own failure surfaces only
    // when there is no earlier one to report.
    releaseError = await firstFailureOf(
      stroke.shift
        ? [
            () =>
              sink.key(EVDEV_KEY_CODES.LeftShift, false, POINTER_SEQUENCE_OPERATIONS.shiftRelease),
          ]
        : [],
    );
  }
  if (releaseError !== undefined) throw releaseError;
}

/**
 * A chord: every stroke pressed in order and held, then released in the reverse
 * order. The release list is built as the presses land, so a chord that fails
 * on its third key still releases the two that did go down — and only those.
 *
 * Every release is attempted even after one refuses: each release is its own
 * D-Bus call, and a transient refusal on the first would otherwise strand every modifier behind it on the human's keyboard until the
 * backend is disposed. The first refusal is what surfaces, but only when the
 * presses themselves had not already failed — that error is the one worth
 * acting on.
 */
export async function pressHotkeyStrokes(options: {
  readonly sink: Pick<ComputerInputSink, "key">;
  readonly strokes: readonly QwertyKeyStroke[];
}): Promise<void> {
  const { sink, strokes } = options;
  const releases: number[] = [];
  let releaseError: unknown;
  try {
    for (const stroke of strokes) {
      if (stroke.shift) {
        await sink.key(EVDEV_KEY_CODES.LeftShift, true, POINTER_SEQUENCE_OPERATIONS.keyPress);
        releases.push(EVDEV_KEY_CODES.LeftShift);
      }
      await sink.key(stroke.code, true, POINTER_SEQUENCE_OPERATIONS.keyPress);
      releases.push(stroke.code);
    }
  } finally {
    releaseError = await firstFailureOf(
      releases
        .toReversed()
        .map((code) => () => sink.key(code, false, POINTER_SEQUENCE_OPERATIONS.keyRelease)),
    );
  }
  if (releaseError !== undefined) throw releaseError;
}

/** One button press held for long enough to register, released even on failure. */
export async function pressButtonOnce(options: {
  readonly sink: Pick<ComputerInputSink, "button">;
  readonly code: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly holdMs?: number;
}): Promise<void> {
  const { sink, code } = options;
  await sink.button(code, true, POINTER_SEQUENCE_OPERATIONS.buttonPress);
  let releaseError: unknown;
  try {
    await options.sleep(options.holdMs ?? BUTTON_HOLD_MS);
  } finally {
    releaseError = await firstFailureOf([
      () => sink.button(code, false, POINTER_SEQUENCE_OPERATIONS.buttonRelease),
    ]);
  }
  if (releaseError !== undefined) throw releaseError;
}

/**
 * Awaits every step even when some refuse, returning the first refusal.
 *
 * This is the shape every release path takes: one display-server refusal must
 * cost that one event, not every event queued behind it.
 */
async function firstFailureOf(
  steps: readonly (() => Promise<void>)[],
): Promise<unknown | undefined> {
  let first: unknown | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      first ??= error;
    }
  }
  return first;
}
