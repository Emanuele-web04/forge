import { ComputerId } from "@synara/contracts";
import type { ComputerFrame } from "@synara/shared/computerFrame";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ComputerFrameSourceOptions } from "~/lib/computerFrameSource";
import { useComputerImageStream } from "./useComputerImageStream";

const sources = vi.hoisted(() => ({
  handlers: [] as ComputerFrameSourceOptions["handlers"][],
  close: vi.fn(),
}));
vi.mock("~/lib/computerFrameSource", () => ({
  createComputerFrameSource: (options: ComputerFrameSourceOptions) => {
    sources.handlers.push(options.handlers);
    return { close: sources.close, requestResync: vi.fn() };
  },
}));

const computerId = ComputerId.makeUnsafe("desktop");
let visibility: DocumentVisibilityState;

function Probe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { dimensions, status } = useComputerImageStream({ canvasRef, computerId, enabled: true });
  return (
    <>
      <canvas ref={canvasRef} />
      <output data-testid="dimensions">
        {dimensions ? `${dimensions.width}x${dimensions.height}` : "none"}
      </output>
      <output data-testid="status">{status.kind}</output>
    </>
  );
}

function frame(payload: Uint8Array, sequence = 1): ComputerFrame {
  return {
    header: { computerId, sequence, timestampMs: sequence, keyframe: true, codecConfig: false },
    payload,
  };
}

function sourceCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 3;
  canvas.getContext("2d")!.fillRect(0, 0, 4, 3);
  return canvas;
}

async function pngBytes() {
  const blob = await new Promise<Blob>((resolve) =>
    sourceCanvas().toBlob((value) => resolve(value!)),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  sources.handlers.length = 0;
  sources.close.mockClear();
});
afterEach(() => vi.restoreAllMocks());

it("closes hidden streams and restores dimensions when equal-sized frames resume", async () => {
  const screen = await render(<Probe />);
  await expect.poll(() => sources.handlers.length).toBe(1);
  const payload = await pngBytes();
  sources.handlers[0]!.onFrame(frame(payload));
  await expect.element(screen.getByTestId("dimensions")).toHaveTextContent("4x3");

  setVisibility("hidden");
  await expect.poll(() => sources.close.mock.calls.length).toBe(1);
  await expect.element(screen.getByTestId("dimensions")).toHaveTextContent("none");
  setVisibility("visible");
  await expect.poll(() => sources.handlers.length).toBe(2);
  sources.handlers[1]!.onFrame(frame(payload));
  await expect.element(screen.getByTestId("dimensions")).toHaveTextContent("4x3");
  await expect.element(screen.getByTestId("status")).toHaveTextContent("streaming");
  await screen.unmount();
  expect(sources.close).toHaveBeenCalledTimes(2);
});

it("closes an in-flight bitmap without drawing it after the document hides", async () => {
  const bitmap = await createImageBitmap(sourceCanvas());
  const close = vi.spyOn(bitmap, "close");
  let finish!: (value: ImageBitmap) => void;
  vi.spyOn(globalThis, "createImageBitmap").mockImplementation(
    () =>
      new Promise<ImageBitmap>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(<Probe />);
  await expect.poll(() => sources.handlers.length).toBe(1);
  sources.handlers[0]!.onFrame(frame(new Uint8Array([1])));
  setVisibility("hidden");
  await expect.poll(() => sources.close.mock.calls.length).toBe(1);
  finish(bitmap);
  await expect.poll(() => close.mock.calls.length).toBe(1);
  await expect.element(screen.getByTestId("dimensions")).toHaveTextContent("none");
  await expect.element(screen.getByTestId("status")).toHaveTextContent("idle");
  await screen.unmount();
});

it("bounds decoding to one active frame and the newest pending frame", async () => {
  const first = await createImageBitmap(sourceCanvas());
  const last = await createImageBitmap(sourceCanvas());
  const firstClose = vi.spyOn(first, "close");
  const lastClose = vi.spyOn(last, "close");
  let finish!: (value: ImageBitmap) => void;
  const decode = vi
    .spyOn(globalThis, "createImageBitmap")
    .mockImplementationOnce(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(last);
  const screen = await render(<Probe />);
  await expect.poll(() => sources.handlers.length).toBe(1);
  for (const sequence of [1, 2, 3]) {
    sources.handlers[0]!.onFrame(frame(new Uint8Array([sequence]), sequence));
  }
  expect(decode).toHaveBeenCalledTimes(1);
  finish(first);
  await expect.poll(() => decode.mock.calls.length).toBe(2);
  const blob = decode.mock.calls[1]![0] as Blob;
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([3]));
  await expect.poll(() => lastClose.mock.calls.length).toBe(1);
  expect(firstClose).toHaveBeenCalledTimes(1);
  await screen.unmount();
});
