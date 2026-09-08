import { ThreadId, type ThreadComputerState } from "@synara/contracts";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useComputerStateStore, useThreadComputerAvailability } from "../computerStateStore";

const threadId = ThreadId.makeUnsafe("availability-test");
const initial: ThreadComputerState = {
  threadId,
  version: 1,
  computerId: "desktop",
  windows: [],
  screenSize: { width: 1920, height: 1080 },
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
    visibleDesktop: true,
  },
};

afterEach(() => useComputerStateStore.getState().clear());

it("does not render the composer subscription for activity and geometry updates", async () => {
  let renders = 0;
  function Probe() {
    const availability = useThreadComputerAvailability(threadId);
    renders += 1;
    return <span>{availability?.kind}</span>;
  }
  useComputerStateStore.getState().upsertThreadState(initial);
  const screen = await render(<Probe />);
  const baseline = renders;
  for (let version = 2; version < 10; version++) {
    useComputerStateStore
      .getState()
      .upsertThreadState({
        ...initial,
        version,
        availability: { kind: "available" },
        agentActive: true,
        cursor: { x: version, y: version },
      });
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(renders).toBe(baseline);
  useComputerStateStore
    .getState()
    .upsertThreadState({
      ...initial,
      version: 10,
      availability: { kind: "backend-unavailable", message: "Disconnected" },
    });
  await expect.element(screen.getByText("backend-unavailable")).toBeVisible();
  expect(renders).toBeGreaterThan(baseline);
  await screen.unmount();
});
