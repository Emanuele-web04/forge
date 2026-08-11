import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { routeSingleDevicePaneOpenRequest } from "./devicePaneOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleDevicePaneOpenRequest", () => {
  it("opens the current thread pane immediately without navigating", () => {
    const calls: string[] = [];
    const navigateToThread = vi.fn();

    routeSingleDevicePaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateDeviceHydration: () => calls.push("hydrate"),
      openDevicePane: (threadId) => calls.push(`open:${threadId}`),
      navigateToThread,
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("seeds the requested thread's dock before navigating to it", () => {
    const calls: string[] = [];

    routeSingleDevicePaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateDeviceHydration: () => calls.push("hydrate"),
      openDevicePane: (threadId) => calls.push(`open:${threadId}`),
      navigateToThread: (threadId) => calls.push(`navigate:${threadId}`),
    });

    expect(calls).toEqual([
      "hydrate",
      `open:${REQUESTED_THREAD_ID}`,
      `navigate:${REQUESTED_THREAD_ID}`,
    ]);
  });

  it("hydrates before opening so an agent request never waits on a suspended frame", () => {
    const calls: string[] = [];

    routeSingleDevicePaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateDeviceHydration: () => calls.push("hydrate"),
      openDevicePane: () => calls.push("open"),
      navigateToThread: () => calls.push("navigate"),
    });

    expect(calls[0]).toBe("hydrate");
  });
});
