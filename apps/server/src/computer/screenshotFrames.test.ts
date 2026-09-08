import { describe, expect, it } from "vitest";

import { ComputerTargetError } from "./uiTreeTargeting.ts";
import {
  SCREENSHOT_FRAMES_PER_THREAD,
  ScreenshotFrameRegistry,
  screenshotDeltaToDesktop,
  screenshotPointToDesktop,
  screenshotRectToDesktop,
  type ScreenshotFrame,
} from "./screenshotFrames.ts";

/** A 400×800 desktop rect at (1050, 120) captured into a 200×400 image. */
const HALF: ScreenshotFrame = {
  id: "shot-1",
  width: 200,
  height: 400,
  region: { x: 1_050, y: 120, width: 400, height: 800 },
  scale: 0.5,
};

function shot(width: number, height: number, region = { x: 0, y: 0, width, height }) {
  return { width, height, region, scale: width / region.width };
}

describe("screenshotPointToDesktop", () => {
  it("adds the region offset and undoes the downscale", () => {
    expect(screenshotPointToDesktop(HALF, 100, 100)).toEqual({ x: 1_250, y: 320 });
    expect(screenshotPointToDesktop(HALF, 0, 0)).toEqual({ x: 1_050, y: 120 });
  });

  it("lands a far-edge pixel on the region's last desktop pixel", () => {
    // Models put controls flush against a border at x === width; that is the
    // last pixel the picture shows, not the first one past it.
    expect(screenshotPointToDesktop(HALF, 200, 400)).toEqual({ x: 1_449, y: 919 });
  });

  it("refuses a point the picture does not show", () => {
    const outside: ReadonlyArray<readonly [number, number]> = [
      [201, 10],
      [10, 401],
      [-1, 10],
      [Number.NaN, 10],
    ];
    for (const [x, y] of outside) {
      expect(() => screenshotPointToDesktop(HALF, x, y)).toThrow(ComputerTargetError);
    }
    try {
      screenshotPointToDesktop(HALF, 201, 10);
    } catch (error) {
      expect(error).toMatchObject({
        code: "computer_target_offscreen",
        message: expect.stringContaining("200x400 screenshot shot-1"),
      });
    }
  });
});

describe("screenshotRectToDesktop", () => {
  it("maps and clips a rect to what the frame covers", () => {
    expect(screenshotRectToDesktop(HALF, { x: 100, y: 300, width: 200, height: 200 })).toEqual({
      x: 1_250,
      y: 720,
      width: 200,
      height: 200,
    });
    expect(screenshotRectToDesktop(HALF, { x: -10, y: -10, width: 20, height: 20 })).toEqual({
      x: 1_050,
      y: 120,
      width: 20,
      height: 20,
    });
  });

  it("refuses a rect with nothing of the picture in it", () => {
    expect(() => screenshotRectToDesktop(HALF, { x: 200, y: 0, width: 10, height: 10 })).toThrow(
      ComputerTargetError,
    );
  });
});

describe("screenshotDeltaToDesktop", () => {
  it("scales a distance the same way as a point", () => {
    expect(screenshotDeltaToDesktop(HALF, 40, -10)).toEqual({ deltaX: 80, deltaY: -20 });
  });
});

