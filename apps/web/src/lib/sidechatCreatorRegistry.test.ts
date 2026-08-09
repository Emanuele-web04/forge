import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@synara/contracts";

import { registerSidechatCreator, waitForSidechatCreator } from "./sidechatCreatorRegistry";

const THREAD_ID = ThreadId.makeUnsafe("thread-sidechat-host");

describe("waitForSidechatCreator", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("waits for the compositor registration that follows a dock mount", async () => {
    const pendingCreator = waitForSidechatCreator(THREAD_ID);
    const creator = vi.fn().mockResolvedValue(true);
    const unregister = registerSidechatCreator(THREAD_ID, creator);

    expect(await pendingCreator).toBe(creator);
    unregister();
  });

  it("returns undefined after its bounded wait when no creator can register", async () => {
    vi.useFakeTimers();
    const pendingCreator = waitForSidechatCreator(THREAD_ID, 500);
    await vi.advanceTimersByTimeAsync(500);

    expect(await pendingCreator).toBeUndefined();
  });
});
