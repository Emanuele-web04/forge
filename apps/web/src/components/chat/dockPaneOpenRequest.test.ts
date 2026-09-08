import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { routeSingleDockPaneOpenRequest } from "./dockPaneOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleDockPaneOpenRequest", () => {
  it("opens the current thread pane immediately", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
  });

  it("hydrates before opening so an agent request never waits on a suspended frame", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: () => calls.push("open"),
    });

    expect(calls[0]).toBe("hydrate");
  });

  it("remembers a background thread's pane without hydrating or navigating away", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
    });

    expect(calls).toEqual([`open:${REQUESTED_THREAD_ID}`]);
  });
});
