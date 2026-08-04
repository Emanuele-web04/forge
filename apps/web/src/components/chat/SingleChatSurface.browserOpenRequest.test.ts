import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { routeSingleBrowserPanelOpenRequest } from "./browserPanelOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleBrowserPanelOpenRequest", () => {
  it("opens the current thread browser immediately without navigating", () => {
    const calls: string[] = [];

    routeSingleBrowserPanelOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateBrowserHydration: () => calls.push("hydrate"),
      openBrowserPane: (threadId) => calls.push(`open:${threadId}`),
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
  });

  it("leaves the current chat untouched for a background thread request", () => {
    const calls: string[] = [];

    routeSingleBrowserPanelOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateBrowserHydration: () => calls.push("hydrate"),
      openBrowserPane: (threadId) => calls.push(`open:${threadId}`),
    });

    expect(calls).toEqual([]);
  });
});
