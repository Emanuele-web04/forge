/**
 * The coordinate frame a model points in: the screenshot it is looking at.
 *
 * A model does not see the desktop; it sees pictures of it, each one a
 * possibly downscaled crop at some offset. The earlier tool surface handed the
 * model the crop's `region` and `scale` and asked it to convert every pixel it
 * wanted to click into a desktop coordinate itself — across a workspace
 * overview squeezed to a third of its size and window captures offset by
 * thousands of pixels — and that arithmetic is where clicks went astray. The
 * official computer-use harnesses (OpenAI's `@oai/sky` client behind the Codex
 * app, Anthropic's computer tool) never ask for it: the model gives pixel
 * coordinates in the screenshot it was shown and the harness does the
 * geometry. This module is that geometry.
 *
 * Every screenshot delivered to a thread is remembered here as a frame with an
 * id; a target's x/y are pixels in the thread's most recent frame unless it
 * names an earlier one. Frames are per thread, because two agents looking at
 * different windows must not read each other's pictures, and bounded, because
 * a model only ever refers back a few screenshots.
 */
import { createHash } from "node:crypto";

import type { ComputerPoint, ComputerRect, ComputerScreenshot } from "@synara/contracts";

import { ComputerTargetError } from "./uiTreeTargeting.ts";

export interface ScreenshotFrame {
  /** Id handed to the model as `screenshotId`, unique for the registry's lifetime. */
  readonly id: string;
  /** Image size in screenshot pixels: the space the model's x/y live in. */
  readonly width: number;
  readonly height: number;
  /** Desktop rect the image covers, in logical pixels. */
  readonly region: ComputerRect;
  /** Screenshot pixels per desktop logical pixel. */
  readonly scale: number;
  /** The window the image is a capture of, when it is one. */
  readonly windowId?: string;
}

export type ScreenshotFrameSource = Pick<
  ComputerScreenshot,
  "width" | "height" | "region" | "scale"
> & { readonly bytesBase64?: string };

/**
 * How far back a thread can point. A model names an earlier screenshot only to
 * return from a zoomed window capture to the overview it took just before, so
 * a handful is plenty; more would only keep stale pictures of a desktop that
 * has since changed.
 */
export const SCREENSHOT_FRAMES_PER_THREAD = 8;

/** Threads remembered at once; the least recently pointed-into one goes first. */
const SCREENSHOT_FRAME_THREADS = 256;

export class ScreenshotFrameRegistry {
  /** Insertion order doubles as recency: a thread is re-inserted on every record. */
  private readonly threads = new Map<string, ScreenshotFrame[]>();
  private readonly hashes = new WeakMap<ScreenshotFrame, string>();
  private sequence = 0;

  /**
   * Remembers a screenshot as the thread's newest frame and returns it, or
   * undefined for a screenshot that says nothing about what it covers — the
   * model can look at such an image but cannot point into it.
   */
  record(
    threadId: string,
    screenshot: ScreenshotFrameSource,
    windowId?: string,
  ): ScreenshotFrame | undefined {
    const region = screenshot.region;
    if (!region || region.width <= 0 || region.height <= 0) {
      this.threads.delete(threadId);
      return undefined;
    }
    const scale = screenshot.scale ?? screenshot.width / region.width;
    if (!Number.isFinite(scale) || scale <= 0) {
      this.threads.delete(threadId);
      return undefined;
    }
    this.sequence += 1;
    const frame: ScreenshotFrame = {
      id: `shot-${this.sequence}`,
      width: screenshot.width,
      height: screenshot.height,
      region: { ...region },
      scale,
      ...(windowId !== undefined ? { windowId } : {}),
    };
    if (screenshot.bytesBase64 !== undefined) {
      this.hashes.set(frame, createHash("sha256").update(screenshot.bytesBase64).digest("hex"));
    }
    const frames = this.threads.get(threadId) ?? [];
    this.threads.delete(threadId);
    frames.push(frame);
    if (frames.length > SCREENSHOT_FRAMES_PER_THREAD) {
      frames.splice(0, frames.length - SCREENSHOT_FRAMES_PER_THREAD);
    }
    this.threads.set(threadId, frames);
    while (this.threads.size > SCREENSHOT_FRAME_THREADS) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
    return frame;
  }

  latest(threadId: string): ScreenshotFrame | undefined {
    return this.threads.get(threadId)?.at(-1);
  }

