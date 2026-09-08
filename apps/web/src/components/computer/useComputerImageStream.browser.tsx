import { ComputerId } from "@synara/contracts";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComputerImageStream } from "./useComputerImageStream";

const sources = vi.hoisted(() => ({ close: vi.fn(), open: vi.fn() }));
vi.mock("~/lib/computerFrameSource", () => ({
  createComputerFrameSource: () => {
    sources.open();
    return { close: sources.close, requestResync: vi.fn() };
  },
}));

function Probe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useComputerImageStream({
    canvasRef,
    computerId: ComputerId.makeUnsafe("desktop"),
    enabled: true,
  });
  return <canvas ref={canvasRef} />;
}

afterEach(() => vi.restoreAllMocks());

it("closes the frame source when hidden and reconnects when visible", async () => {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  sources.open.mockClear();
  sources.close.mockClear();
  const screen = await render(<Probe />);
  await expect.poll(() => sources.open.mock.calls.length).toBe(1);
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => sources.close.mock.calls.length).toBe(1);
  expect(sources.open.mock.calls.length).toBe(1);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => sources.open.mock.calls.length).toBe(2);
  await screen.unmount();
  expect(sources.close.mock.calls.length).toBe(2);
});
