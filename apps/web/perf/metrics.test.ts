import { describe, expect, it, vi } from "vitest";

import { createFrameCollector } from "./metrics";

describe("createFrameCollector", () => {
  it("invalidates a pending callback before a new run starts", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    });
    const cancelFrame = vi.fn((id: number) => {
      callbacks.delete(id);
    });
    const collector = createFrameCollector({ requestFrame, cancelFrame });

    collector.start();
    callbacks.get(1)?.(10);
    const staleCallback = callbacks.get(2);
    collector.stop();
    collector.start();

    staleCallback?.(20);
    callbacks.get(3)?.(30);
    callbacks.get(4)?.(46);

    expect(requestFrame).toHaveBeenCalledTimes(5);
    expect(collector.stop()).toEqual([16]);
  });
});
