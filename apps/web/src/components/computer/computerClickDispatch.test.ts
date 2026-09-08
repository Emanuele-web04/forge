import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPUTER_DOUBLE_CLICK_WAIT_MS,
  createComputerClickDispatch,
  type ComputerClickCommand,
} from "./computerClickDispatch";
import { createComputerInputQueue } from "./computerInputQueue";

describe("computer click dispatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a possible pair before dispatching exactly one single click", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    clicks.click({ x: 10, y: 20 }, 1);

    vi.advanceTimersByTime(COMPUTER_DOUBLE_CLICK_WAIT_MS - 1);
    expect(dispatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dispatch.mock.calls).toEqual([[{ x: 10, y: 20, clickCount: 1 }]]);
    vi.runAllTimers();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches a DOM double click as one atomic command with no trailing click", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    clicks.click({ x: 10, y: 20 }, 1);
    vi.advanceTimersByTime(100);
    clicks.click({ x: 11, y: 20 }, 2);

    expect(dispatch.mock.calls).toEqual([[{ x: 11, y: 20, clickCount: 2 }]]);
    vi.runAllTimers();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves an atomic double behind a slow in-flight RPC", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createComputerInputQueue();
    const sent: ComputerClickCommand[] = [];
    queue.push(() => gate);
    await Promise.resolve();
    const clicks = createComputerClickDispatch({
      dispatch: (command) => {
        queue.push(async () => {
          sent.push(command);
        });
      },
    });

    clicks.click({ x: 10, y: 20 }, 1);
    vi.advanceTimersByTime(100);
    clicks.click({ x: 10, y: 20 }, 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ x: 10, y: 20, clickCount: 2 }]);
    expect(queue.pending()).toBe(0);
  });

  it("dispatches clicks at disjoint points in browser sequence order", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    clicks.click({ x: 10, y: 20 }, 1);
    clicks.click({ x: 90, y: 80 }, 1);
    expect(dispatch.mock.calls).toEqual([[{ x: 10, y: 20, clickCount: 1 }]]);
    vi.runAllTimers();
    expect(dispatch.mock.calls).toEqual([
      [{ x: 10, y: 20, clickCount: 1 }],
      [{ x: 90, y: 80, clickCount: 1 }],
    ]);
  });

  it("represents a triple click as one double followed by one single", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    const point = { x: 10, y: 20 };
    clicks.click(point, 1);
    clicks.click(point, 2);
    clicks.click(point, 3);
    vi.runAllTimers();
    expect(dispatch.mock.calls).toEqual([
      [{ ...point, clickCount: 2 }],
      [{ ...point, clickCount: 1 }],
    ]);
  });

  it("pairs consecutive browser clicks beyond the first double", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    const point = { x: 10, y: 20 };
    for (const detail of [1, 2, 3, 4]) clicks.click(point, detail);
    vi.runAllTimers();
    expect(dispatch.mock.calls).toEqual([
      [{ ...point, clickCount: 2 }],
      [{ ...point, clickCount: 2 }],
    ]);
  });

  it("never upgrades an already committed first click into three native clicks", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    const point = { x: 10, y: 20 };
    clicks.click(point, 1);
    vi.runAllTimers();
    clicks.click(point, 2);
    vi.runAllTimers();
    expect(dispatch.mock.calls).toEqual([
      [{ ...point, clickCount: 1 }],
      [{ ...point, clickCount: 1 }],
    ]);
  });

  it("flushes a pending click before another kind of input without replaying it", () => {
    const sent: Array<ComputerClickCommand | string> = [];
    const clicks = createComputerClickDispatch({ dispatch: (command) => sent.push(command) });
    clicks.click({ x: 10, y: 20 }, 1);
    clicks.flush();
    sent.push("keyboard");
    clicks.flush();
    vi.runAllTimers();
    expect(sent).toEqual([{ x: 10, y: 20, clickCount: 1 }, "keyboard"]);
  });

  it("discards pending clicks on cancellation and allows a fresh control session", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    clicks.click({ x: 10, y: 20 }, 1);
    clicks.cancel();
    vi.runAllTimers();
    clicks.flush();
    expect(dispatch).not.toHaveBeenCalled();

    clicks.click({ x: 30, y: 40 }, 1);
    vi.runAllTimers();
    expect(dispatch.mock.calls).toEqual([[{ x: 30, y: 40, clickCount: 1 }]]);
  });

  it("dispatches an accessibility click immediately after any preceding pointer click", () => {
    const dispatch = vi.fn();
    const clicks = createComputerClickDispatch({ dispatch });
    clicks.click({ x: 10, y: 20 }, 1);
    clicks.click({ x: 30, y: 40 }, 0);
    vi.runAllTimers();
    expect(dispatch.mock.calls).toEqual([
      [{ x: 10, y: 20, clickCount: 1 }],
      [{ x: 30, y: 40, clickCount: 1 }],
    ]);
  });
});