  /** Reuse only the latest delivered image, with exactly the same coordinate frame. */
  matchLatest(
    threadId: string,
    screenshot: ComputerScreenshot,
    windowId?: string,
  ): ScreenshotFrame | undefined {
    const frame = this.latest(threadId);
    const region = screenshot.region;
    if (
      !frame ||
      !region ||
      frame.windowId !== windowId ||
      frame.width !== screenshot.width ||
      frame.height !== screenshot.height ||
      frame.scale !== (screenshot.scale ?? screenshot.width / region.width) ||
      frame.region.x !== region.x ||
      frame.region.y !== region.y ||
      frame.region.width !== region.width ||
      frame.region.height !== region.height ||
      this.hashes.get(frame) !== createHash("sha256").update(screenshot.bytesBase64).digest("hex")
    ) {
      return undefined;
    }
    return frame;
  }

  /**
   * The frame a target's coordinates are measured in: the named screenshot, or
   * the thread's newest one. Refuses rather than guesses when there is none —
   * a coordinate with no picture behind it is a click into the dark, and a
   * thread that has not looked yet (or whose server restarted since) has to
   * take a screenshot before it can aim.
   */
  resolve(threadId: string, screenshotId?: string): ScreenshotFrame {
    const frames = this.threads.get(threadId) ?? [];
    if (screenshotId !== undefined) {
      const frame = frames.find((candidate) => candidate.id === screenshotId);
      if (frame) return frame;
      throw new ComputerTargetError({
        code: "computer_target_not_found",
        message:
          `No screenshot ${JSON.stringify(screenshotId)} is available to point into` +
          (frames.length > 0
            ? `; the screenshots still available are ${frames.map((f) => f.id).join(", ")} (newest last).`
            : ". Take a screenshot first and use its screenshotId."),
        notFound: true,
      });
    }
    const latest = frames.at(-1);
    if (latest) return latest;
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message:
        "No screenshot to point into: this conversation has not received one yet. " +
        "Take one with computer_screenshot or computer_get_state, then give x/y as pixel " +
        "coordinates in that image.",
    });
  }
}

function describeFrame(frame: ScreenshotFrame): string {
  return `the ${frame.width}x${frame.height} screenshot ${frame.id}`;
}

/**
 * Desktop point for a pixel in the frame. The pixel may sit on the image's
 * far edge (x === width), which models produce for controls flush against a
 * window border; it lands on the region's last desktop pixel rather than the
 * one past it. Anything further out is refused: the model is pointing at
 * something the picture does not show.
 */
export function screenshotPointToDesktop(
  frame: ScreenshotFrame,
  x: number,
  y: number,
): ComputerPoint {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > frame.width ||
    y > frame.height
  ) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target (${x}, ${y}) is outside ${describeFrame(frame)}; x/y are pixel coordinates in that image.`,
      candidates: [],
    });
  }
  return {
    x: clampToSpan(
      Math.round(frame.region.x + x / frame.scale),
      frame.region.x,
      frame.region.width,
    ),
    y: clampToSpan(
      Math.round(frame.region.y + y / frame.scale),
      frame.region.y,
      frame.region.height,
    ),
  };
}

/**
 * Desktop rect for a rect of frame pixels, clipped to what the frame covers.
 * A rect entirely outside the image is refused for the same reason a point is.
 */
export function screenshotRectToDesktop(frame: ScreenshotFrame, rect: ComputerRect): ComputerRect {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(frame.width, rect.x + rect.width);
  const bottom = Math.min(frame.height, rect.y + rect.height);
  if (!(right > left && bottom > top)) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `The requested region does not overlap ${describeFrame(frame)}; x/y/width/height are pixel coordinates in that image.`,
      candidates: [],
    });
  }
  const x = Math.round(frame.region.x + left / frame.scale);
  const y = Math.round(frame.region.y + top / frame.scale);
  const farX = Math.round(frame.region.x + right / frame.scale);
  const farY = Math.round(frame.region.y + bottom / frame.scale);
  return { x, y, width: Math.max(1, farX - x), height: Math.max(1, farY - y) };
}

/** Scroll distances given in frame pixels, as desktop logical pixels. */
export function screenshotDeltaToDesktop(
  frame: ScreenshotFrame,
  deltaX: number,
  deltaY: number,
): { readonly deltaX: number; readonly deltaY: number } {
  return { deltaX: deltaX / frame.scale, deltaY: deltaY / frame.scale };
}

function clampToSpan(value: number, start: number, length: number): number {
  const end = start + Math.max(0, length - 1);
  return Math.min(end, Math.max(start, value));
}
