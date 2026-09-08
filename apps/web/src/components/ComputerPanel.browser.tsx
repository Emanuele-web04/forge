import { ThreadId, type ThreadComputerState } from "@synara/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ComputerPanel from "./ComputerPanel";
import { COMPUTER_DOUBLE_CLICK_WAIT_MS } from "./computer/computerClickDispatch";

const fixture = vi.hoisted(() => ({
  inputClick: vi.fn(),
  inputScroll: vi.fn(),
  state: undefined as ThreadComputerState | undefined,
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    computer: { inputClick: fixture.inputClick, inputScroll: fixture.inputScroll },
  }),
}));
vi.mock("~/hooks/useThreadComputerStateSeed", () => ({ useThreadComputerStateSeed: () => {} }));
vi.mock("~/hooks/useProvisionComputer", () => ({
  useProvisionComputer: () => ({ isPending: false, provision: () => {} }),
}));
vi.mock("~/hooks/useComputerDesktopControl", () => ({
  useComputerDesktopControl: () => ({
    agentActive: false,
    visibleDesktop: false,
    stopRequested: false,
  }),
}));
vi.mock("./computer/useComputerImageStream", () => ({
  useComputerImageStream: () => ({
    status: { kind: "streaming" },
    dimensions: { width: 100, height: 100 },
  }),
}));
vi.mock("./DiffPanelShell", () => ({
  DiffPanelShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock("../computerStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../computerStateStore")>()),
  useComputerStateStore: (selector: (state: unknown) => unknown) =>
    selector({
      threadStatesByThreadId: fixture.state ? { [fixture.state.threadId]: fixture.state } : {},
      lastActionByThreadId: {},
    }),
}));

const threadId = ThreadId.makeUnsafe("click-fixture");
function panel(id = threadId) {
  return (
    <ComputerPanel
      mode="inline"
      threadId={id}
      runtimeMode="live"
      isVisible
      onClosePanel={() => {}}
    />
  );
}

function click(canvas: HTMLCanvasElement, detail: number) {
  const event = new MouseEvent("click", { bubbles: true, detail });
  Object.defineProperties(event, { offsetX: { value: 10 }, offsetY: { value: 20 } });
  canvas.dispatchEvent(event);
}

const afterPairingWindow = () =>
  new Promise((resolve) => setTimeout(resolve, COMPUTER_DOUBLE_CLICK_WAIT_MS + 30));

beforeEach(() => {
  fixture.inputClick.mockReset().mockResolvedValue({
    ok: true,
    delivery: { path: "test", verified: "unverifiable", effect: "dispatched-unknown" },
  });
  fixture.inputScroll.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  fixture.state = {
    threadId,
    version: 1,
    computerId: "test-desktop",
    windows: [],
    screenSize: { width: 100, height: 100 },
    agentActive: false,
    controlledByOtherThread: false,
    availability: { kind: "available" },
    lastError: null,
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: false,
    },
  };
});
afterEach(() => vi.restoreAllMocks());

it("sends one atomic double from real pane handlers without a trailing third click", async () => {
  const screen = await render(panel());
  await screen.getByRole("button", { name: "Control the desktop", exact: true }).click();
  const canvas = document.querySelector("canvas")!;
  click(canvas, 1);
  click(canvas, 2);
  await expect.poll(() => fixture.inputClick.mock.calls.length).toBe(1);
  expect(fixture.inputClick).toHaveBeenCalledWith({ x: 10, y: 20, clickCount: 2 });
  await afterPairingWindow();
  expect(fixture.inputClick).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

it("discards a waiting click when manual control stops and when the pane unmounts", async () => {
  const screen = await render(panel());
  await screen.getByRole("button", { name: "Control the desktop", exact: true }).click();
  click(document.querySelector("canvas")!, 1);
  await screen.getByRole("button", { name: "Stop controlling the desktop", exact: true }).click();
  await afterPairingWindow();
  expect(fixture.inputClick).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Control the desktop", exact: true }).click();
  click(document.querySelector("canvas")!, 1);
  await screen.unmount();
  await afterPairingWindow();
  expect(fixture.inputClick).not.toHaveBeenCalled();
});

it("discards a waiting click when navigation changes the thread", async () => {
  const screen = await render(panel());
  await screen.getByRole("button", { name: "Control the desktop", exact: true }).click();
  click(document.querySelector("canvas")!, 1);
  await screen.rerender(panel(ThreadId.makeUnsafe("next-thread")));
  await afterPairingWindow();
  expect(fixture.inputClick).not.toHaveBeenCalled();
  await screen.unmount();
});

it("discards pending clicks and wheel batches immediately when the document hides", async () => {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const screen = await render(panel());
  await screen.getByRole("button", { name: "Control the desktop", exact: true }).click();
  const canvas = document.querySelector("canvas")!;
  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
  Object.defineProperties(wheel, { offsetX: { value: 10 }, offsetY: { value: 20 } });
  canvas.dispatchEvent(wheel);
  click(canvas, 1);
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await afterPairingWindow();
  expect(fixture.inputClick).not.toHaveBeenCalled();
  expect(fixture.inputScroll).not.toHaveBeenCalled();
  await screen.unmount();
});
