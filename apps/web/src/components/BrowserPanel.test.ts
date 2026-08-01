// FILE: BrowserPanel.test.ts
// Purpose: Guards the browser profile query keys shared across thread panels.
// Layer: BrowserPanel unit tests

import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { browserProfileStateQueryKeys } from "./BrowserPanel";

describe("browserProfileStateQueryKeys", () => {
  it("keeps thread keys under the shared prefix so mutations invalidate every panel", () => {
    const threadKey = browserProfileStateQueryKeys.thread(ThreadId.makeUnsafe("thread-a"));

    expect(threadKey.slice(0, browserProfileStateQueryKeys.all.length)).toEqual([
      ...browserProfileStateQueryKeys.all,
    ]);
    expect(threadKey).not.toEqual(
      browserProfileStateQueryKeys.thread(ThreadId.makeUnsafe("thread-b")),
    );
  });
});
