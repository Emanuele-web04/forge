export const SIDECHAT_INACTIVITY_EXPIRY_MS = 3_600_000;
export const SIDECHAT_VISIBLE_ACTIVITY_HEARTBEAT_MS = 5 * 60 * 1_000;

export interface SidechatExpiryTimerClock<TimerHandle> {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel: (handle: TimerHandle) => void;
}

export interface SidechatExpiryTimerOptions<
  TimerHandle,
> extends SidechatExpiryTimerClock<TimerHandle> {
  readonly expiryMs?: number;
  readonly onExpire: (threadId: string, expectedLastActivityAtMs: number) => void;
}

export interface RestoredSidechatExpiryState {
  readonly threadId: string;
  readonly lastActivityAtMs: number;
  readonly running: boolean;
  readonly expired: boolean;
}

interface SidechatExpiryState<TimerHandle> {
  lastActivityAtMs: number;
  running: boolean;
  viewerCount: number;
  expiryPending: boolean;
  timer: TimerHandle | null;
}

export interface SidechatExpiryTimer {
  readonly restore: (state: RestoredSidechatExpiryState) => void;
  readonly beginView: (threadId: string, activityAtMs?: number) => boolean;
  readonly endView: (threadId: string, activityAtMs?: number) => boolean;
  readonly recordActivity: (threadId: string, activityAtMs?: number) => boolean;
  readonly setRunning: (threadId: string, running: boolean, activityAtMs?: number) => boolean;
  readonly markExpired: (threadId: string) => void;
  readonly retryExpiry: (threadId: string, delayMs?: number) => void;
  readonly remove: (threadId: string) => void;
  readonly getViewedThreadIds: () => readonly string[];
  readonly dispose: () => void;
}

export function createSidechatExpiryTimer<TimerHandle>(
  options: SidechatExpiryTimerOptions<TimerHandle>,
): SidechatExpiryTimer {
  const expiryMs = options.expiryMs ?? SIDECHAT_INACTIVITY_EXPIRY_MS;
  const states = new Map<string, SidechatExpiryState<TimerHandle>>();

  const clearTimer = (state: SidechatExpiryState<TimerHandle>) => {
    if (state.timer === null) return;
    options.cancel(state.timer);
    state.timer = null;
  };

  const scheduleExpiry = (threadId: string, state: SidechatExpiryState<TimerHandle>) => {
    clearTimer(state);
    if (state.running || state.viewerCount > 0 || state.expiryPending) return;

    const remainingMs = Math.max(0, state.lastActivityAtMs + expiryMs - options.now());
    state.timer = options.schedule(() => {
      state.timer = null;
      if (state.running || state.viewerCount > 0 || state.expiryPending) return;
      const remainingAtFireMs = state.lastActivityAtMs + expiryMs - options.now();
      if (remainingAtFireMs > 0) {
        scheduleExpiry(threadId, state);
        return;
      }
      state.expiryPending = true;
      options.onExpire(threadId, state.lastActivityAtMs);
    }, remainingMs);
  };

  const updateActivity = (
    threadId: string,
    state: SidechatExpiryState<TimerHandle>,
    activityAtMs: number,
  ) => {
    state.lastActivityAtMs = Math.max(state.lastActivityAtMs, activityAtMs);
    state.expiryPending = false;
    scheduleExpiry(threadId, state);
  };

  return {
    restore: (restored) => {
      const existing = states.get(restored.threadId);
      if (existing) clearTimer(existing);
      if (restored.expired) {
        states.delete(restored.threadId);
        return;
      }
      const state: SidechatExpiryState<TimerHandle> = {
        lastActivityAtMs: Math.max(
          restored.lastActivityAtMs,
          existing?.lastActivityAtMs ?? restored.lastActivityAtMs,
        ),
        running: restored.running,
        viewerCount: existing?.viewerCount ?? 0,
        expiryPending: false,
        timer: null,
      };
      states.set(restored.threadId, state);
      scheduleExpiry(restored.threadId, state);
    },
    beginView: (threadId, activityAtMs = options.now()) => {
      const state = states.get(threadId);
      if (!state) return false;
      state.viewerCount += 1;
      updateActivity(threadId, state, activityAtMs);
      return true;
    },
    endView: (threadId, activityAtMs = options.now()) => {
      const state = states.get(threadId);
      if (!state) return false;
      state.viewerCount = Math.max(0, state.viewerCount - 1);
      updateActivity(threadId, state, activityAtMs);
      return true;
    },
    recordActivity: (threadId, activityAtMs = options.now()) => {
      const state = states.get(threadId);
      if (!state) return false;
      updateActivity(threadId, state, activityAtMs);
      return true;
    },
    setRunning: (threadId, running, activityAtMs = options.now()) => {
      const state = states.get(threadId);
      if (!state) return false;
      state.running = running;
      updateActivity(threadId, state, activityAtMs);
      return true;
    },
    markExpired: (threadId) => {
      const state = states.get(threadId);
      if (state) clearTimer(state);
      states.delete(threadId);
    },
    retryExpiry: (threadId, delayMs = 0) => {
      const state = states.get(threadId);
      if (!state) return;
      state.expiryPending = false;
      if (delayMs <= 0) {
        scheduleExpiry(threadId, state);
        return;
      }
      clearTimer(state);
      state.timer = options.schedule(() => {
        state.timer = null;
        scheduleExpiry(threadId, state);
      }, delayMs);
    },
    remove: (threadId) => {
      const state = states.get(threadId);
      if (state) clearTimer(state);
      states.delete(threadId);
    },
    getViewedThreadIds: () =>
      [...states.entries()].flatMap(([threadId, state]) =>
        state.viewerCount > 0 ? [threadId] : [],
      ),
    dispose: () => {
      for (const state of states.values()) clearTimer(state);
      states.clear();
    },
  };
}
