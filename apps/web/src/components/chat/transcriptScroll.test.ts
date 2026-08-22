import { describe, expect, it } from "vitest";

import {
  ANCHOR_SLIDE_DURATION_MS,
  anchorSlideOffsetPx,
  scrollTranscriptToSettledEnd,
  stopTranscriptScrollAtCurrentOffset,
  type TranscriptScrollCancellationTarget,
  type TranscriptScrollTarget,
} from "./transcriptScroll";

describe("anchorSlideOffsetPx", () => {
  const glide = (elapsedMs: number) => anchorSlideOffsetPx({ fromPx: 900, toPx: 20, elapsedMs });

  it("starts at the sent message's original offset and lands exactly on the anchor", () => {
    expect(glide(0)).toBe(900);
    expect(glide(ANCHOR_SLIDE_DURATION_MS)).toBe(20);
  });

  it("moves in one direction only, so the message never bounces on its way up", () => {
    let previous = glide(0);
    for (let elapsedMs = 8; elapsedMs <= ANCHOR_SLIDE_DURATION_MS; elapsedMs += 8) {
      const next = glide(elapsedMs);
      expect(next).toBeLessThanOrEqual(previous);
      expect(next).toBeGreaterThanOrEqual(20);
      previous = next;
    }
    expect(previous).toBe(20);
  });

  it("eases out: it covers more ground early than late", () => {
    const firstHalf = glide(0) - glide(ANCHOR_SLIDE_DURATION_MS / 2);
    const secondHalf = glide(ANCHOR_SLIDE_DURATION_MS / 2) - glide(ANCHOR_SLIDE_DURATION_MS);
    expect(firstHalf).toBeGreaterThan(secondHalf);
    expect(glide(ANCHOR_SLIDE_DURATION_MS / 2)).toBeCloseTo(900 - 880 * (1 - 0.5 ** 3), 6);
  });

  it("holds the anchor once the slide is over instead of drifting past it", () => {
    expect(glide(ANCHOR_SLIDE_DURATION_MS + 1)).toBe(20);
    expect(glide(5_000)).toBe(20);
  });

  it("ignores a negative elapsed time and a zero duration rather than jumping", () => {
    expect(glide(-50)).toBe(900);
    expect(anchorSlideOffsetPx({ fromPx: 900, toPx: 20, elapsedMs: 0, durationMs: 0 })).toBe(20);
  });
});

describe("scrollTranscriptToSettledEnd", () => {
  it("interrupts a native smooth scroll at its current offset", async () => {
    const nativeScrollCalls: ScrollToOptions[] = [];
    const scrollToOffsetCalls: Array<{ offset: number; animated?: boolean | undefined }> = [];
    const scrollNode = {
      scrollTop: 420,
      scrollTo: (options: ScrollToOptions) => nativeScrollCalls.push(options),
    } as unknown as HTMLElement;
    const target: TranscriptScrollCancellationTarget = {
      getScrollableNode: () => scrollNode,
      scrollToOffset: async (options) => {
        scrollToOffsetCalls.push(options);
      },
    };

    await stopTranscriptScrollAtCurrentOffset(target);

    expect(nativeScrollCalls).toEqual([{ top: 420, behavior: "auto" }]);
    expect(scrollToOffsetCalls).toEqual([{ offset: 420, animated: false }]);
  });

  it("finishes a smooth jump with an exact non-animated tail settle", async () => {
    const animations: boolean[] = [];
    const target: TranscriptScrollTarget = {
      scrollToEnd: async ({ animated = true } = {}) => {
        animations.push(animated);
      },
    };

    await expect(scrollTranscriptToSettledEnd({ target, isCurrent: () => true })).resolves.toBe(
      true,
    );
    expect(animations).toEqual([true, false]);
  });

  it("does not snap a replacement transcript after the user takes over", async () => {
    let finishSmoothScroll: (() => void) | null = null;
    let current = true;
    const animations: boolean[] = [];
    const target: TranscriptScrollTarget = {
      scrollToEnd: ({ animated = true } = {}) => {
        animations.push(animated);
        return new Promise<void>((resolve) => {
          finishSmoothScroll = resolve;
        });
      },
    };

    const result = scrollTranscriptToSettledEnd({ target, isCurrent: () => current });
    current = false;
    expect(finishSmoothScroll).not.toBeNull();
    (finishSmoothScroll as unknown as () => void)();

    await expect(result).resolves.toBe(false);
    expect(animations).toEqual([true]);
  });
});
