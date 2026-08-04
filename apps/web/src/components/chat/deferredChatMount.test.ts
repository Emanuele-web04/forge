import { describe, expect, it, vi } from "vitest";

import {
  DEFERRED_CHAT_MOUNT_FALLBACK_MS,
  type DeferredChatMountScheduler,
  scheduleDeferredChatMount,
} from "./deferredChatMount";

function createScheduler() {
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  const timeoutCallbacks = new Map<number, () => void>();
  const timeoutDelays = new Map<number, number>();
  let nextHandle = 1;

  const scheduler: DeferredChatMountScheduler = {
    requestAnimationFrame(callback) {
      const handle = nextHandle++;
      frameCallbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      frameCallbacks.delete(handle);
    },
    setTimeout(callback, delayMs) {
      const handle = nextHandle++;
      timeoutCallbacks.set(handle, callback);
      timeoutDelays.set(handle, delayMs);
      return handle;
    },
    clearTimeout(handle) {
      timeoutCallbacks.delete(handle);
      timeoutDelays.delete(handle);
    },
  };

  return { scheduler, frameCallbacks, timeoutCallbacks, timeoutDelays };
}

describe("scheduleDeferredChatMount", () => {
  it("falls back after the bounded delay when animation frames do not run", () => {
    const state = createScheduler();
    const onReady = vi.fn();

    scheduleDeferredChatMount(state.scheduler, onReady);

    expect([...state.timeoutDelays.values()]).toEqual([DEFERRED_CHAT_MOUNT_FALLBACK_MS]);
    [...state.timeoutCallbacks.values()][0]?.();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("mounts after two animation frames and cancels the fallback", () => {
    const state = createScheduler();
    const onReady = vi.fn();

    scheduleDeferredChatMount(state.scheduler, onReady);

    const firstFrame = [...state.frameCallbacks.entries()][0];
    expect(firstFrame).toBeDefined();
    state.frameCallbacks.delete(firstFrame![0]);
    firstFrame![1](0);

    const secondFrame = [...state.frameCallbacks.entries()][0];
    expect(secondFrame).toBeDefined();
    state.frameCallbacks.delete(secondFrame![0]);
    secondFrame![1](16);

    expect(onReady).toHaveBeenCalledOnce();
    expect(state.timeoutCallbacks.size).toBe(0);
  });

  it("prevents pending frame and timer callbacks from committing after cleanup", () => {
    const state = createScheduler();
    const onReady = vi.fn();

    const cleanup = scheduleDeferredChatMount(state.scheduler, onReady);
    const pendingTimeout = [...state.timeoutCallbacks.values()][0];
    const pendingFrame = [...state.frameCallbacks.values()][0];

    cleanup();
    pendingTimeout?.();
    pendingFrame?.(0);

    expect(onReady).not.toHaveBeenCalled();
    expect(state.timeoutCallbacks.size).toBe(0);
    expect(state.frameCallbacks.size).toBe(0);
  });
});
