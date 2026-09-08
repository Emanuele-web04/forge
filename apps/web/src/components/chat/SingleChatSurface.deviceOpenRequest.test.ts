import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { routeSingleDevicePaneOpenRequest } from "./devicePaneOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleDevicePaneOpenRequest", () => {
  it("opens the current thread pane immediately without navigating", () => {
    const calls: string[] = [];

    routeSingleDevicePaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateDeviceHydration: () => calls.push("hydrate"),
      openDevicePane: (threadId) => calls.push(`open:${threadId}`),
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
  });

  it("remembers a background thread's pane without hydrating or navigating away", () => {
    const calls: string[] = [];

    routeSingleDevicePaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateDeviceHydration: () => calls.push("hydrate"),
      openDevicePane: (threadId) => calls.push(`open:${threadId}`),
    });

    expect(calls).toEqual([`open:${REQUESTED_THREAD_ID}`]);
  });
});
