// FILE: missingThreadRecovery.ts
// Purpose: Bounded retry coordinator for projects-present / threads-empty hydration.
// Layer: Client recovery

import type { ShellRefreshResult } from "./shellRefreshCoordinator";

export const MISSING_THREAD_RECOVERY_MAX_ATTEMPTS = 3;
export const MISSING_THREAD_RECOVERY_BACKOFF_MS = [0, 1_500, 3_000] as const;

export type MissingThreadRecoveryAttemptInfo = {
  attempt: number;
  result: ShellRefreshResult | null;
};

export type MissingThreadRecoveryController = {
  start: () => void;
  cancel: () => void;
};

export function createMissingThreadRecoveryController(input: {
  isStillNeeded: () => boolean;
  refresh: () => Promise<ShellRefreshResult>;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearSchedule?: (id: ReturnType<typeof setTimeout>) => void;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  onAttempt?: (info: MissingThreadRecoveryAttemptInfo) => void;
}): MissingThreadRecoveryController {
  const maxAttempts = input.maxAttempts ?? MISSING_THREAD_RECOVERY_MAX_ATTEMPTS;
  const backoffMs = input.backoffMs ?? MISSING_THREAD_RECOVERY_BACKOFF_MS;
  const schedule = input.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clearSchedule = input.clearSchedule ?? ((id) => clearTimeout(id));

  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const clearTimer = () => {
    if (timer != null) {
      clearSchedule(timer);
      timer = null;
    }
  };

  const run = async () => {
    if (cancelled || !input.isStillNeeded()) {
      return;
    }
    if (attempt >= maxAttempts) {
      return;
    }

    attempt += 1;
    input.onAttempt?.({ attempt, result: null });

    let result: ShellRefreshResult;
    try {
      result = await input.refresh();
    } catch {
      result = {
        applied: false,
        shellThreadCount: 0,
        reason: "error",
      };
    }

    if (cancelled) {
      return;
    }

    input.onAttempt?.({ attempt, result });

    if (result.applied || !input.isStillNeeded()) {
      return;
    }

    if (attempt >= maxAttempts) {
      return;
    }

    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 3_000;
    timer = schedule(() => {
      timer = null;
      void run();
    }, delay);
  };

  return {
    start: () => {
      if (started || cancelled) {
        return;
      }
      started = true;
      void run();
    },
    cancel: () => {
      cancelled = true;
      clearTimer();
    },
  };
}
