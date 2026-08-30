import { describe, expect, it, vi } from "vitest";

import { SIDECHAT_INACTIVITY_EXPIRY_MS, createSidechatExpiryTimer } from "./sidechatExpiry";

function makeClock(startAtMs = 0) {
  let nowMs = startAtMs;
  let nextTimerId = 1;
  const timers = new Map<number, { readonly callback: () => void; readonly dueAtMs: number }>();

  const advanceTo = (targetMs: number) => {
    nowMs = targetMs;
    while (true) {
      const dueTimer = [...timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= nowMs)
        .toSorted((left, right) => left[1].dueAtMs - right[1].dueAtMs)[0];
      if (!dueTimer) return;
      timers.delete(dueTimer[0]);
      dueTimer[1].callback();
    }
  };

  return {
    now: () => nowMs,
    schedule: (callback: () => void, delayMs: number) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, dueAtMs: nowMs + delayMs });
      return timerId;
    },
    cancel: (timerId: number) => {
      timers.delete(timerId);
    },
    advanceTo,
  };
}

describe("sidechat expiry timer", () => {
  it("expires an idle sidechat after one hour", () => {
    const clock = makeClock(1_000);
    const onExpire = vi.fn();
    const timer = createSidechatExpiryTimer({ ...clock, onExpire });

    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 1_000,
      running: false,
      expired: false,
    });
    clock.advanceTo(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();

    clock.advanceTo(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS);
    expect(onExpire).toHaveBeenCalledWith("sidechat-1", 1_000);
  });

  it("does not expire while viewed and restarts from the close time", () => {
    const clock = makeClock(1_000);
    const onExpire = vi.fn();
    const timer = createSidechatExpiryTimer({ ...clock, onExpire });
    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 1_000,
      running: false,
      expired: false,
    });

    clock.advanceTo(2_000);
    expect(timer.beginView("sidechat-1")).toBe(true);
    clock.advanceTo(2_000 + SIDECHAT_INACTIVITY_EXPIRY_MS);
    expect(onExpire).not.toHaveBeenCalled();

    timer.endView("sidechat-1");
    clock.advanceTo(2_000 + SIDECHAT_INACTIVITY_EXPIRY_MS * 2 - 1);
    expect(onExpire).not.toHaveBeenCalled();
    clock.advanceTo(2_000 + SIDECHAT_INACTIVITY_EXPIRY_MS * 2);
    expect(onExpire).toHaveBeenCalledWith("sidechat-1", 2_000 + SIDECHAT_INACTIVITY_EXPIRY_MS);
  });

  it("defers expiry until a running turn settles", () => {
    const clock = makeClock(1_000);
    const onExpire = vi.fn();
    const timer = createSidechatExpiryTimer({ ...clock, onExpire });
    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 1_000,
      running: true,
      expired: false,
    });

    clock.advanceTo(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();

    timer.setRunning("sidechat-1", false);
    clock.advanceTo(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS * 3 - 1);
    expect(onExpire).not.toHaveBeenCalled();
    clock.advanceTo(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS * 3);
    expect(onExpire).toHaveBeenCalledWith("sidechat-1", 1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS * 2);
  });

  it("expires immediately when restored past its durable deadline", () => {
    const clock = makeClock(SIDECHAT_INACTIVITY_EXPIRY_MS + 1);
    const onExpire = vi.fn();
    const timer = createSidechatExpiryTimer({ ...clock, onExpire });

    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 0,
      running: false,
      expired: false,
    });
    clock.advanceTo(clock.now());

    expect(onExpire).toHaveBeenCalledWith("sidechat-1", 0);
  });

  it("preserves an already-acquired view when a committed create event is replayed", () => {
    const clock = makeClock(1_000);
    const onExpire = vi.fn();
    const timer = createSidechatExpiryTimer({ ...clock, onExpire });
    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 1_000,
      running: false,
      expired: false,
    });
    timer.beginView("sidechat-1");

    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 1_000,
      running: false,
      expired: false,
    });
    clock.advanceTo(1_000 + SIDECHAT_INACTIVITY_EXPIRY_MS);

    expect(onExpire).not.toHaveBeenCalled();
  });

  it("backs off a rejected expiry instead of spinning at an elapsed deadline", () => {
    const now = SIDECHAT_INACTIVITY_EXPIRY_MS + 1;
    const clock = makeClock(now);
    const onExpire = vi.fn();
    const timer = createSidechatExpiryTimer({ ...clock, onExpire });
    timer.restore({
      threadId: "sidechat-1",
      lastActivityAtMs: 0,
      running: false,
      expired: false,
    });
    clock.advanceTo(now);
    expect(onExpire).toHaveBeenCalledTimes(1);

    timer.retryExpiry("sidechat-1", 5_000);
    clock.advanceTo(now + 4_999);
    expect(onExpire).toHaveBeenCalledTimes(1);
    clock.advanceTo(now + 5_000);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });
});