describe("ScreenshotFrameRegistry", () => {
  it("hands out sequential ids and resolves the latest by default", () => {
    const frames = new ScreenshotFrameRegistry();
    expect(frames.record("t", shot(100, 100))?.id).toBe("shot-1");
    expect(frames.record("t", shot(50, 50))?.id).toBe("shot-2");
    expect(frames.resolve("t").id).toBe("shot-2");
    expect(frames.resolve("t", "shot-1").width).toBe(100);
  });

  it("refuses a thread that has not seen a screenshot, and an unknown id", () => {
    const frames = new ScreenshotFrameRegistry();
    expect(() => frames.resolve("t")).toThrow(
      expect.objectContaining({ code: "computer_target_invalid" }),
    );
    frames.record("t", shot(100, 100));
    expect(() => frames.resolve("t", "shot-7")).toThrow(
      expect.objectContaining({
        code: "computer_target_not_found",
        message: expect.stringContaining("shot-1"),
      }),
    );
    // Another thread's picture is not this thread's frame.
    expect(() => frames.resolve("u")).toThrow(ComputerTargetError);
  });

  it("keeps a bounded number of frames per thread and forgets the oldest", () => {
    const frames = new ScreenshotFrameRegistry();
    for (let index = 0; index <= SCREENSHOT_FRAMES_PER_THREAD; index += 1) {
      frames.record("t", shot(100, 100));
    }
    expect(() => frames.resolve("t", "shot-1")).toThrow(ComputerTargetError);
    expect(frames.resolve("t", "shot-2").id).toBe("shot-2");
  });

  it("records nothing for a screenshot that carries no mapping", () => {
    const frames = new ScreenshotFrameRegistry();
    expect(frames.record("t", { width: 10, height: 10 })).toBeUndefined();
    expect(() => frames.resolve("t")).toThrow(ComputerTargetError);
  });
});

describe("screenshot reuse", () => {
  const image = {
    ...shot(200, 400, { x: 1050, y: 120, width: 400, height: 800 }),
    mimeType: "image/png" as const,
    sizeBytes: 3,
    bytesBase64: "YWJj",
    capturedAt: "2026-09-05T00:00:00.000Z",
  };

  it("requires identical pixels, window, geometry, and scale in the latest delivered frame", () => {
    const frames = new ScreenshotFrameRegistry();
    const frame = frames.record("thread-a", image, "window-a");
    expect(
      frames.matchLatest(
        "thread-a",
        { ...image, capturedAt: "2026-09-05T00:01:00.000Z" },
        "window-a",
      ),
    ).toBe(frame);
    expect(frames.matchLatest("thread-a", image, "window-b")).toBeUndefined();
    expect(frames.matchLatest("thread-b", image, "window-a")).toBeUndefined();
    for (const changed of [
      { ...image, scale: 1 },
      { ...image, width: 201 },
      { ...image, bytesBase64: "ZGVm" },
      { ...image, region: { ...image.region, x: 600 } },
    ]) {
      expect(frames.matchLatest("thread-a", changed, "window-a")).toBeUndefined();
    }
    frames.record("thread-b", image, "window-a");
    expect(frames.matchLatest("thread-a", image, "window-a")).toBe(frame);
    frames.record("thread-a", image, "window-b");
    expect(frames.matchLatest("thread-a", image, "window-a")).toBeUndefined();
  });

  it("invalidates the active frame after delivering an image without geometry", () => {
    const frames = new ScreenshotFrameRegistry();
    frames.record("thread-a", image, "window-a");
    frames.record("thread-a", { width: 1, height: 1, bytesBase64: "YWJj" });
    expect(frames.matchLatest("thread-a", image, "window-a")).toBeUndefined();
    expect(() => frames.resolve("thread-a")).toThrow("No screenshot");
  });
});

it("reuses only the latest delivered pixels with an identical coordinate frame", async () => {
  const { FakeComputerBackend } = await import("./FakeComputerBackend.ts");
  const backend = new FakeComputerBackend();
  const screenshot = await backend.captureScreenshot({ kind: "window", windowId: "fake-terminal" });
  const frames = new ScreenshotFrameRegistry();
  const delivered = frames.record("a", screenshot, "fake-terminal");
  expect(frames.matchLatest("a", screenshot, "fake-terminal")).toBe(delivered);
  expect(frames.matchLatest("b", screenshot, "fake-terminal")).toBeUndefined();
  for (const changed of [
    { ...screenshot, width: screenshot.width + 1 },
    { ...screenshot, height: screenshot.height + 1 },
    { ...screenshot, scale: 0.25 },
    { ...screenshot, region: { ...screenshot.region!, x: screenshot.region!.x + 1 } },
  ]) {
    expect(frames.matchLatest("a", changed, "fake-terminal")).toBeUndefined();
  }
  frames.record("a", screenshot, "different-window");
  expect(frames.matchLatest("a", screenshot, "fake-terminal")).toBeUndefined();
});
